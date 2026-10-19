import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from 'cordis'
import { UserDatabase } from './db.ts'
import { UserError } from './errors.ts'
import {
  BALANCE_MINOR_UNITS_PER_YUAN,
  USER_AVATAR_DATA_MAX_BYTES,
  USER_AVATAR_URL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  type Balance,
  type BalanceEntry,
  type User,
  type UserChangedAction,
  type UserChangedField,
  type UserId,
  type UserProfilePatch,
  type UserQuery,
  type UserRole,
  type UserStatus,
} from './model.ts'
import { USER_CONFIG_SCHEMA, type ResolvedUserConfig } from './schema.ts'

export interface CreateUserInput {
  readonly name: string
  /**
   * 仅供迁移 / 测试指定角色。正常调用不要用它绕过「首个用户自动 admin」的规则；
   * 省略时由本服务按当前用户数决定。
   */
  readonly role?: UserRole
}

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1000

/** data:image/* 的 base64 负载上限（解码前先按编码长度粗筛，避免对超大字符串做正则）。 */
const MAX_AVATAR_DATA_URL_LENGTH =
  Math.ceil(USER_AVATAR_DATA_MAX_BYTES / 3) * 4 + 128

const AVATAR_DATA_URL =
  /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i

/**
 * 用户插件。三个接口面，边界清楚：
 *
 * 1. **管理面**（create / rename / setStatus / setRole / setBalanceEnabled / remove）：
 *    只对 `adminPlugins` 里列出的插件开放，默认拒绝。这就是「指定插件（管理员管理插件）
 *    改用户表单」。
 * 2. **自助资料面**（updateProfile）：只改用户名与头像。它不做 actor 白名单——
 *    HTTP 层已经用会话确认了「这是谁」；能调到这里就意味着身份已经定了。
 * 3. **余额面**（getBalance / adjustBalance / listBalanceEntries）：供其他插件读取与
 *    改动余额，默认不限制消费者，可用 `balanceWriters` 收窄。
 *
 * 另有只读的 get / list，任何插件可用。
 *
 * 写者唯一（AGENTS.md D8）：所有改动都经由本服务，外部拿到的是副本。
 * 所有改动串行执行（同一条队列）。存储是 SQLite（`node:sqlite` 的 DatabaseSync），
 * 单次改动在一个 `BEGIN IMMEDIATE` 事务里完成；事务里不 await 任何异步服务。
 * 这是控制面流量，量小，串行没有代价——LLM 请求路径不经过本服务。
 *
 * 注意：这里的成员**不能**用 `#` 私有字段。cordis 会以 Proxy 作为 receiver 调用服务
 * 方法，而 `#` 字段有 brand check，在 Proxy 上会抛
 * “Receiver must be an instance of class”。用 TS 的 `private` 才是对的。
 */
export class UserService extends Service {
  static Config = USER_CONFIG_SCHEMA

  /** 能力清单：目录可见的部分。用户插件不暴露桥命令。 */
  static catalog = {
    capabilities: ['users', 'balances', 'user-profile', 'roles', 'balance-toggle'],
    events: [
      {
        name: 'user/changed',
        description: '用户写入成功后发出；通知性质，不承载正确性',
        payload:
          "{ userId: number, action: 'created' | 'updated' | 'removed', fields?: string[] }",
      },
    ],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: '用户与余额流水 SQLite' }],
    shapes: {
      User: {
        description: '用户公开资料与余额；不含任何凭据或密码字段',
        fields: {
          id: { type: 'integer' },
          name: { type: 'string' },
          status: { type: 'enabled | banned' },
          role: { type: 'admin | user' },
          balance: { type: 'bigint（最小单位，1 元 = 1000000）' },
          balanceEnabled: { type: 'boolean' },
          avatar: { type: 'string | null', description: 'http(s) URL 或受限 data:image base64' },
          createdAt: { type: 'string（ISO 8601）' },
          updatedAt: { type: 'string（ISO 8601）' },
        },
      },
      UserProfilePatch: {
        description: '自助资料补丁；只允许 name / avatar 两个字段',
        fields: {
          name: { type: 'string', optional: true },
          avatar: { type: 'string | null', optional: true },
        },
      },
    },
  } as const

  readonly config: ResolvedUserConfig
  private db: UserDatabase
  private adminPlugins: readonly string[]
  private balanceWriters: readonly string[] | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ResolvedUserConfig = {}) {
    super(ctx, 'user')
    this.config = config
    this.adminPlugins = config.adminPlugins ?? []
    this.balanceWriters = config.balanceWriters
    this.db = new UserDatabase(resolveDataPath(ctx, config.dataPath))

    const logger = ctx.logger('user')
    logger.info(
      `用户插件已装载：存储 ${this.db.describe}；用户表单写者 ${this.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (this.db.legacyImport !== undefined) {
      logger.info(
        `已从旧 users.json 导入 ${this.db.legacyImport.users} 个用户、` +
          `${this.db.legacyImport.entries} 条余额流水（旧文件保留）`,
      )
    }
    if (this.adminPlugins.length === 0) {
      logger.warn('adminPlugins 为空：当前没有任何插件可以创建 / 禁用 / 删除用户或改用户名')
    }

    // 注册即副作用：插件被卸载时数据库连接跟着关闭（AGENTS.md D5）。
    ctx.effect(() => () => this.db.close(), 'user.db')
  }

  // ───────────────────────── 管理面：仅限被授权的插件 ─────────────────────────

  /**
   * 创建用户。ID 按注册顺序分配：从 1 开始，单调递增，删除后也不复用
   * （SQLite AUTOINCREMENT 保证）。
   *
   * 当前用户数为 0 时，新用户自动是 admin；之后注册的都是普通 user。
   * 新用户默认 enabled、余额 0、不显示余额、无头像；钱只经由 adjustBalance 变动。
   */
  async create(actor: string, input: CreateUserInput): Promise<User> {
    this.assertAdmin(actor)
    const name = normalizeName(input?.name)
    const requestedRole = input?.role === undefined ? undefined : normalizeRole(input.role)

    return this.exclusive(async () => {
      const user = this.db.transaction(() => {
        const role = requestedRole ?? (this.db.countUsers() === 0 ? 'admin' : 'user')
        const now = new Date().toISOString()
        return this.db.insertUser({
          name,
          status: 'enabled',
          role,
          balanceEnabled: false,
          avatar: null,
          createdAt: now,
          updatedAt: now,
        })
      })
      this.emitChanged(user.id, 'created')
      return user
    })
  }

  /** 改用户名。 */
  async rename(actor: string, id: UserId, name: string): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)
    const nextName = normalizeName(name)

    return this.exclusive(async () => {
      const user = this.db.transaction(() => {
        this.requireUser(userId)
        return this.db.updateUser(userId, {
          name: nextName,
          updatedAt: new Date().toISOString(),
        })
      })
      this.emitChanged(userId, 'updated', ['name'])
      return user
    })
  }

  /**
   * 封禁（banned）或启用（enabled）用户。删除是独立操作，不表达为状态。
   *
   * 不允许把最后一个**可用管理员**封禁：`role=admin` 但已经被 banned 的账号
   * 不构成管理入口，不能拿来兜底。
   */
  async setStatus(actor: string, id: UserId, status: UserStatus): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)
    const nextStatus = normalizeStatus(status)

    return this.exclusive(async () => {
      const user = this.db.transaction(() => {
        const current = this.requireUser(userId)
        if (
          current.role === 'admin' &&
          current.status === 'enabled' &&
          nextStatus === 'banned' &&
          this.db.countEnabledAdmins() <= 1
        ) {
          throw new UserError('USER_LAST_ADMIN', '不能封禁最后一个可用管理员')
        }
        return this.db.updateUser(userId, {
          status: nextStatus,
          updatedAt: new Date().toISOString(),
        })
      })
      this.emitChanged(userId, 'updated', ['status'])
      return user
    })
  }

  /**
   * 授予 / 撤销管理员角色。拒绝把最后一个**可用管理员**降级：
   * 否则管理台会失去唯一的入口，而且没有任何进程内办法恢复。
   * 被 banned 的 admin 不算可用管理员。
   */
  async setRole(actor: string, id: UserId, role: UserRole): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)
    const nextRole = normalizeRole(role)

    return this.exclusive(async () => {
      const user = this.db.transaction(() => {
        const current = this.requireUser(userId)
        if (
          current.role === 'admin' &&
          current.status === 'enabled' &&
          nextRole !== 'admin' &&
          this.db.countEnabledAdmins() <= 1
        ) {
          throw new UserError('USER_LAST_ADMIN', '不能撤销最后一个可用管理员的权限')
        }
        return this.db.updateUser(userId, {
          role: nextRole,
          updatedAt: new Date().toISOString(),
        })
      })
      this.emitChanged(userId, 'updated', ['role'])
      return user
    })
  }

  /** 打开 / 关闭该用户的余额显示。只改展示开关，不动余额数值。 */
  async setBalanceEnabled(actor: string, id: UserId, enabled: boolean): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)
    if (typeof enabled !== 'boolean') {
      throw new UserError('USER_BALANCE_ENABLED_INVALID', '余额显示开关必须是布尔值')
    }

    return this.exclusive(async () => {
      const user = this.db.transaction(() => {
        this.requireUser(userId)
        return this.db.updateUser(userId, {
          balanceEnabled: enabled,
          updatedAt: new Date().toISOString(),
        })
      })
      this.emitChanged(userId, 'updated', ['balanceEnabled'])
      return user
    })
  }

  /**
   * 删除用户。余额不为零时拒绝——先把钱结清，那会留下一笔流水，账才说得清。
   * 也不能删除最后一个**可用管理员**：删掉后管理台就没有入口了。
   * 用户被删掉后，他的余额流水仍然保留（只增不改的审计附本）。
   *
   * 顺序：先余额、后管理员。余额非零时给 `USER_BALANCE_NOT_ZERO`，
   * 这样调用方先处理钱的问题；两条都满足时给 `USER_LAST_ADMIN`。
   */
  async remove(actor: string, id: UserId): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)

    return this.exclusive(async () => {
      const user = this.db.transaction(() => {
        const current = this.requireUser(userId)
        if (current.balance !== 0n) {
          throw new UserError(
            'USER_BALANCE_NOT_ZERO',
            `用户 ${current.name}（#${current.id}）余额为 ${formatBalance(current.balance)}，先结清再删除`,
          )
        }
        if (
          current.role === 'admin' &&
          current.status === 'enabled' &&
          this.db.countEnabledAdmins() <= 1
        ) {
          throw new UserError('USER_LAST_ADMIN', '不能删除最后一个可用管理员')
        }
        this.db.deleteUser(userId)
        return { ...current }
      })
      this.emitChanged(userId, 'removed')
      return user
    })
  }

  // ───────────────────────── 自助资料：只改名字与头像 ─────────────────────────

  /**
   * 用户自助更新资料。**不做 actor 白名单**：HTTP 层已经用会话确认了身份，
   * 参数里也没有 userId，调用方只能改「当前登录用户」。
   *
   * 只允许 `name` 与 `avatar` 两个字段；其它键直接拒绝，避免悄悄多出可写字段。
   * `avatar: null` 表示清除；补丁为空对象时原样返回，不碰 updatedAt。
   */
  async updateProfile(id: UserId, patch: UserProfilePatch): Promise<User> {
    const userId = normalizeId(id)
    const normalized = normalizeProfilePatch(patch)

    const fields: UserChangedField[] = []
    if (normalized.name !== undefined) fields.push('name')
    if (normalized.avatar !== undefined) fields.push('avatar')

    return this.exclusive(async () => {
      if (fields.length === 0) {
        this.requireUser(userId)
        return this.requireUser(userId)
      }
      const user = this.db.transaction(() =>
        this.db.updateUser(userId, {
          ...(normalized.name === undefined ? {} : { name: normalized.name }),
          ...(normalized.avatar === undefined ? {} : { avatar: normalized.avatar }),
          updatedAt: new Date().toISOString(),
        }),
      )
      this.emitChanged(userId, 'updated', fields)
      return user
    })
  }

  // ───────────────────────────── 读：任何插件可用 ─────────────────────────────

  async get(id: UserId): Promise<User | undefined> {
    const userId = normalizeId(id)
    return this.exclusive(async () => this.db.getUser(userId))
  }

  async list(query: UserQuery = {}): Promise<User[]> {
    const status = query.status === undefined ? undefined : normalizeStatus(query.status)
    const role = query.role === undefined ? undefined : normalizeRole(query.role)
    const offset = normalizeCount(query.offset, 0, 'offset')
    const limit = normalizeCount(query.limit, DEFAULT_LIST_LIMIT, 'limit', MAX_LIST_LIMIT)

    return this.exclusive(async () => this.db.listUsers({ status, role, offset, limit }))
  }

  // ───────────────────────────── 余额面：供其他插件 ─────────────────────────────

  /** 读取余额。用户不存在直接报错，不返回 0——查不到和余额为零是两件事。 */
  async getBalance(id: UserId): Promise<Balance> {
    const userId = normalizeId(id)
    return this.exclusive(async () => {
      const balance = this.db.getBalance(userId)
      if (balance === undefined) {
        throw new UserError('USER_NOT_FOUND', `没有这个用户：#${userId}`)
      }
      return balance
    })
  }

  /**
   * 改余额：`delta` 为增量，负数即扣减。返回改动后的余额。
   *
   * 每一笔都必须给出非空 reason，并记录调用方插件名——余额变化必须可追溯。
   * 允许把余额扣成负数：后付费结算本来就可能超出余额（AGENTS.md D11）。
   */
  async adjustBalance(consumer: string, id: UserId, delta: Balance, reason: string): Promise<Balance> {
    this.assertBalanceWriter(consumer)
    const userId = normalizeId(id)
    const change = normalizeDelta(delta)
    const why = normalizeReason(reason)
    const actor = normalizeActor(consumer)

    return this.exclusive(async () => {
      const balance = this.db.adjustBalance(userId, change, why, actor, new Date().toISOString())
      this.emitChanged(userId, 'updated', ['balance'])
      return balance
    })
  }

  /** 读某用户的余额流水，返回最近 `limit` 条，按时间正序。 */
  async listBalanceEntries(id: UserId, limit = DEFAULT_LIST_LIMIT): Promise<BalanceEntry[]> {
    const userId = normalizeId(id)
    const take = normalizeCount(limit, DEFAULT_LIST_LIMIT, 'limit', MAX_LIST_LIMIT)

    return this.exclusive(async () => this.db.listBalanceEntries(userId, take))
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private assertAdmin(actor: string): void {
    const name = normalizeActor(actor)
    if (!this.adminPlugins.includes(name)) {
      throw new UserError(
        'USER_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权改动用户表单（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }

  private assertBalanceWriter(actor: string): void {
    const name = normalizeActor(actor)
    if (this.balanceWriters !== undefined && !this.balanceWriters.includes(name)) {
      throw new UserError(
        'USER_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权改动余额（当前授权：${this.balanceWriters.join(' / ') || '无'}）`,
      )
    }
  }

  /** 串行执行：同一时刻只有一次「读 → 改 → 写」在进行。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(noop, noop)
    return result
  }

  private requireUser(id: UserId): User {
    const user = this.db.getUser(id)
    if (user === undefined) {
      throw new UserError('USER_NOT_FOUND', `没有这个用户：#${id}`)
    }
    return user
  }

  /**
   * 写成功后的通知。**在事务提交之后、串行队列之内发出**，所以事件顺序与写顺序一致。
   * 载荷只有 userId / action / fields——不放名字、邮箱、余额数值或任何秘密。
   */
  private emitChanged(
    userId: UserId,
    action: UserChangedAction,
    fields?: readonly UserChangedField[],
  ): void {
    this.ctx.emit('user/changed', {
      userId,
      action,
      ...(fields === undefined || fields.length === 0 ? {} : { fields }),
    })
  }
}

function noop(): void {
  // 只用来把队列里失败的 promise 咽掉，避免污染下一次 task
}

/** 相对路径按 cordis 的 baseUrl 解析；`:memory:` 原样传给存储层。 */
function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === ':memory:' || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function normalizeActor(actor: string): string {
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw new UserError('USER_ACTOR_REQUIRED', '调用方必须声明自己的插件名')
  }
  return actor.trim()
}

function normalizeId(id: UserId): UserId {
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
    throw new UserError('USER_ID_INVALID', `非法用户 ID：${String(id)}`)
  }
  return id
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UserError('USER_NAME_INVALID', '用户名必须是字符串')
  }
  const name = value.trim()
  if (name === '') throw new UserError('USER_NAME_INVALID', '用户名不能为空')
  if (name.length > USER_NAME_MAX_LENGTH) {
    throw new UserError('USER_NAME_INVALID', `用户名最长 ${USER_NAME_MAX_LENGTH} 个字符`)
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new UserError('USER_NAME_INVALID', '用户名不得包含控制字符')
  }
  return name
}

function normalizeStatus(value: unknown): UserStatus {
  if (value !== 'enabled' && value !== 'banned') {
    throw new UserError('USER_STATUS_INVALID', `未知的用户状态：${String(value)}（只认 enabled / banned）`)
  }
  return value
}

function normalizeRole(value: unknown): UserRole {
  if (value !== 'admin' && value !== 'user') {
    throw new UserError('USER_ROLE_INVALID', `未知的用户角色：${String(value)}（只认 admin / user）`)
  }
  return value
}

function normalizeDelta(value: unknown): Balance {
  if (typeof value !== 'bigint') {
    throw new UserError(
      'USER_BALANCE_INVALID',
      `余额变更必须是以 bigint 表示的整数最小单位，收到 ${typeof value}（AGENTS.md D10：禁止浮点）`,
    )
  }
  return value
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UserError('USER_REASON_REQUIRED', '改动余额必须给出非空原因')
  }
  return value.trim()
}

function normalizeCount(value: unknown, fallback: number, field: string, max?: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new UserError('USER_ID_INVALID', `${field} 必须是非负整数`)
  }
  if (max !== undefined && value > max) {
    throw new UserError('USER_ID_INVALID', `${field} 最大 ${max}`)
  }
  return value
}

/**
 * 资料补丁的严格校验：只认 name / avatar，其它键直接拒绝。
 *
 * `undefined` 与「没传这个字段」等价：TS 里可选属性、对象展开都可能留下 undefined，
 * 把它当成调用错误没有收益。`avatar: null` 仍然明确表示清除。
 */
function normalizeProfilePatch(value: unknown): { name?: string; avatar?: string | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new UserError('USER_PROFILE_INVALID', '资料更新必须是一个对象')
  }
  const raw = value as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (key !== 'name' && key !== 'avatar') {
      throw new UserError('USER_PROFILE_INVALID', `资料更新不允许字段：${key}（只认 name / avatar）`)
    }
  }

  const patch: { name?: string; avatar?: string | null } = {}
  if (Object.prototype.hasOwnProperty.call(raw, 'name') && raw.name !== undefined) {
    patch.name = normalizeName(raw.name)
  }
  if (Object.prototype.hasOwnProperty.call(raw, 'avatar') && raw.avatar !== undefined) {
    patch.avatar = normalizeAvatar(raw.avatar)
  }
  return patch
}

/**
 * 头像只接受两种形状：
 * - `http(s)://` URL，长度 ≤ 2048；
 * - `data:image/(png|jpeg|webp|gif);base64,...`，解码后 ≤ 256 KiB。
 *
 * 其它协议（file:、javascript:、svg+xml…）一律拒绝：这个值会被浏览器直接渲染，
 * 不能把「任意 URL / 任意 MIME」放进用户表。null 表示清除。
 */
function normalizeAvatar(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new UserError('USER_AVATAR_INVALID', '头像必须是字符串或 null')
  }
  const avatar = value.trim()
  if (avatar === '') {
    throw new UserError('USER_AVATAR_INVALID', '头像不能为空字符串（清除请用 null）')
  }

  if (/^https?:\/\//i.test(avatar)) {
    if (avatar.length > USER_AVATAR_URL_MAX_LENGTH) {
      throw new UserError('USER_AVATAR_INVALID', `头像 URL 最长 ${USER_AVATAR_URL_MAX_LENGTH} 个字符`)
    }
    let url: URL
    try {
      url = new URL(avatar)
    } catch {
      throw new UserError('USER_AVATAR_INVALID', '头像 URL 格式不正确')
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '') {
      throw new UserError('USER_AVATAR_INVALID', '头像 URL 只支持 http / https')
    }
    return avatar
  }

  if (avatar.length > MAX_AVATAR_DATA_URL_LENGTH) {
    throw new UserError(
      'USER_AVATAR_INVALID',
      `头像 data URL 过大（解码后上限 ${USER_AVATAR_DATA_MAX_BYTES} 字节）`,
    )
  }
  const match = AVATAR_DATA_URL.exec(avatar)
  if (match === null) {
    throw new UserError(
      'USER_AVATAR_INVALID',
      '头像只支持 http(s) URL 或 data:image/(png|jpeg|webp|gif);base64',
    )
  }

  const bytes = Buffer.from(match[2] ?? '', 'base64')
  if (bytes.length === 0) {
    throw new UserError('USER_AVATAR_INVALID', '头像 data URL 没有有效图片数据')
  }
  if (bytes.length > USER_AVATAR_DATA_MAX_BYTES) {
    throw new UserError(
      'USER_AVATAR_INVALID',
      `头像解码后最多 ${USER_AVATAR_DATA_MAX_BYTES} 字节`,
    )
  }
  return avatar
}

function formatBalance(balance: Balance): string {
  const unit = BALANCE_MINOR_UNITS_PER_YUAN
  const negative = balance < 0n
  const abs = negative ? -balance : balance
  const whole = abs / unit
  const fraction = (abs % unit).toString().padStart(unit.toString().length - 1, '0')
  return `${negative ? '-' : ''}${whole}.${fraction} 元`
}
