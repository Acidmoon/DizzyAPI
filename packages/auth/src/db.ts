import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { describeError } from '@dizzyapi/plugin-kit'
import { AuthError } from './errors.ts'
import type {
  Credential,
  PendingCode,
  PendingPurpose,
  RateCounter,
  Session,
} from './model.ts'
import { snapshotCodec } from './store.ts'

/**
 * 鉴权插件的 SQLite 存储。
 *
 * 与 user 插件一样：本文件只管「怎么存」，领域规则（防枚举、验证码次数、会话语义）
 * 在 AuthService。**两个插件各管各的库**：这里是 auth.db，不碰 users.db
 * （AGENTS.md D8：一个数据一个写者）。
 *
 * DatabaseSync 是同步 API。事务里的函数**不许** await；服务层的串行队列负责排序。
 */

const SCHEMA_VERSION = 1
const PRUNE_INTERVAL_MS = 60_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  user_id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pendings (
  purpose TEXT NOT NULL,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  name TEXT,
  password_hash TEXT,
  PRIMARY KEY (purpose, email)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_ms INTEGER NOT NULL
);
`

const CREDENTIAL_COLUMNS = 'user_id, email, password_hash, created_at, updated_at'
const PENDING_COLUMNS =
  'purpose, email, code_hash, salt, attempts, created_at, expires_at, name, password_hash'
const SESSION_COLUMNS = 'id, user_id, token_hash, created_at, expires_at, last_seen_at'
const COUNTER_COLUMNS = 'key, count, window_start, window_ms'

export interface LegacyAuthImport {
  readonly credentials: number
  readonly pendings: number
  readonly sessions: number
  readonly counters: number
}

/**
 * 打开（必要时创建并迁移）鉴权数据库。
 *
 * `dataPath` 省略或为 `:memory:` 时用内存库。文件库首次创建且同目录存在旧
 * `auth.json` 时一次性导入旧快照；旧文件保留，DB 已有数据时绝不覆盖。
 */
export class AuthDatabase {
  readonly describe: string
  /** 文件库的绝对路径；内存库为 undefined。 */
  readonly path: string | undefined
  /** 本次启动是否从旧 JSON 导入，以及导入了多少条。 */
  readonly legacyImport: LegacyAuthImport | undefined

  private readonly db: DatabaseSync
  private inTransaction = false
  private closed = false
  private lastPruneMs = Number.NaN

  constructor(dataPath: string | undefined) {
    const file = dataPath ?? ':memory:'
    const memory = file === ':memory:'
    const existed = !memory && existsSync(file)

    if (!memory) {
      try {
        mkdirSync(dirname(file), { recursive: true })
      } catch (error) {
        throw unreadable(error)
      }
    }

    let db: DatabaseSync
    try {
      db = new DatabaseSync(file)
    } catch (error) {
      throw classifyOpenError(error)
    }
    this.db = db

    try {
      configure(db, memory)
      migrate(db)
      this.legacyImport = existed ? undefined : importLegacyFile(db, file)
    } catch (error) {
      try {
        db.close()
      } catch {
        // 关闭失败不掩盖原始错误
      }
      if (!existed && !memory) removeDatabaseFiles(file)
      if (error instanceof AuthError) throw error
      throw corrupt(describeError(error))
    }

    this.path = memory ? undefined : file
    this.describe = memory ? 'sqlite（:memory:）' : `sqlite（${file}）`
  }

  // ───────────────────────────── 事务 ─────────────────────────────

  /** 在 `BEGIN IMMEDIATE` 事务里同步执行；抛错即 ROLLBACK。事务里不许 await。 */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    if (this.inTransaction) {
      throw new AuthError('AUTH_STORE_UNREADABLE', '内部错误：不允许嵌套事务')
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.inTransaction = true
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 保留原始错误
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  // ───────────────────────────── 凭证 ─────────────────────────────

  getCredentialByEmail(email: string): Credential | undefined {
    const row = this.row(`SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE email = ?`, email)
    return row === undefined ? undefined : readCredential(row, `credentials[email=${email}]`)
  }

  getCredentialByUserId(userId: number): Credential | undefined {
    const row = this.row(
      `SELECT ${CREDENTIAL_COLUMNS} FROM credentials WHERE user_id = ?`,
      userId,
    )
    return row === undefined ? undefined : readCredential(row, `credentials[user=${userId}]`)
  }

  insertCredential(credential: Credential): void {
    try {
      this.run(
        `INSERT INTO credentials (user_id, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        credential.userId,
        credential.email,
        credential.passwordHash,
        credential.createdAt,
        credential.updatedAt,
      )
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new AuthError('AUTH_EMAIL_TAKEN', `邮箱 ${credential.email} 已经注册过了`)
      }
      throw error
    }
  }

  updateCredentialPassword(userId: number, passwordHash: string, updatedAt: string): void {
    this.run(
      'UPDATE credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?',
      passwordHash,
      updatedAt,
      userId,
    )
  }

  deleteCredentialByUserId(userId: number): void {
    this.run('DELETE FROM credentials WHERE user_id = ?', userId)
  }

  // ───────────────────────────── 验证码 ─────────────────────────────

  getPending(purpose: PendingPurpose, email: string): PendingCode | undefined {
    const row = this.row(
      `SELECT ${PENDING_COLUMNS} FROM pendings WHERE purpose = ? AND email = ?`,
      purpose,
      email,
    )
    return row === undefined ? undefined : readPending(row, `pendings[${purpose}:${email}]`)
  }

  upsertPending(pending: PendingCode): void {
    this.run(
      `INSERT OR REPLACE INTO pendings
         (purpose, email, code_hash, salt, attempts, created_at, expires_at, name, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      pending.purpose,
      pending.email,
      pending.codeHash,
      pending.salt,
      pending.attempts,
      pending.createdAt,
      pending.expiresAt,
      pending.name ?? null,
      pending.passwordHash ?? null,
    )
  }

  setPendingAttempts(purpose: PendingPurpose, email: string, attempts: number): void {
    this.run(
      'UPDATE pendings SET attempts = ? WHERE purpose = ? AND email = ?',
      attempts,
      purpose,
      email,
    )
  }

  deletePending(purpose: PendingPurpose, email: string): void {
    this.run('DELETE FROM pendings WHERE purpose = ? AND email = ?', purpose, email)
  }

  // ───────────────────────────── 会话 ─────────────────────────────

  getSessionByTokenHash(tokenHash: string): Session | undefined {
    const row = this.row(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`,
      tokenHash,
    )
    return row === undefined ? undefined : readSession(row, 'sessions[token_hash]')
  }

  getSessionById(id: string): Session | undefined {
    const row = this.row(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, id)
    return row === undefined ? undefined : readSession(row, `sessions[id=${id}]`)
  }

  listSessionsByUser(userId: number): Session[] {
    return this.all(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE user_id = ? ORDER BY rowid`,
      userId,
    ).map((row, index) => readSession(row, `sessions[${index}]`))
  }

  countSessionsByUser(userId: number): number {
    const row = this.row('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', userId)
    return readInt(requireRow(row, 'sessions 计数').n, 'sessions 计数')
  }

  insertSession(session: Session): void {
    this.run(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      session.id,
      session.userId,
      session.tokenHash,
      session.createdAt,
      session.expiresAt,
      session.lastSeenAt,
    )
  }

  updateSessionLastSeen(id: string, lastSeenAt: string): void {
    this.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', lastSeenAt, id)
  }

  deleteSessionById(id: string): void {
    this.run('DELETE FROM sessions WHERE id = ?', id)
  }

  deleteSessionsByUser(userId: number): number {
    const before = this.countSessionsByUser(userId)
    this.run('DELETE FROM sessions WHERE user_id = ?', userId)
    return before
  }

  deleteOtherSessionsByUser(userId: number, keepId: string): number {
    const before = this.countSessionsByUser(userId)
    this.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', userId, keepId)
    return before - 1
  }

  // ───────────────────────────── 限流计数 ─────────────────────────────

  getCounter(key: string): RateCounter | undefined {
    const row = this.row(`SELECT ${COUNTER_COLUMNS} FROM counters WHERE key = ?`, key)
    return row === undefined ? undefined : readCounter(row, `counters[key=${key}]`)
  }

  /** 与旧 JSON 语义一致：窗口内返回计数，窗口过期返回 0。 */
  readCounter(key: string, windowMs: number, now: string): number {
    const counter = this.getCounter(key)
    if (counter === undefined) return 0
    if (Date.parse(now) >= Date.parse(counter.windowStart) + Math.min(windowMs, counter.windowMs)) {
      return 0
    }
    return counter.count
  }

  bumpCounter(key: string, windowMs: number, now: string): number {
    return this.transaction(() => {
      const counter = this.getCounter(key)
      if (
        counter === undefined ||
        Date.parse(now) >= Date.parse(counter.windowStart) + counter.windowMs
      ) {
        this.run(
          `INSERT OR REPLACE INTO counters (key, count, window_start, window_ms)
           VALUES (?, ?, ?, ?)`,
          key,
          1,
          now,
          windowMs,
        )
        return 1
      }
      const next = counter.count + 1
      this.run('UPDATE counters SET count = ? WHERE key = ?', next, key)
      return next
    })
  }

  resetCounter(key: string): void {
    this.run('DELETE FROM counters WHERE key = ?', key)
  }

  // ───────────────────────────── 维护 ─────────────────────────────

  /**
   * 清掉过期的验证码、会话与计数窗口。
   *
   * `verifySession` 是界面请求热路径，所以这里**最多每分钟真正清理一次**：
   * 正确性不依赖物理删除——过期会话 / 验证码在读取时仍会被拦下，
   * 计数窗口由 `readCounter` 判断。清理只是别让表无限长。
   *
   * 会话与验证码的时间戳由本插件统一写成 `toISOString()`（UTC），SQL 字符串比较即可。
   * 只清理以 `Z` 结尾的行：旧数据若带时区偏移，字符串比较可能删掉实际未过期的行，
   * 这类行留给读取时的 `isExpired` 判断（`requireSession` / `verifyCode` 会删掉它）。
   * 计数窗口用 JS 按 `Date.parse` 判断（行数少，且旧数据的时间写法可能带时区偏移）。
   */
  prune(now: string): void {
    const nowMs = Date.parse(now)
    if (Number.isFinite(this.lastPruneMs) && nowMs - this.lastPruneMs < PRUNE_INTERVAL_MS) {
      return
    }
    this.lastPruneMs = nowMs

    this.run("DELETE FROM pendings WHERE expires_at <= ? AND expires_at LIKE '%Z'", now)
    this.run("DELETE FROM sessions WHERE expires_at <= ? AND expires_at LIKE '%Z'", now)

    const counters = this.all(`SELECT ${COUNTER_COLUMNS} FROM counters`).map((row, index) =>
      readCounter(row, `counters[${index}]`),
    )
    for (const counter of counters) {
      if (nowMs >= Date.parse(counter.windowStart) + counter.windowMs) {
        this.run('DELETE FROM counters WHERE key = ?', counter.key)
      }
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private all(sql: string, ...params: SQLInputValue[]): Record<string, SQLOutputValue>[] {
    this.assertOpen()
    try {
      const statement = this.db.prepare(sql)
      statement.setReadBigInts(true)
      return statement.all(...params)
    } catch (error) {
      if (error instanceof AuthError) throw error
      throw corrupt(describeError(error))
    }
  }

  private row(sql: string, ...params: SQLInputValue[]): Record<string, SQLOutputValue> | undefined {
    this.assertOpen()
    try {
      const statement = this.db.prepare(sql)
      statement.setReadBigInts(true)
      return statement.get(...params)
    } catch (error) {
      if (error instanceof AuthError) throw error
      if (isUniqueConstraint(error)) throw error
      throw corrupt(describeError(error))
    }
  }

  private run(sql: string, ...params: SQLInputValue[]): void {
    this.assertOpen()
    try {
      this.db.prepare(sql).run(...params)
    } catch (error) {
      if (error instanceof AuthError) throw error
      if (isUniqueConstraint(error)) throw error
      throw corrupt(describeError(error))
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AuthError('AUTH_STORE_UNREADABLE', '鉴权数据库已关闭')
    }
  }
}

// ───────────────────────────── 打开与迁移 ─────────────────────────────

function configure(db: DatabaseSync, memory: boolean): void {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  if (!memory) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get()
  const version = readVersion(row?.user_version)
  if (version > SCHEMA_VERSION) {
    throw corrupt(`数据库版本 ${version} 高于本插件支持的 ${SCHEMA_VERSION}`)
  }
  db.exec(SCHEMA)
  if (version < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/**
 * 首次建库时导入同目录的旧 `auth.json`。
 *
 * 严格解码（沿用 snapshotCodec）+ 单事务：坏一条就整份不导入。
 * 旧文件保留；DB 已有数据时跳过。
 */
function importLegacyFile(db: DatabaseSync, dbFile: string): LegacyAuthImport | undefined {
  const legacyPath = join(dirname(dbFile), 'auth.json')
  // 配置仍指向旧的 auth.json 时，DB 文件本身就是这个路径；不能把它当旧 JSON 读。
  if (legacyPath === dbFile) return undefined
  if (!existsSync(legacyPath)) return undefined

  let text: string
  try {
    text = readFileSync(legacyPath, 'utf8')
  } catch (error) {
    throw unreadable(error)
  }

  let snapshot: ReturnType<typeof snapshotCodec.decode>
  try {
    snapshot = snapshotCodec.decode(JSON.parse(text))
  } catch (error) {
    if (error instanceof AuthError) throw error
    if (error instanceof SyntaxError) {
      throw corrupt(`旧鉴权文件 ${legacyPath} 不是合法 JSON：${error.message}`)
    }
    throw corrupt(`旧鉴权文件 ${legacyPath} 无法解码：${describeError(error)}`)
  }

  const counts = ['credentials', 'pendings', 'sessions', 'counters'].map((table) => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | Record<string, SQLOutputValue>
      | undefined
    return readInt(row?.n ?? 0n, `${table} 计数`)
  })
  if (counts.some((count) => count > 0)) return undefined

  db.exec('BEGIN IMMEDIATE')
  try {
    const insertCredential = db.prepare(
      `INSERT INTO credentials (user_id, email, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const item of snapshot.credentials) {
      insertCredential.run(
        item.userId,
        item.email,
        item.passwordHash,
        item.createdAt,
        item.updatedAt,
      )
    }

    const insertPending = db.prepare(
      `INSERT INTO pendings
         (purpose, email, code_hash, salt, attempts, created_at, expires_at, name, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const item of snapshot.pendings) {
      insertPending.run(
        item.purpose,
        item.email,
        item.codeHash,
        item.salt,
        item.attempts,
        item.createdAt,
        item.expiresAt,
        item.name ?? null,
        item.passwordHash ?? null,
      )
    }

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const item of snapshot.sessions) {
      insertSession.run(
        item.id,
        item.userId,
        item.tokenHash,
        item.createdAt,
        item.expiresAt,
        item.lastSeenAt,
      )
    }

    const insertCounter = db.prepare(
      `INSERT INTO counters (key, count, window_start, window_ms) VALUES (?, ?, ?, ?)`,
    )
    for (const item of snapshot.counters) {
      insertCounter.run(item.key, item.count, item.windowStart, item.windowMs)
    }

    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 保留原始错误
    }
    if (error instanceof AuthError) throw error
    throw corrupt(`导入旧鉴权文件 ${legacyPath} 失败：${describeError(error)}`)
  }

  return {
    credentials: snapshot.credentials.length,
    pendings: snapshot.pendings.length,
    sessions: snapshot.sessions.length,
    counters: snapshot.counters.length,
  }
}

function removeDatabaseFiles(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${file}${suffix}`, { force: true })
    } catch {
      // 清理失败不掩盖原始错误
    }
  }
}

// ───────────────────────────── 行解码 ─────────────────────────────

function readCredential(row: Record<string, SQLOutputValue>, where: string): Credential {
  return {
    userId: readPositiveInt(row.user_id, `${where}.user_id`),
    email: readNonEmptyString(row.email, `${where}.email`),
    passwordHash: readNonEmptyString(row.password_hash, `${where}.password_hash`),
    createdAt: readString(row.created_at, `${where}.created_at`),
    updatedAt: readString(row.updated_at, `${where}.updated_at`),
  }
}

function readPending(row: Record<string, SQLOutputValue>, where: string): PendingCode {
  const purpose = row.purpose
  if (purpose !== 'register' && purpose !== 'reset') {
    throw corrupt(`${where}.purpose 必须是 register 或 reset`)
  }
  return {
    purpose,
    email: readNonEmptyString(row.email, `${where}.email`),
    codeHash: readNonEmptyString(row.code_hash, `${where}.code_hash`),
    salt: readNonEmptyString(row.salt, `${where}.salt`),
    attempts: readNonNegativeInt(row.attempts, `${where}.attempts`),
    createdAt: readString(row.created_at, `${where}.created_at`),
    expiresAt: readString(row.expires_at, `${where}.expires_at`),
    name: readNullableString(row.name, `${where}.name`),
    passwordHash: readNullableString(row.password_hash, `${where}.password_hash`),
  }
}

function readSession(row: Record<string, SQLOutputValue>, where: string): Session {
  return {
    id: readNonEmptyString(row.id, `${where}.id`),
    userId: readPositiveInt(row.user_id, `${where}.user_id`),
    tokenHash: readNonEmptyString(row.token_hash, `${where}.token_hash`),
    createdAt: readString(row.created_at, `${where}.created_at`),
    expiresAt: readString(row.expires_at, `${where}.expires_at`),
    lastSeenAt: readString(row.last_seen_at, `${where}.last_seen_at`),
  }
}

function readCounter(row: Record<string, SQLOutputValue>, where: string): RateCounter {
  return {
    key: readNonEmptyString(row.key, `${where}.key`),
    count: readNonNegativeInt(row.count, `${where}.count`),
    windowStart: readString(row.window_start, `${where}.window_start`),
    windowMs: readPositiveInt(row.window_ms, `${where}.window_ms`),
  }
}

function requireRow(
  row: Record<string, SQLOutputValue> | undefined,
  where: string,
): Record<string, SQLOutputValue> {
  if (row === undefined) throw corrupt(`${where} 不存在`)
  return row
}

function readVersion(value: SQLOutputValue | undefined): number {
  if (value === undefined || value === null) return 0
  return readInt(value, 'user_version')
}

function readInt(value: SQLOutputValue | undefined, where: string): number {
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw corrupt(`${where} 超出安全整数范围`)
    }
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw corrupt(`${where} 必须是整数`)
}

function readPositiveInt(value: SQLOutputValue | undefined, where: string): number {
  const parsed = readInt(value, where)
  if (parsed <= 0) throw corrupt(`${where} 必须是正整数`)
  return parsed
}

function readNonNegativeInt(value: SQLOutputValue | undefined, where: string): number {
  const parsed = readInt(value, where)
  if (parsed < 0) throw corrupt(`${where} 必须是非负整数`)
  return parsed
}

function readString(value: SQLOutputValue | undefined, where: string): string {
  if (typeof value !== 'string') throw corrupt(`${where} 必须是字符串`)
  return value
}

function readNonEmptyString(value: SQLOutputValue | undefined, where: string): string {
  const parsed = readString(value, where)
  if (parsed === '') throw corrupt(`${where} 不能为空`)
  return parsed
}

function readNullableString(value: SQLOutputValue | undefined, where: string): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw corrupt(`${where} 必须是字符串或 null`)
  return value
}

// ───────────────────────────── 错误映射 ─────────────────────────────

interface SqliteLikeError {
  readonly code?: unknown
  readonly errcode?: unknown
  readonly message?: unknown
}

function isUniqueConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const typed = error as SqliteLikeError
  return typed.errcode === 2067 || /UNIQUE constraint failed/i.test(String(typed.message ?? ''))
}

function classifyOpenError(error: unknown): AuthError {
  if (isNotADatabase(error)) return corrupt(describeError(error))
  return unreadable(error)
}

function isNotADatabase(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const message = String((error as SqliteLikeError).message ?? '')
  return /not a database|file is encrypted|malformed/i.test(message)
}

function corrupt(detail: string): AuthError {
  return new AuthError('AUTH_STORE_CORRUPT', `鉴权数据库损坏：${detail}`)
}

function unreadable(error: unknown): AuthError {
  return new AuthError('AUTH_STORE_UNREADABLE', `读取鉴权数据库失败：${describeError(error)}`)
}
