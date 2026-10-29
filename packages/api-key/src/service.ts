/**
 * API key 插件（服务名 `apiKey`）。
 *
 * 它是用户 API key 的唯一写者：签发、改名、启停、轮换、删除都只经由这里。
 * 存储是 SQLite（`node:sqlite`），只存 sha256 哈希与掩码；完整 key 只在
 * create / rotate 的返回值里出现一次。
 *
 * 它**不**在 LLM 请求热路径上：Go 的 key-auth 用的是本插件经控制桥推过去的
 * 只读哈希快照（`internal/apikeys`），Go 不读这个 SQLite 文件。
 *
 * 注意：成员不能用 `#` 私有字段。cordis 以 Proxy 作为 receiver 调用服务方法，
 * `#` 字段的 brand check 会抛「Receiver must be an instance of class」（AGENTS.md §10）。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'
import {
  API_KEY_CONFIG_SCHEMA,
  validateApiKeyConfig,
  type ApiKeyConfig,
  type ResolvedApiKeyConfig,
} from './config.ts'
import {
  asRow,
  bumpGeneration,
  constantTimeHexEqual,
  formatFullKey,
  generateSecret,
  generateTrackingId,
  hashApiKey,
  immediateTransaction,
  maskKey,
  newKeyId,
  openApiKeyDatabase,
  parseApiKey,
  readGeneration,
  toView,
  type ApiKeyRow,
} from './db.ts'
import { ApiKeyError } from './errors.ts'
import {
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PROFILE,
  type ApiKeyAction,
  type ApiKeyChangedEvent,
  type ApiKeySnapshot,
  type ApiKeySnapshotKey,
  type ApiKeyStatus,
  type ApiKeyView,
  type ApiKeyVerified,
} from './types.ts'
import type { DatabaseSync } from 'node:sqlite'

export interface CreateApiKeyInput {
  readonly name: string
  readonly appManaged?: boolean
}

export interface UpdateApiKeyPatch {
  readonly name?: string
  readonly enabled?: boolean
  /** 过期时间（ISO 8601）；null = 永不过期。 */
  readonly expiresAt?: string | null
  /** 金额上限（整数微元，十进制字符串）；null = 不限。 */
  readonly spendingLimitMicros?: string | null
  /** 并发上限）；null = 不限。 */
  readonly concurrencyLimit?: number | null
}

export interface CreateApiKeyResult {
  readonly key: ApiKeyView
  /** 完整 key；只在这一刻出现一次，调用方必须自己负责展示与保存。 */
  readonly secret: string
}

export interface RotateApiKeyResult {
  readonly key: ApiKeyView
  readonly secret: string
}

export interface RemoveApiKeyResult {
  readonly removed: true
}

const ZERO_HASH = '0'.repeat(64)
const MAX_KEY_ID_LENGTH = 128
const MAX_KEY_GENERATION_ATTEMPTS = 8
/** 金额上限的上界：SQLite INTEGER 读取侧的安全整数（≈ 9.0e15 微元 ≈ 90 亿元）。 */
const MAX_SPENDING_LIMIT_MICROS = BigInt(Number.MAX_SAFE_INTEGER)
/** 并发上限的上界：超过它就是配置错误，不是「很大」。 */
const MAX_CONCURRENCY_LIMIT = 100_000

export class ApiKeyService extends Service {
  static Config = API_KEY_CONFIG_SCHEMA
  /** key 必须属于一个存在的用户；user 被禁用 / 未装载时本插件停在 PENDING。 */
  static inject = ['user']

  /** 能力清单：目录可见的部分；不含任何 key、哈希或秘密。 */
  static catalog = {
    capabilities: ['api-keys', 'credential-issue', 'key-rotation'],
    events: [
      {
        name: 'api-key/changed',
        description: '某个用户的 API key 被创建 / 修改 / 轮换 / 删除（不含 secret）',
        payload: '{ userId: number, keyId: string, action: ApiKeyAction }',
      },
    ],
    bridge: [
      {
        method: 'keys.replace',
        direction: 'outbound',
        requestShape: 'ApiKeySnapshot',
        responseShape: 'GatewayKeysResult',
      },
      { method: 'keys.status', direction: 'outbound', responseShape: 'GatewayKeysStatus' },
    ],
    storage: [
      { key: 'dataPath', kind: 'file', description: 'API key SQLite（含完整 key、哈希与掩码）' },
    ],
    shapes: {
      ApiKeyView:
        'id,userId,name,trackingId,secret,maskedKey,enabled,appManaged,createdAt,updatedAt,lastUsedAt,rotatedAt,' +
        'expiresAt,spendingLimitMicros,concurrencyLimit',
      ApiKeySnapshot:
        'version,generation,keys[{keyId,userId,keyHash,profile,name,' +
        'expiresAt?,spendingLimitMicros?,concurrencyLimit?}]',
    },
  } as const

  readonly config: ResolvedApiKeyConfig
  private readonly db: DatabaseSync
  private closed = false

  constructor(ctx: Context, config: ApiKeyConfig | ResolvedApiKeyConfig = {}) {
    super(ctx, 'apiKey')
    this.config = resolveConfig(config)
    this.db = openApiKeyDatabase(resolveDataPath(ctx, this.config.dataPath))

    const logger = ctx.logger('api-key')
    logger.info(
      `API key 插件已装载：存储 ${describeStore(this.config.dataPath)}；` +
        `每用户上限 ${this.config.maxKeysPerUser}`,
    )

    // 注册即副作用：插件卸载时数据库连接跟着关闭（AGENTS.md D5）。
    ctx.effect(() => () => this.close(), 'api-key.store')
  }

  // ───────────────────────────────── 写：用户面 ─────────────────────────────────

  /**
   * 创建 key。完整 key 同时写入 `secret` 列，用户之后仍可在自己的列表里复制。
   *
   * 同一用户内名称唯一（`API_KEY_NAME_TAKEN`），便于前端识别；
   * 用户不存在或已封禁时拒绝（`API_KEY_USER_NOT_FOUND`，不区分两者）。
   */
  async create(userId: number, input: CreateApiKeyInput): Promise<CreateApiKeyResult> {
    const uid = normalizeUserId(userId)
    const name = normalizeName(input?.name)
    const appManaged = normalizeAppManaged(input?.appManaged)
    await this.assertActiveUser(uid)

    const created = this.createSync(uid, name, appManaged)
    this.emitChanged(uid, created.key.id, 'created')
    return created
  }

  /** 改名 / 启停 / 改三个执行面上限。至少提供一个字段。 */
  async update(userId: number, id: string, patch: UpdateApiKeyPatch): Promise<ApiKeyView> {
    const uid = normalizeUserId(userId)
    const keyId = normalizeKeyId(id)
    const name = patch?.name === undefined ? undefined : normalizeName(patch.name)
    const enabled = patch?.enabled === undefined ? undefined : normalizeEnabled(patch.enabled)
    const expiresAt =
      patch?.expiresAt === undefined ? undefined : normalizeExpiresAt(patch.expiresAt)
    const spendingLimit =
      patch?.spendingLimitMicros === undefined
        ? undefined
        : normalizeSpendingLimit(patch.spendingLimitMicros)
    const concurrencyLimit =
      patch?.concurrencyLimit === undefined
        ? undefined
        : normalizeConcurrencyLimit(patch.concurrencyLimit)
    if (
      name === undefined &&
      enabled === undefined &&
      expiresAt === undefined &&
      spendingLimit === undefined &&
      concurrencyLimit === undefined
    ) {
      throw new ApiKeyError(
        'API_KEY_INVALID_INPUT',
        '至少提供 name / enabled / expiresAt / spendingLimitMicros / concurrencyLimit 之一',
      )
    }

    const updated = immediateTransaction(this.db, () => {
      const current = this.requireOwnedRow(uid, keyId)
      if (name !== undefined && name !== current.name) {
        if (this.nameTaken(uid, name, keyId)) {
          throw new ApiKeyError('API_KEY_NAME_TAKEN', `名称已被占用：${name}`)
        }
      }
      const nextName = name ?? current.name
      const nextEnabled = enabled === undefined ? current.enabled : enabled ? 1 : 0
      this.db
        .prepare(
          'UPDATE api_keys SET name = ?, enabled = ?, expires_at = ?, spending_limit = ?, ' +
            'concurrency_limit = ?, updated_at = ? WHERE id = ? AND user_id = ?',
        )
        .run(
          nextName,
          nextEnabled,
          expiresAt === undefined ? current.expires_at : expiresAt,
          spendingLimit === undefined ? current.spending_limit : spendingLimit,
          concurrencyLimit === undefined ? current.concurrency_limit : concurrencyLimit,
          new Date().toISOString(),
          keyId,
          uid,
        )
      bumpGeneration(this.db)
      return this.requireRow(keyId)
    })

    this.emitChanged(uid, keyId, 'updated')
    return toView(updated)
  }

  /**
   * 轮换 secret：trackingId 与 key id 不变，旧 secret 立刻失效。
   * 新完整 key 写回 `secret` 列；用户被禁用时拒绝。
   */
  async rotate(userId: number, id: string): Promise<RotateApiKeyResult> {
    const uid = normalizeUserId(userId)
    const keyId = normalizeKeyId(id)
    await this.assertActiveUser(uid)

    const rotated = immediateTransaction(this.db, () => {
      const current = this.requireOwnedRow(uid, keyId)
      for (let attempt = 0; attempt < MAX_KEY_GENERATION_ATTEMPTS; attempt += 1) {
        const secret = generateSecret()
        const fullKey = formatFullKey(current.tracking_id, secret)
        const hash = hashApiKey(fullKey)
        const collision = this.db
          .prepare('SELECT id FROM api_keys WHERE secret_hash = ? AND id <> ?')
          .get(hash, keyId)
        if (collision !== undefined) continue

        const now = new Date().toISOString()
        this.db
          .prepare(
            'UPDATE api_keys SET secret_hash = ?, secret = ?, masked_key = ?, rotated_at = ?, updated_at = ? ' +
              'WHERE id = ? AND user_id = ?',
          )
          .run(hash, fullKey, maskKey(current.tracking_id, secret), now, now, keyId, uid)
        bumpGeneration(this.db)
        return { key: toView(this.requireRow(keyId)), secret: fullKey }
      }
      throw new ApiKeyError('API_KEY_INVALID_INPUT', '生成唯一 secret 失败，请重试')
    })

    this.emitChanged(uid, keyId, 'rotated')
    return rotated
  }

  /** 删除 key。不属于该用户与不存在都报 `API_KEY_NOT_FOUND`。 */
  async remove(userId: number, id: string): Promise<RemoveApiKeyResult> {
    const uid = normalizeUserId(userId)
    const keyId = normalizeKeyId(id)

    immediateTransaction(this.db, () => {
      const result = this.db
        .prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?')
        .run(keyId, uid)
      if (Number(result.changes) === 0) throw notFound(keyId)
      bumpGeneration(this.db)
    })

    this.emitChanged(uid, keyId, 'removed')
    return { removed: true }
  }

  // ───────────────────────────────── 读：用户面 / 管理面 ─────────────────────────────────

  /** 某用户的全部 key（含已停用），按创建顺序。 */
  async list(userId: number): Promise<ApiKeyView[]> {
    const uid = normalizeUserId(userId)
    return this.db
      .prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(uid)
      .map((row) => toView(asRow(row)!))
  }

  /** 管理员读：全部用户的 key，但**不下发完整 key**，只给掩码。 */
  async listAll(): Promise<ApiKeyView[]> {
    return this.db
      .prepare('SELECT * FROM api_keys ORDER BY created_at ASC, rowid ASC')
      .all()
      .map((row) => ({ ...toView(asRow(row)!), secret: null }))
  }

  async get(userId: number, id: string): Promise<ApiKeyView> {
    const uid = normalizeUserId(userId)
    const keyId = normalizeKeyId(id)
    return toView(this.requireOwnedRow(uid, keyId))
  }

  /**
   * 校验完整 key。
   *
   * 先校验形状，再按 trackingId 取记录，用常量时间比较 sha256。
   * 不存在、格式错、已停用、用户已封禁都返回 undefined 且不泄露差异。
   * 它不更新 lastUsedAt（Go 尚未回报用量；见 AGENTS.md §11）。
   */
  async verify(secret: string): Promise<ApiKeyVerified | undefined> {
    if (typeof secret !== 'string' || secret === '') return undefined
    const parsed = parseApiKey(secret)
    if (parsed === undefined) return undefined

    const digest = hashApiKey(secret)
    const candidate = this.findByTracking(parsed.trackingId)
    const stored = candidate?.secret_hash ?? ZERO_HASH
    const matched = constantTimeHexEqual(stored, digest)
    if (!matched || candidate === undefined || candidate.enabled !== 1) return undefined

    const user = await this.ctx.user.get(candidate.user_id)
    if (user === undefined || user.status !== 'enabled') return undefined

    return {
      keyId: candidate.id,
      userId: candidate.user_id,
      name: candidate.name,
      profile: API_KEY_PROFILE,
    }
  }

  /**
   * 只读哈希快照：只含 enabled 且用户存在、状态为 enabled 的 key。
   * 不含明文、掩码、时间戳——Go 只需要 keyId / userId / keyHash / profile / name。
   */
  async snapshot(): Promise<ApiKeySnapshot> {
    const rows = this.db
      .prepare(
        'SELECT id, user_id, name, secret_hash, enabled, expires_at, spending_limit, ' +
          'concurrency_limit FROM api_keys WHERE enabled = 1 ORDER BY rowid ASC',
      )
      .all()
    // rows 与 generation 必须在同一个同步块里读：两者之间不 await，才不会出现
    //「旧 keys + 新 generation」的错配。user.get 是异步的，放到这之后再查。
    const generation = readGeneration(this.db)

    const userIds = new Set<number>()
    for (const raw of rows) {
      const row = asRow(raw)!
      userIds.add(row.user_id)
    }
    const activeUsers = new Set<number>()
    for (const userId of userIds) {
      const user = await this.ctx.user.get(userId)
      if (user !== undefined && user.status === 'enabled') activeUsers.add(userId)
    }

    const keys: ApiKeySnapshotKey[] = []
    for (const raw of rows) {
      const row = asRow(raw)!
      if (!activeUsers.has(row.user_id)) continue
      const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null
      // 过期 key 仍然推给 Go：**由 Go 在 pre 相位拒绝**（401 API_KEY_EXPIRED），
      // 这样用户能看到明确的错误码，而不是一个「key 无效」的黑盒。
      const view = toView(row)
      keys.push({
        keyId: row.id,
        userId: row.user_id,
        keyHash: row.secret_hash,
        profile: API_KEY_PROFILE,
        name: row.name,
        expiresAt,
        spendingLimitMicros: view.spendingLimitMicros,
        concurrencyLimit: view.concurrencyLimit,
      })
    }

    return { version: 1, generation, keys }
  }

  /** 运行期计数（不含任何秘密）。 */
  status(): ApiKeyStatus {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()
    const users = this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM api_keys').get()
    const updated = this.db.prepare('SELECT MAX(updated_at) AS value FROM api_keys').get()
    return {
      keys: toCount(total?.n),
      users: toCount(users?.n),
      generation: readGeneration(this.db),
      updatedAt: typeof updated?.value === 'string' ? updated.value : null,
    }
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private createSync(
    userId: number,
    name: string,
    appManaged: boolean,
  ): CreateApiKeyResult {
    return immediateTransaction(this.db, () => {
      if (this.countForUser(userId) >= this.config.maxKeysPerUser) {
        throw new ApiKeyError(
          'API_KEY_LIMIT_REACHED',
          `用户 #${userId} 的 API key 已达上限 ${this.config.maxKeysPerUser}`,
        )
      }
      if (this.nameTaken(userId, name)) {
        throw new ApiKeyError('API_KEY_NAME_TAKEN', `名称已被占用：${name}`)
      }

      const now = new Date().toISOString()
      for (let attempt = 0; attempt < MAX_KEY_GENERATION_ATTEMPTS; attempt += 1) {
        const trackingId = generateTrackingId()
        if (this.findByTracking(trackingId) !== undefined) continue

        const secret = generateSecret()
        const fullKey = formatFullKey(trackingId, secret)
        const hash = hashApiKey(fullKey)
        const hashCollision = this.db
          .prepare('SELECT id FROM api_keys WHERE secret_hash = ?')
          .get(hash)
        if (hashCollision !== undefined) continue

        const id = newKeyId()
        this.db
          .prepare(
            'INSERT INTO api_keys (' +
              'id, user_id, name, tracking_id, secret_hash, secret, masked_key, ' +
              'enabled, app_managed, created_at, updated_at, last_used_at, rotated_at' +
              ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
          )
          .run(
            id,
            userId,
            name,
            trackingId,
            hash,
            fullKey,
            maskKey(trackingId, secret),
            1,
            appManaged ? 1 : 0,
            now,
            now,
          )
        bumpGeneration(this.db)
        return { key: toView(this.requireRow(id)), secret: fullKey }
      }

      throw new ApiKeyError('API_KEY_INVALID_INPUT', '生成唯一 API key 失败，请重试')
    })
  }

  private async assertActiveUser(userId: number): Promise<void> {
    const user = await this.ctx.user.get(userId)
    if (user === undefined || user.status !== 'enabled') {
      throw new ApiKeyError('API_KEY_USER_NOT_FOUND', `用户 #${userId} 不存在或已被禁用`)
    }
  }

  /** 全站 key 总数（管理概览用；只查 COUNT，不加载记录）。 */
  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM api_keys').get()
    return toCount(row?.n)
  }

  private countForUser(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ?')
      .get(userId)
    return toCount(row?.n)
  }

  private nameTaken(userId: number, name: string, excludeId?: string): boolean {
    const row =
      excludeId === undefined
        ? this.db.prepare('SELECT id FROM api_keys WHERE user_id = ? AND name = ?').get(userId, name)
        : this.db
            .prepare('SELECT id FROM api_keys WHERE user_id = ? AND name = ? AND id <> ?')
            .get(userId, name, excludeId)
    return row !== undefined
  }

  private findByTracking(trackingId: string): ApiKeyRow | undefined {
    return asRow(
      this.db.prepare('SELECT * FROM api_keys WHERE tracking_id = ?').get(trackingId),
    )
  }

  private requireRow(id: string): ApiKeyRow {
    const row = asRow(this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id))
    if (row === undefined) {
      throw new ApiKeyError('API_KEY_STORE_CORRUPT', '刚写入的 API key 记录读不出来')
    }
    return row
  }

  private requireOwnedRow(userId: number, id: string): ApiKeyRow {
    const row = asRow(
      this.db.prepare('SELECT * FROM api_keys WHERE id = ? AND user_id = ?').get(id, userId),
    )
    if (row === undefined) throw notFound(id)
    return row
  }

  private emitChanged(userId: number, keyId: string, action: ApiKeyAction): void {
    const event: ApiKeyChangedEvent = { userId, keyId, action }
    this.ctx.emit('api-key/changed', event)
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

function resolveConfig(config: ApiKeyConfig | ResolvedApiKeyConfig): ResolvedApiKeyConfig {
  const result = validateApiKeyConfig(config)
  if (isIssueList(result)) {
    throw new ApiKeyError(
      'API_KEY_INVALID_INPUT',
      `API key 配置不合法：${result.map((item) => item.message).join('；')}`,
    )
  }
  return result
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function describeStore(path: string | undefined): string {
  return path === undefined ? ':memory:（进程退出即丢）' : `sqlite（${path}）`
}

function normalizeUserId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', `非法用户 ID：${String(value)}`)
  }
  return value
}

function normalizeKeyId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'key id 必须是字符串')
  }
  const id = value.trim()
  if (id === '' || id.length > MAX_KEY_ID_LENGTH) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'key id 不合法')
  }
  return id
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', '名称必须是字符串')
  }
  const name = value.trim()
  if (name === '') throw new ApiKeyError('API_KEY_INVALID_INPUT', '名称不能为空')
  if (name.length > API_KEY_NAME_MAX_LENGTH) {
    throw new ApiKeyError(
      'API_KEY_INVALID_INPUT',
      `名称最长 ${API_KEY_NAME_MAX_LENGTH} 个字符`,
    )
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', '名称不得包含控制字符')
  }
  return name
}

function normalizeAppManaged(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'appManaged 必须是布尔值')
  }
  return value
}

function normalizeEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'enabled 必须是布尔值')
  }
  return value
}

/**
 * 过期时间：null 清除，字符串必须是合法 ISO 8601 时间。
 *
 * 统一存 UTC ISO（`toISOString()`）：Go 侧按 RFC3339 解析，两个时区写法混用会让
 * 「过期判定」出现几小时的偏差。
 */
function normalizeExpiresAt(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'expiresAt 必须是 ISO 8601 字符串或 null')
  }
  const trimmed = value.trim()
  if (trimmed === '') return null
  const ms = Date.parse(trimmed)
  if (!Number.isFinite(ms)) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', `expiresAt 不是合法时间：${trimmed}`)
  }
  return new Date(ms).toISOString()
}

/**
 * 金额上限：null 清除，字符串必须是正整数微元（十进制，无小数、无符号）。
 *
 * 不接受 number：JSON number 会丢 >2^53 的精度，调用方必须传十进制字符串。
 */
function normalizeSpendingLimit(value: unknown): bigint | null {
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'spendingLimitMicros 必须是十进制字符串或 null')
  }
  const text = value.trim()
  if (text === '') return null
  if (!/^[0-9]+$/.test(text)) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', `spendingLimitMicros 必须是正整数微元：${text}`)
  }
  const micros = BigInt(text)
  if (micros <= 0n) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'spendingLimitMicros 必须大于 0（不限请传 null）')
  }
  if (micros > MAX_SPENDING_LIMIT_MICROS) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', `spendingLimitMicros 超出上限 ${MAX_SPENDING_LIMIT_MICROS.toString()}`)
  }
  return micros
}

/** 并发上限：null 清除；正整数。 */
function normalizeConcurrencyLimit(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', 'concurrencyLimit 必须是正整数或 null')
  }
  if (value > MAX_CONCURRENCY_LIMIT) {
    throw new ApiKeyError('API_KEY_INVALID_INPUT', `concurrencyLimit 不得超过 ${MAX_CONCURRENCY_LIMIT}`)
  }
  return value
}

function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'bigint' && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value)
  }
  return 0
}

function notFound(keyId: string): ApiKeyError {
  return new ApiKeyError('API_KEY_NOT_FOUND', `API key 不存在：${keyId}`)
}
