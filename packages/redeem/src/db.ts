/**
 * 兑换码的 SQLite 存储层（Node 内置 `node:sqlite`，零第三方依赖）。
 *
 * 三条硬事实决定了这里的写法：
 *
 * 1. **明文不落库**：只存规范化明文的 sha256 与末 4 位掩码。库里没有任何列能还原出码。
 * 2. **金额是 bigint 整数微元**：读语句开 `setReadBigInts(true)`、写语句绑定 bigint，
 *    全程不经过 `number` 的浮点表示。
 * 3. **兑换是跨库操作**（`users.db` 与 `redeem.db` 不在同一个事务里），所以「占位」用
 *    条件更新（CAS）而不是锁；这里只提供语句与单库事务，跨库顺序由 service 决定。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { RedeemError } from './errors.ts'
import type {
  RedeemBatchView,
  RedeemCodeStatus,
  RedeemCodeView,
  RedeemKind,
} from './types.ts'

/** 当前 schema 版本；写进 `PRAGMA user_version`。 */
export const REDEEM_SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS redeem_batches (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'balance',
  amount_micro INTEGER NOT NULL,
  total        INTEGER NOT NULL,
  notes        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);
CREATE TABLE IF NOT EXISTS redeem_codes (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL,
  code_hash    TEXT NOT NULL UNIQUE,
  code_mask    TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'balance',
  amount_micro INTEGER NOT NULL,
  status       TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT,
  reserved_at  TEXT,
  reserved_by  TEXT,
  redeemed_at  TEXT,
  redeemed_by  TEXT,
  disabled_by  TEXT,
  disabled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_batch ON redeem_codes(batch_id);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_status ON redeem_codes(status);
CREATE INDEX IF NOT EXISTS idx_redeem_codes_redeemed_by ON redeem_codes(redeemed_by);
`

const BATCH_COLUMNS = [
  'id',
  'name',
  'kind',
  'amount_micro',
  'total',
  'notes',
  'created_by',
  'created_at',
  'expires_at',
] as const

const CODE_COLUMNS = [
  'id',
  'batch_id',
  'code_hash',
  'code_mask',
  'kind',
  'amount_micro',
  'status',
  'created_at',
  'expires_at',
  'reserved_at',
  'reserved_by',
  'redeemed_at',
  'redeemed_by',
  'disabled_by',
  'disabled_at',
] as const

/** 兑换码表的可读视图（不含哈希、不含明文）。 */
const CODE_SELECT = `
SELECT c.id AS id,
       c.batch_id AS batch_id,
       c.code_mask AS code_mask,
       c.kind AS kind,
       c.amount_micro AS amount_micro,
       c.status AS status,
       c.created_at AS created_at,
       c.expires_at AS expires_at,
       c.reserved_at AS reserved_at,
       c.reserved_by AS reserved_by,
       c.redeemed_at AS redeemed_at,
       c.redeemed_by AS redeemed_by,
       c.disabled_by AS disabled_by,
       c.disabled_at AS disabled_at,
       b.name AS batch_name
  FROM redeem_codes c
  LEFT JOIN redeem_batches b ON b.id = c.batch_id
`

const BATCH_SELECT = `
SELECT b.id AS id,
       b.name AS name,
       b.kind AS kind,
       b.amount_micro AS amount_micro,
       b.total AS total,
       b.notes AS notes,
       b.created_by AS created_by,
       b.created_at AS created_at,
       b.expires_at AS expires_at,
       (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch_id = b.id) AS code_count,
       (SELECT COUNT(*) FROM redeem_codes c WHERE c.batch_id = b.id AND c.status = 'used') AS used_count
  FROM redeem_batches b
`

/** SQLite 原始行；列名与查询别名一致。 */
export interface RedeemBatchRow {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly amount_micro: bigint
  readonly total: bigint
  readonly notes: string | null
  readonly created_by: string
  readonly created_at: string
  readonly expires_at: string | null
  readonly code_count?: bigint
  readonly used_count?: bigint
}

export interface RedeemCodeRow {
  readonly id: string
  readonly batch_id: string
  readonly code_hash?: string
  readonly code_mask: string
  readonly kind: string
  readonly amount_micro: bigint
  readonly status: string
  readonly created_at: string
  readonly expires_at: string | null
  readonly reserved_at: string | null
  readonly reserved_by: string | null
  readonly redeemed_at: string | null
  readonly redeemed_by: string | null
  readonly disabled_by: string | null
  readonly disabled_at: string | null
  readonly batch_name?: string | null
}

/**
 * 打开（必要时创建并迁移）兑换码数据库。
 *
 * `dataPath` 省略或为 `:memory:` 时用内存库，进程退出即丢——测试与内嵌用法走这条。
 * 打开就做一次结构校验与完整性检查：坏库必须立刻失败，而不是等到第一次兑换。
 */
export function openRedeemDatabase(path: string | undefined): DatabaseSync {
  const location = path === undefined || path.trim() === '' ? ':memory:' : path
  const memory = location === ':memory:'
  if (!memory) mkdirSync(dirname(location), { recursive: true })

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(location, { timeout: 5_000 })
    configure(db, memory)
    migrate(db)
    verifyColumns(db, 'redeem_batches', BATCH_COLUMNS)
    verifyColumns(db, 'redeem_codes', CODE_COLUMNS)
    verifyIntegrity(db)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 打开失败的连接不需要再报错。
    }
    if (error instanceof RedeemError) throw error
    throw corrupt(`数据库损坏或无法打开：${describeError(error)}`)
  }
}

/** 在一个立即写事务里执行同步函数。任何异常都回滚。 */
export function immediateTransaction<T>(db: DatabaseSync, task: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = task()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误。
    }
    throw error
  }
}

/** 读语句：整型列（金额、计数）一律以 bigint 返回，调用方再按宽度收窄。 */
export function prepareRead(db: DatabaseSync, sql: string): ReturnType<DatabaseSync['prepare']> {
  const statement = db.prepare(sql)
  statement.setReadBigInts(true)
  return statement
}

export function toBatchView(row: RedeemBatchRow): RedeemBatchView {
  return {
    id: row.id,
    name: row.name,
    kind: toKind(row.kind),
    amountMicro: row.amount_micro,
    total: readCount(row.total, 'redeem_batches.total'),
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    codeCount: readCount(row.code_count ?? 0n, 'redeem_batches.code_count'),
    usedCount: readCount(row.used_count ?? 0n, 'redeem_batches.used_count'),
  }
}

export function toCodeView(row: RedeemCodeRow): RedeemCodeView {
  return {
    id: row.id,
    batchId: row.batch_id,
    batchName: row.batch_name ?? null,
    codeMask: row.code_mask,
    kind: toKind(row.kind),
    amountMicro: row.amount_micro,
    status: toStatus(row.status),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reservedAt: row.reserved_at,
    reservedBy: row.reserved_by,
    redeemedAt: row.redeemed_at,
    redeemedBy: row.redeemed_by,
    disabledBy: row.disabled_by,
    disabledAt: row.disabled_at,
  }
}

export function batchSelect(): string {
  return BATCH_SELECT
}

export function codeSelect(): string {
  return CODE_SELECT
}

/** 行对象；未知形状一律当不存在（`get()` 不给行时返回 undefined）。 */
export function asRow<T>(value: Record<string, SQLOutputValue> | undefined): T | undefined {
  return value as T | undefined
}

/** bigint 计数 → number；超出安全整数范围视为数据损坏。 */
export function readCount(value: SQLOutputValue | undefined, where: string): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw corrupt(`${where} 超出安全整数范围`)
    }
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw corrupt(`${where} 不是非负整数`)
}

/** `run()` 返回的 changes：SQLite 用 number 或 bigint，统一收成 number。 */
export function readChanges(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw corrupt('changes 超出安全整数范围')
    }
    return Number(value)
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  throw corrupt('changes 不是非负整数')
}

export function corrupt(detail: string): RedeemError {
  return new RedeemError('REDEEM_STORE_CORRUPT', `兑换码数据库损坏：${detail}`)
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toKind(value: string): RedeemKind {
  if (value !== 'balance') throw corrupt(`未知的额度维度：${value}`)
  return 'balance'
}

function toStatus(value: string): RedeemCodeStatus {
  if (value === 'enabled' || value === 'redeeming' || value === 'used' || value === 'disabled') {
    return value
  }
  throw corrupt(`未知的兑换码状态：${value}`)
}

function configure(db: DatabaseSync, memory: boolean): void {
  db.exec('PRAGMA busy_timeout = 5000')
  // WAL 只对文件库有意义；内存库会返回 memory。
  if (!memory) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get()
  const version = readVersion(row?.user_version)
  if (version > REDEEM_SCHEMA_VERSION) {
    throw corrupt(`数据库版本 ${version} 高于本插件支持的 ${REDEEM_SCHEMA_VERSION}`)
  }
  db.exec(SCHEMA)
  // v1 之后加的列：reserved_by 记录「谁占了这个码」，人工核查时要看它。
  // 幂等的补列，旧库升级不需要重建表。
  ensureColumn(db, 'redeem_codes', 'reserved_by', 'TEXT')
  if (version < REDEEM_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${REDEEM_SCHEMA_VERSION}`)
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const names = columnNames(db, table)
  if (!names.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  const names = new Set<string>()
  for (const row of rows) {
    if (typeof row.name === 'string') names.add(row.name)
  }
  return names
}

function verifyColumns(db: DatabaseSync, table: string, required: readonly string[]): void {
  const names = columnNames(db, table)
  const missing = required.filter((column) => !names.has(column))
  if (missing.length > 0) throw corrupt(`${table} 表缺少列：${missing.join(', ')}`)
}

function verifyIntegrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all()
  if (rows.length !== 1) throw corrupt('integrity_check 返回值数量异常')
  const value = Object.values(rows[0] ?? {})[0]
  if (value !== 'ok') throw corrupt(`integrity_check 未通过：${String(value)}`)
}

function readVersion(value: SQLOutputValue | undefined): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  throw corrupt('user_version 不合法')
}
