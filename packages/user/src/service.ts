import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from 'cordis'
import { UserError } from './errors.ts'
import {
  BALANCE_MINOR_UNITS_PER_YUAN,
  USER_NAME_MAX_LENGTH,
  type Balance,
  type BalanceEntry,
  type User,
  type UserId,
  type UserQuery,
  type UserStatus,
} from './model.ts'
import { USER_CONFIG_SCHEMA, type ResolvedUserConfig } from './schema.ts'
import { jsonFileStore, memoryStore, type UserStore } from './store.ts'

export interface CreateUserInput {
  readonly name: string
}

interface State {
  nextId: UserId
  users: User[]
  entries: BalanceEntry[]
}

const DEFAULT_LIST_LIMIT = 100
const MAX_LIST_LIMIT = 1000

/**
 * 用户插件。两个接口面，边界清楚：
 *
 * 1. **管理面**（create / rename / setStatus / remove）：只对 `adminPlugins`
 *    里列出的插件开放，默认拒绝。这就是「指定插件（管理员管理插件）改用户表单」。
 * 2. **余额面**（getBalance / adjustBalance / listBalanceEntries）：供其他插件读取与
 *    改动余额，默认不限制消费者，可用 `balanceWriters` 收窄。
 *
 * 另有只读的 get / list，任何插件可用。
 *
 * 写者唯一（AGENTS.md D8）：所有改动都经由本服务，外部拿到的是副本。
 * 所有改动串行执行（内存里的「读状态 → 改 → 落盘」不会交错），因此内部用一条队列
 * 串起来；这是控制面流量，量小，串行没有代价——LLM 请求路径不经过本服务。
 *
 * 注意：这里的成员**不能**用 `#` 私有字段。cordis 会以 Proxy 作为 receiver 调用服务
 * 方法，而 `#` 字段有 brand check，在 Proxy 上会抛
 * “Receiver must be an instance of class”。用 TS 的 `private` 才是对的。
 */
export class UserService extends Service {
  static Config = USER_CONFIG_SCHEMA

  readonly config: ResolvedUserConfig
  private store: UserStore
  private adminPlugins: readonly string[]
  private balanceWriters: readonly string[] | undefined
  private state: State | undefined
  private loading: Promise<State> | undefined
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ResolvedUserConfig = {}) {
    super(ctx, 'user')
    this.config = config
    this.adminPlugins = config.adminPlugins ?? []
    this.balanceWriters = config.balanceWriters
    this.store = config.dataPath ? jsonFileStore(resolveDataPath(ctx, config.dataPath)) : memoryStore()

    const logger = ctx.logger('user')
    logger.info(
      `用户插件已装载：存储 ${this.store.describe}；用户表单写者 ${this.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (this.adminPlugins.length === 0) {
      logger.warn('adminPlugins 为空：当前没有任何插件可以创建 / 禁用 / 删除用户或改用户名')
    }

    // 注册即副作用：插件被卸载时这里跟着回收（AGENTS.md D5）。
    ctx.effect(() => () => this.store.close(), 'user.store')
  }

  // ───────────────────────── 管理面：仅限被授权的插件 ─────────────────────────

  /**
   * 创建用户。ID 按注册顺序分配：从 1 开始，单调递增，删除后也不复用。
   * 新用户默认为 enabled、余额为 0；钱只经由 adjustBalance 变动，好留下流水。
   */
  async create(actor: string, input: CreateUserInput): Promise<User> {
    this.assertAdmin(actor)
    const name = normalizeName(input?.name)

    return this.exclusive(async () => {
      const state = await this.loadState()
      if (state.users.some((user) => user.name === name)) {
        throw new UserError('USER_NAME_TAKEN', `用户名已被占用：${name}`)
      }
      const now = new Date().toISOString()
      const user: User = {
        id: state.nextId,
        name,
        status: 'enabled',
        balance: 0n,
        createdAt: now,
        updatedAt: now,
      }
      state.nextId += 1
      state.users.push(user)
      await this.persist(state)
      return { ...user }
    })
  }

  /** 改用户名。 */
  async rename(actor: string, id: UserId, name: string): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)
    const nextName = normalizeName(name)

    return this.exclusive(async () => {
      const state = await this.loadState()
      const index = findIndex(state, userId)
      if (state.users.some((user) => user.name === nextName && user.id !== userId)) {
        throw new UserError('USER_NAME_TAKEN', `用户名已被占用：${nextName}`)
      }
      return this.replace(state, index, { name: nextName })
    })
  }

  /** 封禁（banned）或启用（enabled）用户。删除是独立操作，不表达为状态。 */
  async setStatus(actor: string, id: UserId, status: UserStatus): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)
    const nextStatus = normalizeStatus(status)

    return this.exclusive(async () => {
      const state = await this.loadState()
      return this.replace(state, findIndex(state, userId), { status: nextStatus })
    })
  }

  /**
   * 删除用户。余额不为零时拒绝——先把钱结清，那会留下一笔流水，账才说得清。
   * 用户被删掉后，他的余额流水仍然保留（只增不改的审计附本）。
   */
  async remove(actor: string, id: UserId): Promise<User> {
    this.assertAdmin(actor)
    const userId = normalizeId(id)

    return this.exclusive(async () => {
      const state = await this.loadState()
      const index = findIndex(state, userId)
      const user = state.users[index]!
      if (user.balance !== 0n) {
        throw new UserError(
          'USER_BALANCE_NOT_ZERO',
          `用户 ${user.name}（#${user.id}）余额为 ${formatBalance(user.balance)}，先结清再删除`,
        )
      }
      state.users.splice(index, 1)
      await this.persist(state)
      return { ...user }
    })
  }

  // ───────────────────────────── 读：任何插件可用 ─────────────────────────────

  async get(id: UserId): Promise<User | undefined> {
    const userId = normalizeId(id)
    return this.exclusive(async () => {
      const state = await this.loadState()
      const user = state.users.find((item) => item.id === userId)
      return user ? { ...user } : undefined
    })
  }

  async list(query: UserQuery = {}): Promise<User[]> {
    const status = query.status === undefined ? undefined : normalizeStatus(query.status)
    const offset = normalizeCount(query.offset, 0, 'offset')
    const limit = normalizeCount(query.limit, DEFAULT_LIST_LIMIT, 'limit', MAX_LIST_LIMIT)

    return this.exclusive(async () => {
      const state = await this.loadState()
      const matched = status === undefined
        ? state.users
        : state.users.filter((user) => user.status === status)
      return matched.slice(offset, offset + limit).map((user) => ({ ...user }))
    })
  }

  // ───────────────────────────── 余额面：供其他插件 ─────────────────────────────

  /** 读取余额。用户不存在直接报错，不返回 0——查不到和余额为零是两件事。 */
  async getBalance(id: UserId): Promise<Balance> {
    const userId = normalizeId(id)
    return this.exclusive(async () => {
      const state = await this.loadState()
      return state.users[findIndex(state, userId)]!.balance
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

    return this.exclusive(async () => {
      const state = await this.loadState()
      const index = findIndex(state, userId)
      const user = state.users[index]!
      const balanceAfter = user.balance + change
      const at = new Date().toISOString()

      state.users[index] = { ...user, balance: balanceAfter, updatedAt: at }
      state.entries.push({ userId, delta: change, balanceAfter, reason: why, actor: consumer, at })
      await this.persist(state)
      return balanceAfter
    })
  }

  /** 读某用户的余额流水，返回最近 `limit` 条，按时间正序。 */
  async listBalanceEntries(id: UserId, limit = DEFAULT_LIST_LIMIT): Promise<BalanceEntry[]> {
    const userId = normalizeId(id)
    const take = normalizeCount(limit, DEFAULT_LIST_LIMIT, 'limit', MAX_LIST_LIMIT)

    return this.exclusive(async () => {
      const state = await this.loadState()
      const mine = state.entries.filter((entry) => entry.userId === userId)
      return mine.slice(Math.max(0, mine.length - take)).map((entry) => ({ ...entry }))
    })
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

  /** 串行执行：同一时刻只有一次「读状态 → 改 → 落盘」在进行。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(noop, noop)
    return result
  }

  private loadState(): Promise<State> {
    if (this.state) return Promise.resolve(this.state)
    if (!this.loading) {
      const loading = this.store.load().then((snapshot) => {
        const state: State = {
          nextId: snapshot.nextId,
          users: [...snapshot.users],
          entries: [...snapshot.entries],
        }
        this.state = state
        return state
      })
      this.loading = loading
      loading.catch(() => {
        // 加载失败不缓存，下一次调用可以重试
        if (this.loading === loading) this.loading = undefined
      })
    }
    return this.loading
  }

  private async persist(state: State): Promise<void> {
    await this.store.save({
      nextId: state.nextId,
      users: [...state.users],
      entries: [...state.entries],
    })
  }

  private async replace(
    state: State,
    index: number,
    patch: { name?: string; status?: UserStatus },
  ): Promise<User> {
    const updated: User = { ...state.users[index]!, ...patch, updatedAt: new Date().toISOString() }
    state.users[index] = updated
    await this.persist(state)
    return { ...updated }
  }
}

function noop(): void {
  // 只用来把队列里失败的 promise 咽掉，避免污染下一次 task
}

function resolveDataPath(ctx: Context, path: string): string {
  if (isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function findIndex(state: State, userId: UserId): number {
  const index = state.users.findIndex((user) => user.id === userId)
  if (index < 0) throw new UserError('USER_NOT_FOUND', `没有这个用户：#${userId}`)
  return index
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

function formatBalance(balance: Balance): string {
  const unit = BALANCE_MINOR_UNITS_PER_YUAN
  const negative = balance < 0n
  const abs = negative ? -balance : balance
  const whole = abs / unit
  const fraction = (abs % unit).toString().padStart(unit.toString().length - 1, '0')
  return `${negative ? '-' : ''}${whole}.${fraction} 元`
}
