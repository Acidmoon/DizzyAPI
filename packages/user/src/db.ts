import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { describeError } from '@dizzyapi/plugin-kit'
import { UserError } from './errors.ts'
import type { Balance, BalanceEntry, User, UserId, UserRole, UserStatus } from './model.ts'
import { snapshotCodec } from './store.ts'

/**
 * 用户插件的 SQLite 存储。
 *
 * 边界与 JSON 存储相同：本文件只管「怎么存」，校验、权限与领域规则在 UserService。
 * 唯一写者是本插件的服务（AGENTS.md D8）；库文件由本插件独占，不与 auth 共用。
 *
 * 三条硬约束：
 * 1. 余额是 bigint 最小单位（D10）。SQLite 用 INTEGER 存，读语句开
 *    `setReadBigInts(true)`，绑定 bigint；不经过任何浮点。
 * 2. 读出来的每一行都按严格规则重新校验：坏数据抛 USER_STORE_CORRUPT，
 *    绝不「尽力恢复」——余额错一半比读不出来更危险。
 * 3. DatabaseSync 是同步 API。事务里的函数**不许** await 任何东西；
 *    UserService 的串行队列负责把跨调用的顺序排好。
 */

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance INTEGER NOT NULL DEFAULT 0,
  balance_enabled INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS balance_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_balance_entries_user
  ON balance_entries (user_id, id);
`

const USER_COLUMNS = 'id, name, status, role, balance, balance_enabled, avatar, created_at, updated_at'
const ENTRY_COLUMNS = 'user_id, delta, balance_after, reason, actor, at'

export interface InsertUserInput {
  readonly name: string
  readonly status: UserStatus
  readonly role: UserRole
  readonly balanceEnabled: boolean
  readonly avatar: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface UserRowPatch {
  readonly name?: string
  readonly status?: UserStatus
  readonly role?: UserRole
  readonly balanceEnabled?: boolean
  readonly avatar?: string | null
  readonly updatedAt: string
}

export interface LegacyUserImport {
  readonly users: number
  readonly entries: number
}

/**
 * 打开（必要时创建并迁移）用户数据库。
 *
 * `dataPath` 省略或为 `:memory:` 时用内存库，进程退出即丢——测试与内嵌用法走这条。
 * 文件库首次创建且同目录存在旧 `users.json` 时，一次性导入旧快照；
 * 旧文件保留不删，DB 已有数据时绝不覆盖。
 */
export class UserDatabase {
  readonly describe: string
  /** 文件库的绝对路径；内存库为 undefined。 */
  readonly path: string | undefined
  /** 本次启动是否从旧 JSON 导入，以及导入了多少条。 */
  readonly legacyImport: LegacyUserImport | undefined

  private readonly db: DatabaseSync
  private inTransaction = false
  private closed = false

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
      // 新建的库文件如果导入失败，删掉它，下次启动还能重试；
      // 旧 JSON 本身保留，绝不在失败时动它。
      if (!existed && !memory) removeDatabaseFiles(file)
      if (error instanceof UserError) throw error
      throw corrupt(describeError(error))
    }

    this.path = memory ? undefined : file
    this.describe = memory ? 'sqlite（:memory:）' : `sqlite（${file}）`
  }

  // ───────────────────────────── 事务 ─────────────────────────────

  /**
   * 在 `BEGIN IMMEDIATE` 事务里同步执行 `fn`；抛错即 ROLLBACK。
   * 事务里不许 await：DatabaseSync 是同步 API，拿着事务跨 await 会阻塞其他写者。
   */
  transaction<T>(fn: () => T): T {
    this.assertOpen()
    if (this.inTransaction) {
      throw new UserError('USER_STORE_UNREADABLE', '内部错误：不允许嵌套事务')
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
        // ROLLBACK 失败时保留原始错误，它才是根因
      }
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  // ───────────────────────────── 用户 ─────────────────────────────

  countUsers(): number {
    const row = this.row('SELECT COUNT(*) AS n FROM users')
    return readInt(requireRow(row, 'users 计数').n, 'users 计数')
  }

  countAdmins(): number {
    const row = this.row("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'")
    return readInt(requireRow(row, 'admin 计数').n, 'admin 计数')
  }

  getUser(id: UserId): User | undefined {
    const row = this.row(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id)
    return row === undefined ? undefined : readUser(row, `users[id=${id}]`)
  }

  listUsers(query: { status?: UserStatus; role?: UserRole; offset: number; limit: number }): User[] {
    const where: string[] = []
    const params: SQLInputValue[] = []
    if (query.status !== undefined) {
      where.push('status = ?')
      params.push(query.status)
    }
    if (query.role !== undefined) {
      where.push('role = ?')
      params.push(query.role)
    }
    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`
    params.push(query.limit, query.offset)
    return this.all(
      `SELECT ${USER_COLUMNS} FROM users${clause} ORDER BY id LIMIT ? OFFSET ?`,
      ...params,
    ).map((row, index) => readUser(row, `users[${index}]`))
  }

  insertUser(input: InsertUserInput): User {
    try {
      const result = this.run(
        `INSERT INTO users (name, status, role, balance, balance_enabled, avatar, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        input.name,
        input.status,
        input.role,
        0n,
        input.balanceEnabled ? 1 : 0,
        input.avatar,
        input.createdAt,
        input.updatedAt,
      )
      const id = readRowId(result.lastInsertRowid)
      return this.requireUser(id)
    } catch (error) {
      throw mapUniqueName(error, input.name)
    }
  }

  updateUser(id: UserId, patch: UserRowPatch): User {
    const sets: string[] = []
    const params: SQLInputValue[] = []
    if (patch.name !== undefined) {
      sets.push('name = ?')
      params.push(patch.name)
    }
    if (patch.status !== undefined) {
      sets.push('status = ?')
      params.push(patch.status)
    }
    if (patch.role !== undefined) {
      sets.push('role = ?')
      params.push(patch.role)
    }
    if (patch.balanceEnabled !== undefined) {
      sets.push('balance_enabled = ?')
      params.push(patch.balanceEnabled ? 1 : 0)
    }
    if (patch.avatar !== undefined) {
      sets.push('avatar = ?')
      params.push(patch.avatar)
    }
    if (sets.length === 0) return this.requireUser(id)

    sets.push('updated_at = ?')
    params.push(patch.updatedAt, id)
    try {
      this.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...params)
    } catch (error) {
      throw mapUniqueName(error, patch.name)
    }
    return this.requireUser(id)
  }

  deleteUser(id: UserId): void {
    // 只删 users 行；balance_entries 是只增不改的审计附本，保留。
    const result = this.run('DELETE FROM users WHERE id = ?', id)
    if (readChanges(result.changes) === 0) {
      throw new UserError('USER_NOT_FOUND', `没有这个用户：#${id}`)
    }
  }

  // ───────────────────────────── 余额 ─────────────────────────────

  getBalance(id: UserId): Balance | undefined {
    const row = this.row('SELECT balance FROM users WHERE id = ?', id)
    if (row === undefined) return undefined
    return readBigInt(requireRow(row, `users[id=${id}]`).balance, `users[id=${id}].balance`)
  }

  /**
   * 改余额 + 记流水，在同一个事务里完成：两者要么都成功，要么都不发生。
   * 返回改动后的余额。允许扣成负数（D11）。
   */
  adjustBalance(id: UserId, delta: Balance, reason: string, actor: string, at: string): Balance {
    return this.transaction(() => {
      const current = this.getBalance(id)
      if (current === undefined) {
        throw new UserError('USER_NOT_FOUND', `没有这个用户：#${id}`)
      }
      const balanceAfter = current + delta
      this.run('UPDATE users SET balance = ?, updated_at = ? WHERE id = ?', balanceAfter, at, id)
      this.run(
        `INSERT INTO balance_entries (user_id, delta, balance_after, reason, actor, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        id,
        delta,
        balanceAfter,
        reason,
        actor,
        at,
      )
      return balanceAfter
    })
  }

  /** 最近的 `limit` 条流水，按发生顺序（时间正序）返回。 */
  listBalanceEntries(id: UserId, limit: number): BalanceEntry[] {
    const rows = this.all(
      `SELECT ${ENTRY_COLUMNS} FROM balance_entries WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
      id,
      limit,
    )
    return rows.reverse().map((row, index) => readEntry(row, `balance_entries[${index}]`))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private requireUser(id: UserId): User {
    const user = this.getUser(id)
    if (user === undefined) {
      throw new UserError('USER_NOT_FOUND', `没有这个用户：#${id}`)
    }
    return user
  }

  private all(sql: string, ...params: SQLInputValue[]): Record<string, SQLOutputValue>[] {
    this.assertOpen()
    try {
      const statement = this.db.prepare(sql)
      statement.setReadBigInts(true)
      return statement.all(...params)
    } catch (error) {
      if (error instanceof UserError) throw error
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
      if (error instanceof UserError) throw error
      throw corrupt(describeError(error))
    }
  }

  private run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    this.assertOpen()
    try {
      return this.db.prepare(sql).run(...params)
    } catch (error) {
      if (error instanceof UserError) throw error
      if (isUniqueConstraint(error)) throw error
      throw corrupt(describeError(error))
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new UserError('USER_STORE_UNREADABLE', '用户数据库已关闭')
    }
  }
}

// ───────────────────────────── 打开与迁移 ─────────────────────────────

function configure(db: DatabaseSync, memory: boolean): void {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA foreign_keys = ON')
  // WAL 只对文件库有意义；内存库会返回 memory。
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
 * 首次建库时导入同目录的旧 `users.json`。
 *
 * 导入是严格解码（沿用 snapshotCodec）且在一个事务里完成：旧数据坏一条就整份不导入，
 * 绝不半截。旧文件保留；DB 已经有数据时直接跳过。
 * 旧快照没有 role 字段：把 id 最小的用户视为「首个注册用户」，补成 admin，
 * 否则升级后没有任何人能进管理台。
 */
function importLegacyFile(db: DatabaseSync, dbFile: string): LegacyUserImport | undefined {
  const legacyPath = join(dirname(dbFile), 'users.json')
  // 配置仍指向旧的 users.json 时，DB 文件本身就是这个路径；不能把它当旧 JSON 读。
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
    if (error instanceof UserError) throw error
    if (error instanceof SyntaxError) {
      throw corrupt(`旧用户文件 ${legacyPath} 不是合法 JSON：${error.message}`)
    }
    throw corrupt(`旧用户文件 ${legacyPath} 无法解码：${describeError(error)}`)
  }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get() as
    | Record<string, SQLOutputValue>
    | undefined
  const entryRows = db.prepare('SELECT COUNT(*) AS n FROM balance_entries').get() as
    | Record<string, SQLOutputValue>
    | undefined
  const existingUsers = readInt(existing?.n ?? 0n, 'users 计数')
  const existingEntries = readInt(entryRows?.n ?? 0n, 'balance_entries 计数')
  if (existingUsers > 0 || existingEntries > 0) return undefined

  const firstId = snapshot.users.reduce<UserId | undefined>(
    (min, user) => (min === undefined || user.id < min ? user.id : min),
    undefined,
  )

  db.exec('BEGIN IMMEDIATE')
  try {
    const insertUser = db.prepare(
      `INSERT INTO users (id, name, status, role, balance, balance_enabled, avatar, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
    )
    for (const user of snapshot.users) {
      insertUser.run(
        user.id,
        user.name,
        user.status,
        user.id === firstId ? 'admin' : 'user',
        user.balance,
        user.createdAt,
        user.updatedAt,
      )
    }

    const insertEntry = db.prepare(
      `INSERT INTO balance_entries (user_id, delta, balance_after, reason, actor, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const entry of snapshot.entries) {
      insertEntry.run(entry.userId, entry.delta, entry.balanceAfter, entry.reason, entry.actor, entry.at)
    }

    // 旧快照的 nextId 可能大于现存最大 id（用户被删过）。ID 不复用是硬语义，
    // 所以把 AUTOINCREMENT 序列抬到 nextId - 1；只抬高，绝不回退。
    const nextSequence = snapshot.nextId - 1
    if (nextSequence > 0) {
      const sequence = db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'users'")
        .get() as Record<string, SQLOutputValue> | undefined
      if (sequence === undefined) {
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('users', ?)").run(nextSequence)
      } else if (readInt(sequence.seq, 'sqlite_sequence.seq') < nextSequence) {
        db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'users'").run(nextSequence)
      }
    }

    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 保留原始错误
    }
    if (error instanceof UserError) throw error
    throw corrupt(`导入旧用户文件 ${legacyPath} 失败：${describeError(error)}`)
  }

  return { users: snapshot.users.length, entries: snapshot.entries.length }
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

function readUser(row: Record<string, SQLOutputValue>, where: string): User {
  const id = readPositiveInt(requireRow(row, where).id, `${where}.id`)
  const name = readStringCell(row.name, `${where}.name`)
  if (name === '') throw corrupt(`${where}.name 不能为空`)
  const status = row.status
  if (status !== 'enabled' && status !== 'banned') {
    throw corrupt(`${where}.status 必须是 enabled 或 banned`)
  }
  const role = row.role
  if (role !== 'admin' && role !== 'user') {
    throw corrupt(`${where}.role 必须是 admin 或 user`)
  }
  return {
    id,
    name,
    status,
    role,
    balance: readBigInt(row.balance, `${where}.balance`),
    balanceEnabled: readBool(row.balance_enabled, `${where}.balance_enabled`),
    avatar: readNullableString(row.avatar, `${where}.avatar`),
    createdAt: readStringCell(row.created_at, `${where}.created_at`),
    updatedAt: readStringCell(row.updated_at, `${where}.updated_at`),
  }
}

function readEntry(row: Record<string, SQLOutputValue>, where: string): BalanceEntry {
  return {
    userId: readPositiveInt(row.user_id, `${where}.user_id`),
    delta: readBigInt(row.delta, `${where}.delta`),
    balanceAfter: readBigInt(row.balance_after, `${where}.balance_after`),
    reason: readStringCell(row.reason, `${where}.reason`),
    actor: readStringCell(row.actor, `${where}.actor`),
    at: readStringCell(row.at, `${where}.at`),
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

function readRowId(value: number | bigint): number {
  const id = readInt(value, 'last_insert_rowid')
  if (id <= 0) throw corrupt('last_insert_rowid 必须是正整数')
  return id
}

function readChanges(value: number | bigint): number {
  return readInt(value, 'changes')
}

function readBigInt(value: SQLOutputValue | undefined, where: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw corrupt(`${where} 必须是整数`)
}

function readBool(value: SQLOutputValue | undefined, where: string): boolean {
  const parsed = readBigInt(value, where)
  if (parsed === 0n) return false
  if (parsed === 1n) return true
  throw corrupt(`${where} 必须是 0 或 1`)
}

function readStringCell(value: SQLOutputValue | undefined, where: string): string {
  if (typeof value !== 'string') throw corrupt(`${where} 必须是字符串`)
  return value
}

function readNullableString(value: SQLOutputValue | undefined, where: string): string | null {
  if (value === null || value === undefined) return null
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

function mapUniqueName(error: unknown, name: string | undefined): unknown {
  if (isUniqueConstraint(error)) {
    if (name === undefined) {
      return new UserError('USER_NAME_TAKEN', '用户名已被占用')
    }
    return new UserError('USER_NAME_TAKEN', `用户名已被占用：${name}`)
  }
  return error
}

function classifyOpenError(error: unknown): UserError {
  if (isNotADatabase(error)) return corrupt(describeError(error))
  return unreadable(error)
}

function isNotADatabase(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const message = String((error as SqliteLikeError).message ?? '')
  return /not a database|file is encrypted|malformed/i.test(message)
}

function corrupt(detail: string): UserError {
  return new UserError('USER_STORE_CORRUPT', `用户数据库损坏：${detail}`)
}

function unreadable(error: unknown): UserError {
  return new UserError('USER_STORE_UNREADABLE', `读取用户数据库失败：${describeError(error)}`)
}
