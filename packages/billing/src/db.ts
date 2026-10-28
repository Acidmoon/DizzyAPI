/**
 * 结算账本的 SQLite 存储层（Node 内置 `node:sqlite`，零第三方依赖）。
 *
 * 三条硬事实决定了这里的写法：
 *
 * 1. **`req_id` 是唯一键**：同一笔请求无论被拉取多少次，账本里只有一行；幂等靠它，
 *    不靠调用方记得「这条结算过没有」。
 * 2. **金额是 bigint 整数微元**：读语句开 `setReadBigInts(true)`、写语句直接绑 bigint，
 *    全程不经过 `number` 的浮点表示。
 * 3. **结算跨库**（`users.db` 与 `billing.db` 不在同一个事务里）：所以状态流转用
 *    条件更新（CAS）而不是锁；这里只提供语句与单行原子写，跨库顺序由 service 决定。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { BillingError } from './errors.ts'
import type {
  SettleCandidate,
  SettleFilter,
  SettleRecordView,
  SettleStatus,
} from './types.ts'

/** 当前 schema 版本；写进 `PRAGMA user_version`。 */
export const BILLING_SCHEMA_VERSION = 1

export const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS settle (
  req_id             TEXT    PRIMARY KEY,
  user_id            INTEGER NOT NULL,
  account_id         TEXT    NOT NULL DEFAULT '',
  model              TEXT    NOT NULL DEFAULT '',
  day                TEXT    NOT NULL DEFAULT '',
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micro         INTEGER NOT NULL DEFAULT 0,
  overdrawn          INTEGER NOT NULL DEFAULT 0,
  balance_after      INTEGER,
  status             TEXT    NOT NULL,
  note               TEXT,
  attempts           INTEGER NOT NULL DEFAULT 0,
  started_at         TEXT    NOT NULL,
  claimed_at         TEXT,
  settled_at         TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS settle_status ON settle (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS settle_user   ON settle (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS settle_day    ON settle (day);
`

const ROW_COLUMNS = [
  'req_id',
  'user_id',
  'account_id',
  'model',
  'day',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_micro',
  'overdrawn',
  'balance_after',
  'status',
  'note',
  'attempts',
  'started_at',
  'claimed_at',
  'settled_at',
  'created_at',
  'updated_at',
] as const

export interface SettleRow {
  readonly req_id: string
  readonly user_id: bigint
  readonly account_id: string
  readonly model: string
  readonly day: string
  readonly input_tokens: bigint
  readonly output_tokens: bigint
  readonly cache_read_tokens: bigint
  readonly cache_write_tokens: bigint
  readonly cost_micro: bigint
  readonly overdrawn: bigint
  readonly balance_after: bigint | null
  readonly status: string
  readonly note: string | null
  readonly attempts: bigint
  readonly started_at: string
  readonly claimed_at: string | null
  readonly settled_at: string | null
  readonly created_at: string
  readonly updated_at: string
}

export interface TotalsRow {
  readonly records: bigint
  readonly settled: bigint
  readonly no_price: bigint
  readonly no_user: bigint
  readonly failed: bigint
  readonly review: bigint
  readonly settling: bigint
  readonly overdrawn: bigint
  readonly charged: bigint
}

export interface DailyRow {
  readonly day: string
  readonly records: bigint
  readonly settled: bigint
  readonly charged: bigint
}

export interface ModelRow {
  readonly model: string
  readonly records: bigint
  readonly charged: bigint
}

const SETTLE_STATUSES: readonly SettleStatus[] = [
  'pending',
  'settling',
  'settled',
  'no-price',
  'no-user',
  'failed',
  'review',
]

/** 打开（必要时创建并迁移）结算账本。`:memory:` / 空路径用于测试。 */
export function openBillingDatabase(path: string | undefined): DatabaseSync {
  const location = path === undefined || path.trim() === '' ? ':memory:' : path
  const memory = location === ':memory:'
  if (!memory) mkdirSync(dirname(location), { recursive: true })

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(location, { timeout: 5_000 })
    configure(db, memory)
    migrate(db)
    verifyColumns(db)
    verifyIntegrity(db)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 打开失败的连接不需要再报错。
    }
    if (error instanceof BillingError) throw error
    throw corrupt(`数据库损坏或无法打开：${describeError(error)}`)
  }
}

/** 账本读写；所有语句都在打开的那一个连接上执行（一个数据一个写者）。 */
export class BillingStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 单条记录；不存在返回 undefined。 */
  find(reqId: string): SettleRow | undefined {
    const statement = this.db.prepare(`SELECT ${ROW_COLUMNS.join(', ')} FROM settle WHERE req_id = ?`)
    statement.setReadBigInts(true)
    return asRow<SettleRow>(statement.get(reqId))
  }

  /** 首次见到这笔请求：插入一行 pending。已存在（并发 / 重放）时返回 false。 */
  insertPending(candidate: SettleCandidate, day: string, startedAt: string, now: string): boolean {
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO settle (
        req_id, user_id, account_id, model, day, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, cost_micro, status, note, attempts,
        started_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, 0, ?, ?, ?)
    `)
    const changes = Number(
      statement.run(
        candidate.requestId,
        normalizeUserId(candidate.userId),
        candidate.accountId,
        candidate.model,
        day,
        candidate.inputTokens,
        candidate.outputTokens,
        candidate.cacheReadTokens,
        candidate.cacheWriteTokens,
        startedAt,
        now,
        now,
      ).changes,
    )
    return changes === 1
  }

  /**
   * 抢占：`pending` / `failed` → `settling`，顺手把本轮算出的金额写进去。
   *
   * 返回 false = 没抢到（已经结算过、正在结算、或已是终态）。拿到 true 才可以动钱。
   */
  claim(reqId: string, costMicro: bigint, now: string): boolean {
    const statement = this.db.prepare(`
      UPDATE settle
         SET status = 'settling', cost_micro = ?, claimed_at = ?, updated_at = ?, attempts = attempts + 1
       WHERE req_id = ? AND status IN ('pending', 'failed')
    `)
    return Number(statement.run(costMicro, now, now, reqId).changes) === 1
  }

  /**
   * 收尾：把某行从 `from` 中的任一状态改成 `status`。
   *
   * `settled_at` 由状态决定：终态记 `now`，退回 `pending`（可重试失败）记 NULL，
   * 避免把「上一次失败的时间」误记成结算时间。
   */
  finish(
    reqId: string,
    status: SettleStatus,
    costMicro: bigint,
    note: string | null,
    now: string,
    from: readonly SettleStatus[],
  ): boolean {
    const placeholders = from.map(() => '?').join(', ')
    const settledAt = status === 'pending' ? null : now
    const statement = this.db.prepare(`
      UPDATE settle
         SET status = ?, cost_micro = ?, note = ?, settled_at = ?, updated_at = ?
       WHERE req_id = ? AND status IN (${placeholders})
    `)
    const changes = Number(statement.run(status, costMicro, note, settledAt, now, reqId, ...from).changes)
    return changes === 1
  }

  /**
   * 扣费成功的收尾：`settling → settled`，顺带记下扣费后的余额与是否透支。
   *
   * `overdrawn` 是稳定的布尔事实（余额 < 0，后付费允许），管理面靠它查「余额不足」；
   * `balance_after` 是扣费之后该用户的余额（整数微元），方便对账。
   */
  markSettled(
    reqId: string,
    costMicro: bigint,
    note: string | null,
    now: string,
    overdrawn: boolean,
    balanceAfter: bigint,
  ): boolean {
    const statement = this.db.prepare(`
      UPDATE settle
         SET status = 'settled', cost_micro = ?, note = ?, settled_at = ?, updated_at = ?,
             overdrawn = ?, balance_after = ?
       WHERE req_id = ? AND status = 'settling'
    `)
    return Number(statement.run(costMicro, note, now, now, overdrawn ? 1 : 0, balanceAfter, reqId).changes) === 1
  }

  list(filter: SettleFilter | undefined, limit: number, offset: number): readonly SettleRow[] {
    const where = filterSql(filter)
    const statement = this.db.prepare(`
      SELECT ${ROW_COLUMNS.join(', ')} FROM settle
       WHERE ${where.sql}
       ORDER BY updated_at DESC, rowid DESC
       LIMIT ? OFFSET ?
    `)
    statement.setReadBigInts(true)
    return statement.all(...where.params, limit, offset) as unknown as SettleRow[]
  }

  count(filter: SettleFilter | undefined): number {
    const where = filterSql(filter)
    const statement = this.db.prepare(`SELECT COUNT(*) AS n FROM settle WHERE ${where.sql}`)
    statement.setReadBigInts(true)
    const row = asRow<{ readonly n: bigint }>(statement.get(...where.params))
    return row === undefined ? 0 : toSafeNumber(row.n)
  }

  totals(): TotalsRow {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS records,
             COALESCE(SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END), 0) AS settled,
             COALESCE(SUM(CASE WHEN status = 'no-price' THEN 1 ELSE 0 END), 0) AS no_price,
             COALESCE(SUM(CASE WHEN status = 'no-user' THEN 1 ELSE 0 END), 0) AS no_user,
             COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
             COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) AS review,
             COALESCE(SUM(CASE WHEN status IN ('pending', 'settling') THEN 1 ELSE 0 END), 0) AS settling,
             COALESCE(SUM(overdrawn), 0) AS overdrawn,
             COALESCE(SUM(cost_micro), 0) AS charged
        FROM settle
    `)
    statement.setReadBigInts(true)
    const row = asRow<TotalsRow>(statement.get())
    if (row === undefined) {
      throw new BillingError('BILLING_STORE_CORRUPT', '结算汇总查询没有返回行')
    }
    return row
  }

  daily(fromDay: string): readonly DailyRow[] {
    const statement = this.db.prepare(`
      SELECT day AS day,
             COUNT(*) AS records,
             COALESCE(SUM(CASE WHEN status = 'settled' THEN 1 ELSE 0 END), 0) AS settled,
             COALESCE(SUM(cost_micro), 0) AS charged
        FROM settle
       WHERE day >= ?
       GROUP BY day
       ORDER BY day ASC
    `)
    statement.setReadBigInts(true)
    return statement.all(fromDay) as unknown as DailyRow[]
  }

  models(limit: number): readonly ModelRow[] {
    const statement = this.db.prepare(`
      SELECT model AS model,
             COUNT(*) AS records,
             COALESCE(SUM(cost_micro), 0) AS charged
        FROM settle
       GROUP BY model
       ORDER BY charged DESC, model ASC
       LIMIT ?
    `)
    statement.setReadBigInts(true)
    return statement.all(limit) as unknown as ModelRow[]
  }

  chargedOnDay(day: string): bigint {
    const statement = this.db.prepare('SELECT COALESCE(SUM(cost_micro), 0) AS charged FROM settle WHERE day = ?')
    statement.setReadBigInts(true)
    const row = asRow<{ readonly charged: bigint }>(statement.get(day))
    return row === undefined ? 0n : row.charged
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 连接可能已经关闭；卸载路径不抛错。
    }
  }
}

export function toView(row: SettleRow): SettleRecordView {
  return {
    reqId: row.req_id,
    userId: toSafeNumber(row.user_id),
    accountId: row.account_id,
    model: row.model,
    day: row.day,
    inputTokens: toSafeNumber(row.input_tokens),
    outputTokens: toSafeNumber(row.output_tokens),
    cacheReadTokens: toSafeNumber(row.cache_read_tokens),
    cacheWriteTokens: toSafeNumber(row.cache_write_tokens),
    costMicro: row.cost_micro,
    overdrawn: row.overdrawn === 1n,
    balanceAfter: row.balance_after,
    status: toStatus(row.status),
    note: row.note,
    attempts: toSafeNumber(row.attempts),
    startedAt: row.started_at,
    claimedAt: row.claimed_at,
    settledAt: row.settled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function isSettleStatus(value: unknown): value is SettleStatus {
  return typeof value === 'string' && (SETTLE_STATUSES as readonly string[]).includes(value)
}

function toStatus(value: string): SettleStatus {
  if (!isSettleStatus(value)) throw corrupt(`未知的结算状态：${value}`)
  return value
}

function filterSql(filter: SettleFilter | undefined): { sql: string; params: SQLInputValue[] } {
  if (filter === undefined) return { sql: '1 = 1', params: [] }
  if (filter === 'problem') {
    return { sql: "status IN ('failed', 'review', 'settling')", params: [] }
  }
  if (!isSettleStatus(filter)) throw corrupt(`未知的结算状态过滤：${String(filter)}`)
  return { sql: 'status = ?', params: [filter] }
}

function normalizeUserId(value: string): number {
  const parsed = Number(value)
  // 0 是合法值：没有用户归属的用量照样要落一行账（随后在 service 里判成 no-user）。
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BillingError('BILLING_INPUT_INVALID', `结算记录的用户 id 不合法：${JSON.stringify(value)}`)
  }
  return parsed
}

function asRow<T>(value: Record<string, SQLOutputValue> | undefined): T | undefined {
  return value as T | undefined
}

/** bigint 计数 → number；超出安全整数范围视为数据损坏。 */
function toSafeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw corrupt('计数值超出安全整数范围')
  }
  return Number(value)
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
  if (version > BILLING_SCHEMA_VERSION) {
    throw corrupt(`数据库版本 ${version} 高于本插件支持的 ${BILLING_SCHEMA_VERSION}`)
  }
  db.exec(BILLING_SCHEMA)
  if (version < BILLING_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${BILLING_SCHEMA_VERSION}`)
}

function verifyColumns(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(settle)').all()
  const names = new Set<string>()
  for (const row of rows) {
    if (typeof row.name === 'string') names.add(row.name)
  }
  const missing = ROW_COLUMNS.filter((column) => !names.has(column))
  if (missing.length > 0) throw corrupt(`settle 表缺少列：${missing.join(', ')}`)
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

function corrupt(detail: string): BillingError {
  return new BillingError('BILLING_STORE_CORRUPT', `结算账本损坏：${detail}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
