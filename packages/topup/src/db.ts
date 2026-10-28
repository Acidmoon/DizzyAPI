/**
 * 充值订单的 SQLite 存储层（Node 内置 `node:sqlite`，零第三方依赖）。
 *
 * 三条硬事实决定了这里的写法：
 *
 * 1. **`order_no` 唯一**：并发创建靠主键冲突收敛（调用方重试换号），不靠进程内锁。
 * 2. **金额是 bigint 整数微元**：读语句开 `setReadBigInts(true)`、写语句绑 bigint，
 *    全程不经过 `number` 的浮点表示。
 * 3. **到账是跨库操作**（`users.db` 与 `topup.db` 不在同一个事务里）：所以状态流转用
 *    条件更新（CAS）而不是锁；单库语句在这里，跨库顺序由 service 决定。
 *
 * 时间一律存 UTC ISO 字符串（`toISOString()`），字典序即时间序，比较不需要再解析。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { TopupError } from './errors.ts'
import type { TopupOrderStatus, TopupOrderView, TopupStats } from './types.ts'

/** 当前 schema 版本；写进 `PRAGMA user_version`。 */
export const TOPUP_SCHEMA_VERSION = 1

export const TOPUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  order_no           TEXT    PRIMARY KEY,
  user_id            INTEGER NOT NULL,
  amount_micro       INTEGER NOT NULL,
  status             TEXT    NOT NULL,
  provider           TEXT    NOT NULL,
  provider_order_id  TEXT,
  instructions       TEXT,
  note               TEXT,
  created_at         TEXT    NOT NULL,
  expires_at         TEXT    NOT NULL,
  paid_at            TEXT,
  canceled_at        TEXT,
  updated_at         TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_order
  ON orders (provider, provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_user   ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_paid   ON orders (paid_at);
`

const ROW_COLUMNS = [
  'order_no',
  'user_id',
  'amount_micro',
  'status',
  'provider',
  'provider_order_id',
  'instructions',
  'note',
  'created_at',
  'expires_at',
  'paid_at',
  'canceled_at',
  'updated_at',
] as const

export interface OrderRow {
  readonly order_no: string
  readonly user_id: bigint
  readonly amount_micro: bigint
  readonly status: string
  readonly provider: string
  readonly provider_order_id: string | null
  readonly instructions: string | null
  readonly note: string | null
  readonly created_at: string
  readonly expires_at: string
  readonly paid_at: string | null
  readonly canceled_at: string | null
  readonly updated_at: string
}

/** 新订单的写入形状（service 已经算好金额与有效期）。 */
export interface NewOrder {
  readonly orderNo: string
  readonly userId: number
  readonly amountMicro: bigint
  readonly provider: string
  readonly instructions: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string
}

export interface OrderFilter {
  readonly status?: TopupOrderStatus
  readonly userId?: number
  readonly fromMs?: number
  readonly toMs?: number
}

/** 打开（必要时创建并迁移）充值订单库。`:memory:` / 空路径用于测试。 */
export function openTopupDatabase(path: string | undefined): DatabaseSync {
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
    if (error instanceof TopupError) throw error
    throw corrupt(`数据库损坏或无法打开：${describeError(error)}`)
  }
}

/** 订单读写；所有语句都在打开的那一个连接上执行（一个数据一个写者）。 */
export class TopupStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 插入一笔新订单。`order_no` 撞车时抛错，由调用方换号重试。 */
  insert(order: NewOrder): void {
    const statement = this.db.prepare(`
      INSERT INTO orders (
        order_no, user_id, amount_micro, status, provider, provider_order_id,
        instructions, note, created_at, expires_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, ?, ?, ?)
    `)
    statement.run(
      order.orderNo,
      order.userId,
      order.amountMicro,
      order.provider,
      order.instructions,
      order.note,
      order.createdAt,
      order.expiresAt,
      order.createdAt,
    )
  }

  find(orderNo: string): OrderRow | undefined {
    const statement = this.db.prepare(`SELECT ${ROW_COLUMNS.join(', ')} FROM orders WHERE order_no = ?`)
    statement.setReadBigInts(true)
    return asRow<OrderRow>(statement.get(orderNo))
  }

  /** 用户的订单（只读自己的；分页按创建时间倒序）。 */
  listForUser(userId: number, limit: number, offset: number): readonly OrderRow[] {
    const statement = this.db.prepare(`
      SELECT ${ROW_COLUMNS.join(', ')} FROM orders
       WHERE user_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?
    `)
    statement.setReadBigInts(true)
    return statement.all(userId, limit, offset) as unknown as OrderRow[]
  }

  countForUser(userId: number): number {
    return this.count({ userId })
  }

  list(filter: OrderFilter, limit: number, offset: number): readonly OrderRow[] {
    const where = filterSql(filter)
    const statement = this.db.prepare(`
      SELECT ${ROW_COLUMNS.join(', ')} FROM orders
       WHERE ${where.sql}
       ORDER BY created_at DESC, rowid DESC
       LIMIT ? OFFSET ?
    `)
    statement.setReadBigInts(true)
    return statement.all(...where.params, limit, offset) as unknown as OrderRow[]
  }

  count(filter: OrderFilter): number {
    const where = filterSql(filter)
    const statement = this.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where.sql}`)
    statement.setReadBigInts(true)
    const row = asRow<{ readonly n: bigint }>(statement.get(...where.params))
    return row === undefined ? 0 : toSafeNumber(row.n)
  }

  /**
   * 抢占到账：`pending → paid`。
   *
   * 过期判断也写进 WHERE：即使定时器还没把状态刷成 `expired`，过期订单也不能到账。
   * 返回 false = 没抢到（已到账 / 已取消 / 已过期 / 并发输家）。
   */
  claimPaid(orderNo: string, now: string): boolean {
    const statement = this.db.prepare(`
      UPDATE orders
         SET status = 'paid', paid_at = ?, updated_at = ?
       WHERE order_no = ? AND status = 'pending' AND expires_at > ?
    `)
    return Number(statement.run(now, now, orderNo, now).changes) === 1
  }

  /** 加余额失败的回退：`paid → pending`（钱没到账，订单可以重新确认）。 */
  releasePaid(orderNo: string, now: string): boolean {
    const statement = this.db.prepare(`
      UPDATE orders
         SET status = 'pending', paid_at = NULL, updated_at = ?
       WHERE order_no = ? AND status = 'paid'
    `)
    return Number(statement.run(now, orderNo).changes) === 1
  }

  /** 取消：`pending → canceled`。 */
  cancel(orderNo: string, now: string): boolean {
    const statement = this.db.prepare(`
      UPDATE orders
         SET status = 'canceled', canceled_at = ?, updated_at = ?
       WHERE order_no = ? AND status = 'pending'
    `)
    return Number(statement.run(now, now, orderNo).changes) === 1
  }

  /** 用户取消：只能取消**自己的** pending 订单。 */
  cancelForUser(userId: number, orderNo: string, now: string): boolean {
    const statement = this.db.prepare(`
      UPDATE orders
         SET status = 'canceled', canceled_at = ?, updated_at = ?
       WHERE order_no = ? AND user_id = ? AND status = 'pending'
    `)
    return Number(statement.run(now, now, orderNo, userId).changes) === 1
  }

  /** 把到期的 pending 订单刷成 expired，返回本次刷了多少条。 */
  expireDue(now: string): number {
    const statement = this.db.prepare(`
      UPDATE orders
         SET status = 'expired', updated_at = ?
       WHERE status = 'pending' AND expires_at <= ?
    `)
    return Number(statement.run(now, now).changes)
  }

  /** 记录 provider 单号（真实渠道用；manual 永远是 null）。 */
  setProviderOrderId(orderNo: string, providerOrderId: string, now: string): void {
    this.db
      .prepare('UPDATE orders SET provider_order_id = ?, updated_at = ? WHERE order_no = ?')
      .run(providerOrderId, now, orderNo)
  }

  stats(nowMs: number): TopupStats {
    const now = new Date(nowMs)
    const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const dayStart = new Date(dayStartMs).toISOString()
    const dayEnd = new Date(dayStartMs + 86_400_000).toISOString()
    const today = this.paidTotals(dayStart, dayEnd)
    const total = this.paidTotals('', '')
    const statement = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
        COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired
      FROM orders
    `)
    statement.setReadBigInts(true)
    const row = asRow<{ readonly pending: bigint; readonly expired: bigint }>(statement.get())
    return {
      todayPaidCount: today.count,
      todayPaidMicros: today.micros,
      totalPaidCount: total.count,
      totalPaidMicros: total.micros,
      pendingCount: row === undefined ? 0 : toSafeNumber(row.pending),
      expiredCount: row === undefined ? 0 : toSafeNumber(row.expired),
    }
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // 连接可能已经关闭；卸载路径不抛错。
    }
  }

  private paidTotals(fromIso: string, toIso: string): { count: number; micros: bigint } {
    const statement = this.db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(amount_micro), 0) AS micros
        FROM orders
       WHERE status = 'paid'
         AND (? = '' OR (paid_at >= ? AND paid_at < ?))
    `)
    statement.setReadBigInts(true)
    const row = asRow<{ readonly n: bigint; readonly micros: bigint }>(
      statement.get(fromIso, fromIso, toIso),
    )
    return { count: row === undefined ? 0 : toSafeNumber(row.n), micros: row?.micros ?? 0n }
  }
}

export function toView(row: OrderRow, providerLabel: string): TopupOrderView {
  return {
    orderNo: row.order_no,
    userId: toSafeNumber(row.user_id),
    amountMicro: row.amount_micro,
    status: toStatus(row.status),
    provider: row.provider,
    providerLabel,
    providerOrderId: row.provider_order_id,
    instructions: row.instructions,
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    canceledAt: row.canceled_at,
  }
}

export function isOrderStatus(value: unknown): value is TopupOrderStatus {
  return value === 'pending' || value === 'paid' || value === 'canceled' || value === 'expired'
}

function toStatus(value: string): TopupOrderStatus {
  if (!isOrderStatus(value)) throw corrupt(`未知的订单状态：${value}`)
  return value
}

function filterSql(filter: OrderFilter): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = ['1 = 1']
  const params: SQLInputValue[] = []
  if (filter.status !== undefined) {
    clauses.push('status = ?')
    params.push(filter.status)
  }
  if (filter.userId !== undefined) {
    clauses.push('user_id = ?')
    params.push(filter.userId)
  }
  if (filter.fromMs !== undefined) {
    clauses.push('created_at >= ?')
    params.push(new Date(filter.fromMs).toISOString())
  }
  if (filter.toMs !== undefined) {
    clauses.push('created_at < ?')
    params.push(new Date(filter.toMs).toISOString())
  }
  return { sql: clauses.join(' AND '), params }
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
  if (!memory) db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get()
  const version = readVersion(row?.user_version)
  if (version > TOPUP_SCHEMA_VERSION) {
    throw corrupt(`数据库版本 ${version} 高于本插件支持的 ${TOPUP_SCHEMA_VERSION}`)
  }
  db.exec(TOPUP_SCHEMA)
  if (version < TOPUP_SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${TOPUP_SCHEMA_VERSION}`)
}

function verifyColumns(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA table_info(orders)').all()
  const names = new Set<string>()
  for (const row of rows) {
    if (typeof row.name === 'string') names.add(row.name)
  }
  const missing = ROW_COLUMNS.filter((column) => !names.has(column))
  if (missing.length > 0) throw corrupt(`orders 表缺少列：${missing.join(', ')}`)
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

function corrupt(detail: string): TopupError {
  return new TopupError('TOPUP_STORE_CORRUPT', `充值订单库损坏：${detail}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
