/**
 * 用量插件（服务名 `usage`）。
 *
 * 定位：**用量事实的唯一存储者**。Go 在请求结束时把记录放进环形缓冲，本插件定期经
 * 控制桥拉取（`usage.since`），幂等落 SQLite；查询侧按 `pricing` 服务的当前价格表
 * 在读取时算费用。
 *
 * 几条纪律：
 * - 上行用**轮询**而不是事件推送：断线可补拉，TS 重启也不会丢。
 * - `req_id` 唯一，写入一律 `INSERT OR IGNORE`；`{epoch, lastSeq}` 与记录同一事务落库。
 * - 只存 token 事实；费用读取时按 `pricing.quote()` 现算，不落库（AGENTS.md §8）。
 * - token / 费用在内部用 BigInt 聚合，对外 token 是 number（不会超过 2^53），
 *   费用是十进制字符串（整数微元）。
 * - 不 inject `accountPriority` / `pricing`：它们被禁用时本插件仍要能查历史。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { FiberState, Service, type Context, type Logger } from 'cordis'
import { USAGE_CONFIG_SCHEMA, USAGE_DEFAULTS, type ResolvedUsageConfig, type UsageConfig } from './config.ts'
import { openUsageDatabase } from './db.ts'
import { UsageError } from './errors.ts'
import type {
  PricingPort,
  TokenCountsLike,
  UsageEntry,
  UsageListPage,
  UsageQuery,
  UsageRow,
  UsageServiceLike,
  UsageStats,
  UsageStatus,
  UsageSummary,
  UsageTokenTotals,
} from './types.ts'

const DAY_MS = 86_400_000
const DEFAULT_LIST_LIMIT = 20
const MAX_LIST_LIMIT = 200
const DEFAULT_EXPORT_LIMIT = 5_000
const MAX_EXPORT_LIMIT = 20_000
const PRUNE_BATCH = 1_000

/** `usage.since` 的返回形状（控制消息载荷，不 import account-priority 的实现）。 */
interface UsageSinceResultLike {
  readonly epoch: string
  readonly firstSeq: number
  readonly lastSeq: number
  readonly dropped: number
  readonly records: readonly UsageEntry[]
}

interface AccountPrioritySeam {
  usageSince(params: {
    readonly epoch?: string
    readonly afterSeq?: number
    readonly limit?: number
  }): Promise<UsageSinceResultLike>
}

/** 一轮轮询的可观察结果；公开给测试，Timer 不关心返回值。 */
export interface UsagePollOutcome {
  readonly status: 'ok' | 'skipped' | 'error'
  readonly epochChanged: boolean
  /** `firstSeq` 与本地 lastSeq 之间缺了多少条（环形缓冲回绕）。 */
  readonly gap: number
  readonly ingested: number
}

interface TotalsAccumulator {
  requests: bigint
  inputTokens: bigint
  outputTokens: bigint
  cacheReadTokens: bigint
  cacheWriteTokens: bigint
  reasoningTokens: bigint
  totalTokens: bigint
  costMicros: bigint
}

const ROW_COLUMNS = `
  id, req_id, started_at_ms, user_id, api_key_id, api_key_name, profile, account_id,
  model, upstream_model, protocol, upstream_protocol, stream, status, error_code,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
  total_tokens, usage_present, usage_complete, duration_ms, client_ip, attempts
`

export class UsageService extends Service implements UsageServiceLike {
  static Config = USAGE_CONFIG_SCHEMA

  /**
   * 不 inject account-priority 与 pricing：它们被禁用时，用量服务仍应能提供历史查询
   * （D5：禁用某个插件只关闭它自己的入口）。两者都在运行期按需解析。
   */
  static inject: readonly string[] = []

  static catalog = {
    capabilities: ['usage-log', 'usage-query'],
    events: [
      {
        name: 'usage/account-used',
        description: '一轮用量落库后报告「这些上游账号刚被用过」（集合化，节流由监听方做）',
        payload: 'accountIds: string[], at: string',
      },
    ],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: 'SQLite 用量库（token 事实，不含费用）' }],
    shapes: {
      UsageRow: {
        description: '一条请求用量；costMicros 是读取时按价格表算的',
        fields: {
          id: { type: 'integer' },
          reqId: { type: 'string' },
          userId: { type: 'integer' },
          apiKeyName: { type: 'string' },
          model: { type: 'string' },
          inputTokens: { type: 'integer' },
          outputTokens: { type: 'integer' },
          cacheReadTokens: { type: 'integer' },
          cacheWriteTokens: { type: 'integer' },
          totalTokens: { type: 'integer' },
          costMicros: { type: 'string' },
          durationMs: { type: 'integer' },
          clientIp: { type: 'string', optional: true },
          startedAt: { type: 'string' },
        },
      },
    },
  } as const

  readonly config: ResolvedUsageConfig
  private readonly logger: Logger
  private db: DatabaseSync | undefined
  private ready = false
  private polling = false
  private pollErrorLogged = false
  private epoch: string | null = null
  private lastSeq = 0
  private pollTimer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined

  constructor(ctx: Context, config: UsageConfig | ResolvedUsageConfig = {}) {
    super(ctx, 'usage')
    this.config = {
      dataPath: config.dataPath ?? USAGE_DEFAULTS.dataPath,
      retentionDays: config.retentionDays ?? USAGE_DEFAULTS.retentionDays,
      pollIntervalMs: config.pollIntervalMs ?? USAGE_DEFAULTS.pollIntervalMs,
      maxBatch: config.maxBatch ?? USAGE_DEFAULTS.maxBatch,
    }
    this.logger = ctx.logger('usage')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.db = openUsageDatabase(resolveDataPath(this.ctx, this.config.dataPath))
    this.loadMeta()
    this.ready = true
    this.logger.info(
      `用量插件已装载：存储 ${this.config.dataPath ?? ':memory:'}；保留 ${this.config.retentionDays} 天`,
    )

    this.pollTimer = setInterval(() => {
      void this.pollOnce()
    }, this.config.pollIntervalMs)
    this.pollTimer.unref()

    this.pruneTimer = setInterval(() => {
      try {
        this.pruneExpired()
      } catch (error) {
        this.logger.warn(`清理过期用量失败：${describeError(error)}`)
      }
    }, DAY_MS)
    this.pruneTimer.unref()

    // 启动时也清一次；失败不影响装载（下次定时器还会再试）。
    try {
      this.pruneExpired()
    } catch (error) {
      this.logger.warn(`启动时清理过期用量失败：${describeError(error)}`)
    }

    // 注册即副作用：插件卸载时数据库连接与定时器跟着回收（AGENTS.md D5）。
    this.ctx.effect(() => () => this.close(), 'usage.db')

    yield () => {
      this.ready = false
    }
  }

  // ───────────────────────────────── 写

  /** 接收一条记录；同一 `reqId` 重复写入只保留第一行。 */
  ingest(entry: UsageEntry): void {
    this.assertReady()
    this.insertEntries([entry])
  }

  /**
   * 拉取一轮 `usage.since` 并落库。
   *
   * 公开是为了单测能直接驱动轮询；日常由 `pollIntervalMs` 定时器调用。
   * account-priority / 桥不在时返回 `skipped`，不抛错。
   */
  async pollOnce(): Promise<UsagePollOutcome> {
    const priority = this.accountPrioritySeam()
    if (priority === undefined) {
      return { status: 'skipped', epochChanged: false, gap: 0, ingested: 0 }
    }
    if (this.polling) {
      return { status: 'skipped', epochChanged: false, gap: 0, ingested: 0 }
    }

    this.polling = true
    try {
      const params =
        this.epoch === null
          ? { limit: this.config.maxBatch }
          : { epoch: this.epoch, afterSeq: this.lastSeq, limit: this.config.maxBatch }
      const result = await priority.usageSince(params)

      const epochChanged = this.epoch !== null && this.epoch !== result.epoch
      const previousLast = epochChanged ? 0 : this.lastSeq
      if (epochChanged) {
        this.logger.warn(`用量 epoch 变化：${this.epoch ?? '(空)'} → ${result.epoch || '(空)'}，lastSeq 重置为 0`)
      }

      const firstSeq = integerOf(result.firstSeq)
      const gap = firstSeq > previousLast + 1 ? firstSeq - previousLast - 1 : 0
      if (gap > 0) {
        this.logger.warn(
          `用量序号缺口：缺少 ${gap} 条（firstSeq=${firstSeq}，本地 lastSeq=${previousLast}），继续落库`,
        )
      }

      // 游标只推进到**实际拿到的记录**，不能用 result.lastSeq：它是环形缓冲的尾部，
      // 当 maxBatch 小于积压量时，后面的记录这一轮根本没返回，用尾部会把它们永久跳过。
      let lastSeq = previousLast
      for (const record of result.records) {
        lastSeq = Math.max(lastSeq, integerOf(record.seq))
      }

      const ingested = this.insertEntries(result.records, { epoch: result.epoch, lastSeq })
      this.epoch = result.epoch
      this.lastSeq = lastSeq
      this.pollErrorLogged = false
      return { status: 'ok', epochChanged, gap, ingested }
    } catch (error) {
      if (!this.pollErrorLogged) {
        this.logger.warn(`拉取用量失败（本轮跳过，后续继续重试）：${describeError(error)}`)
        this.pollErrorLogged = true
      }
      return { status: 'error', epochChanged: false, gap: 0, ingested: 0 }
    } finally {
      this.polling = false
    }
  }

  /**
   * 删除超过保留期的记录，分批删到删空。
   *
   * 公开给单测；定时器每天调用一次。返回删除条数。
   */
  pruneExpired(nowMs: number = Date.now()): number {
    const db = this.db
    if (db === undefined) return 0
    const retentionDays = this.config.retentionDays ?? USAGE_DEFAULTS.retentionDays
    const cutoff = nowMs - retentionDays * DAY_MS
    // 不用 `DELETE ... LIMIT`（需要 SQLite 编译选项）；用子查询选取一批 id，通用且可循环。
    const statement = db.prepare(
      'DELETE FROM usage_records WHERE id IN (SELECT id FROM usage_records WHERE started_at_ms < ? LIMIT ' +
        PRUNE_BATCH +
        ')',
    )
    let removed = 0
    for (;;) {
      const changes = Number(statement.run(cutoff).changes)
      removed += changes
      if (changes < PRUNE_BATCH) break
    }
    if (removed > 0) {
      this.logger.info(`已清理 ${removed} 条过期用量（保留 ${this.config.retentionDays} 天）`)
    }
    return removed
  }

  // ───────────────────────────────── 读

  list(query: UsageQuery): UsageListPage {
    this.assertReady()
    const db = this.requireDb()
    const limit = clampLimit(query.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT)
    const where = queryWhere(query, true)
    const statement = db.prepare(
      `SELECT ${ROW_COLUMNS} FROM usage_records WHERE ${where.sql} ORDER BY id DESC LIMIT ?`,
    )
    const rows = statement.all(...where.params, limit + 1) as Record<string, SQLOutputValue>[]
    const pricing = this.pricingSeam()
    const page = rows.slice(0, limit).map((row) => withCost(rowOf(row), pricing))
    const nextCursor = rows.length > limit && page.length > 0 ? (page[page.length - 1] as UsageRow).id : null
    return { items: page, nextCursor }
  }

  summary(query: UsageQuery): UsageSummary {
    this.assertReady()
    const pricing = this.pricingSeam()
    const totalsAcc = this.foldAggregates(query, ['model'], pricing).get('') ?? emptyAccumulator()

    const dailyAcc = this.foldAggregates(query, ['day', 'model'], pricing, (row) => String(row.day ?? ''))
    const daily = [...dailyAcc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, acc]) => ({ date, ...totalsOf(acc) }))

    const modelAcc = this.foldAggregates(query, ['model'], pricing, (row) => String(row.model ?? ''))
    const models = [...modelAcc.entries()]
      .map(([model, acc]) => ({ model, ...totalsOf(acc) }))
      .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))

    return { totals: totalsOf(totalsAcc), daily, models }
  }

  stats(nowMs: number = Date.now()): UsageStats {
    this.assertReady()
    const pricing = this.pricingSeam()
    const now = new Date(nowMs)
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const todayQuery: UsageQuery = { fromMs: todayStart, toMs: todayStart + DAY_MS }
    const totalQuery: UsageQuery = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER }
    const seriesQuery: UsageQuery = { fromMs: todayStart - 29 * DAY_MS, toMs: todayStart + DAY_MS }

    const todayAcc = this.foldAggregates(todayQuery, ['model'], pricing).get('') ?? emptyAccumulator()
    const totalAcc = this.foldAggregates(totalQuery, ['model'], pricing).get('') ?? emptyAccumulator()

    const seriesAcc = this.foldAggregates(seriesQuery, ['day', 'model'], pricing, (row) => String(row.day ?? ''))
    const series = [...seriesAcc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, acc]) => ({ date, ...totalsOf(acc) }))

    const modelAcc = this.foldAggregates(totalQuery, ['model'], pricing, (row) => String(row.model ?? ''))
    const models = [...modelAcc.entries()]
      .map(([model, acc]) => ({ model, ...totalsOf(acc) }))
      .sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model))

    const userAcc = this.foldAggregates(totalQuery, ['user_id', 'model'], pricing, (row) =>
      String(row.user_id ?? '0'),
    )
    const topUsers = [...userAcc.entries()]
      .map(([userId, acc]) => ({ userId: Number(userId), ...totalsOf(acc) }))
      .sort((a, b) => b.requests - a.requests || a.userId - b.userId)
      .slice(0, 10)

    return { today: totalsOf(todayAcc), total: totalsOf(totalAcc), series, models, topUsers }
  }

  exportRows(query: UsageQuery, limit?: number): readonly UsageRow[] {
    this.assertReady()
    const db = this.requireDb()
    const capped = clampLimit(limit, DEFAULT_EXPORT_LIMIT, MAX_EXPORT_LIMIT)
    const where = queryWhere(query, false)
    const statement = db.prepare(
      `SELECT ${ROW_COLUMNS} FROM usage_records WHERE ${where.sql} ORDER BY id DESC LIMIT ?`,
    )
    const rows = statement.all(...where.params, capped) as Record<string, SQLOutputValue>[]
    const pricing = this.pricingSeam()
    return rows.map((row) => withCost(rowOf(row), pricing))
  }

  status(): UsageStatus {
    return {
      records: this.countRecords(),
      epoch: this.epoch,
      lastSeq: this.lastSeq,
      polling: this.polling,
      pricingAvailable: this.pricingSeam() !== undefined,
    }
  }

  // ───────────────────────────────── 内部：存储

  private insertEntries(entries: readonly UsageEntry[], meta?: { epoch: string; lastSeq: number }): number {
    const db = this.requireDb()
    if (entries.length === 0 && meta === undefined) return 0

    const insert = db.prepare(`
      INSERT OR IGNORE INTO usage_records (
        req_id, epoch, seq, started_at_ms, day, user_id, api_key_id, api_key_name, profile,
        account_id, model, upstream_model, protocol, upstream_protocol, stream, status,
        error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, usage_present, usage_complete, duration_ms, client_ip,
        attempts, ingested_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
    const upsertMeta = db.prepare(
      'INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )

    const now = Date.now()
    // 只汇报「这一轮真的新落库」的行所对应的账号：重复 req_id 不算一次使用。
    const usedAccounts = new Set<string>()
    let inserted = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        const startedAtMs = parseStartedAt(entry)
        const values: SQLInputValue[] = [
          requireRequestId(entry),
          typeof entry.epoch === 'string' ? entry.epoch : '',
          integerOf(entry.seq),
          startedAtMs,
          new Date(startedAtMs).toISOString().slice(0, 10),
          integerOf(entry.userId),
          typeof entry.keyId === 'string' ? entry.keyId : '',
          typeof entry.keyName === 'string' ? entry.keyName : '',
          typeof entry.profile === 'string' ? entry.profile : '',
          typeof entry.accountId === 'string' ? entry.accountId : '',
          typeof entry.model === 'string' ? entry.model : '',
          optionalText(entry.upstreamModel),
          typeof entry.protocol === 'string' ? entry.protocol : '',
          optionalText(entry.upstreamProtocol),
          entry.stream === true ? 1 : 0,
          integerOf(entry.status),
          optionalText(entry.errorCode),
          integerOf(entry.inputTokens),
          integerOf(entry.outputTokens),
          integerOf(entry.cacheReadTokens),
          integerOf(entry.cacheWriteTokens),
          integerOf(entry.reasoningTokens),
          integerOf(entry.totalTokens),
          entry.usagePresent === true ? 1 : 0,
          entry.usageComplete === false ? 0 : 1,
          integerOf(entry.durationMs),
          optionalText(entry.clientIp),
          integerOf(entry.attempts),
          now,
        ]
        const changes = Number(insert.run(...values).changes)
        inserted += changes
        if (changes === 0) continue
        const accountId = typeof entry.accountId === 'string' ? entry.accountId : ''
        if (accountId !== '') usedAccounts.add(accountId)
      }
      if (meta !== undefined) {
        upsertMeta.run('epoch', meta.epoch)
        upsertMeta.run('lastSeq', String(meta.lastSeq))
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已经被 SQLite 自动回滚。
      }
      throw error instanceof UsageError
        ? error
        : new UsageError('USAGE_STORE_FAILED', `用量写入失败：${describeError(error)}`)
    }

    // 落库成功后再报告：监听方（account-admin）据此节流汇报 `lastUsedAt`。
    // 这里不直接写 identity——usage 不是账号记录的写者（AGENTS.md 2.4）。
    if (usedAccounts.size > 0) {
      this.ctx.emit('usage/account-used', {
        accountIds: [...usedAccounts],
        at: new Date(now).toISOString(),
      })
    }
    return inserted
  }

  private loadMeta(): void {
    const db = this.requireDb()
    const rows = db.prepare('SELECT key, value FROM usage_meta').all() as Record<string, SQLOutputValue>[]
    for (const row of rows) {
      const key = String(row.key ?? '')
      const value = String(row.value ?? '')
      if (key === 'epoch') this.epoch = value
      else if (key === 'lastSeq') this.lastSeq = integerOf(value)
    }
  }

  private countRecords(): number {
    const db = this.db
    if (db === undefined) return 0
    const row = db.prepare('SELECT COUNT(*) AS n FROM usage_records').get() as
      | Record<string, SQLOutputValue>
      | undefined
    return row === undefined ? 0 : integerOf(row.n)
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new UsageError('USAGE_NOT_READY', '用量插件尚未装载完成')
    return this.db
  }

  // ───────────────────────────────── 内部：聚合与费用

  /**
   * 按指定维度（必须包含 model，费用要按模型单价算）聚合 token，再折成目标分组。
   *
   * `keyOf` 省略时结果只有 `''` 一个键（全量 totals）。分组费用是先把每个模型的
   * 费用算出来再相加，不能拿混合了不同模型的 token 去套一个单价。
   */
  private foldAggregates(
    query: UsageQuery,
    dimensions: readonly string[],
    pricing: PricingPort | undefined,
    keyOf?: (row: Record<string, SQLOutputValue>) => string,
  ): Map<string, TotalsAccumulator> {
    const db = this.requireDb()
    const where = queryWhere(query, false)
    const statement = db.prepare(`
      SELECT ${dimensions.join(', ')},
             COUNT(*) AS requests,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
             COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
             COALESCE(SUM(total_tokens), 0) AS total_tokens
      FROM usage_records
      WHERE ${where.sql}
      GROUP BY ${dimensions.join(', ')}
    `)
    statement.setReadBigInts(true)
    const rows = statement.all(...where.params) as Record<string, SQLOutputValue>[]

    const groups = new Map<string, TotalsAccumulator>()
    for (const row of rows) {
      const model = String(row.model ?? '')
      const inputTokens = toBigInt(row.input_tokens)
      const outputTokens = toBigInt(row.output_tokens)
      const cacheReadTokens = toBigInt(row.cache_read_tokens)
      const cacheWriteTokens = toBigInt(row.cache_write_tokens)
      const costMicros = quoteCostMicros(pricing, model, {
        inputTokens: Number(inputTokens),
        outputTokens: Number(outputTokens),
        cacheReadTokens: Number(cacheReadTokens),
        cacheWriteTokens: Number(cacheWriteTokens),
      })
      const key = keyOf === undefined ? '' : keyOf(row)
      const acc = groups.get(key) ?? emptyAccumulator()
      acc.requests += toBigInt(row.requests)
      acc.inputTokens += inputTokens
      acc.outputTokens += outputTokens
      acc.cacheReadTokens += cacheReadTokens
      acc.cacheWriteTokens += cacheWriteTokens
      acc.reasoningTokens += toBigInt(row.reasoning_tokens)
      acc.totalTokens += toBigInt(row.total_tokens)
      acc.costMicros += costMicros
      groups.set(key, acc)
    }
    return groups
  }

  /** 运行期解析价格服务，不 inject（D5）。 */
  private pricingSeam(): PricingPort | undefined {
    const impl = this.ctx.root.reflect._getImpl('pricing', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<PricingPort> | undefined
    return typeof value?.quote === 'function' ? (value as PricingPort) : undefined
  }

  /** 运行期解析 account-priority 服务，不 inject（D5）。 */
  private accountPrioritySeam(): AccountPrioritySeam | undefined {
    const impl = this.ctx.root.reflect._getImpl('accountPriority', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<AccountPrioritySeam> | undefined
    return typeof value?.usageSince === 'function' ? (value as AccountPrioritySeam) : undefined
  }

  private close(): void {
    this.ready = false
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
    }
    const db = this.db
    this.db = undefined
    if (db !== undefined) {
      try {
        db.close()
      } catch {
        // 连接可能已经关闭；卸载路径不抛错。
      }
    }
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new UsageError('USAGE_NOT_READY', '用量插件尚未装载完成')
    }
  }
}

// ───────────────────────────────── 纯函数

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === '' || path === ':memory:' || isAbsolute(path)) {
    return path === '' ? undefined : path
  }
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function queryWhere(query: UsageQuery, withCursor: boolean): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = ['started_at_ms >= ?', 'started_at_ms < ?']
  const params: SQLInputValue[] = [query.fromMs, query.toMs]
  if (query.userId !== undefined) {
    clauses.push('user_id = ?')
    params.push(query.userId)
  }
  if (query.apiKeyId !== undefined) {
    clauses.push('api_key_id = ?')
    params.push(query.apiKeyId)
  }
  if (query.model !== undefined) {
    clauses.push('model = ?')
    params.push(query.model)
  }
  if (query.status !== undefined) {
    clauses.push('status = ?')
    params.push(query.status)
  }
  if (withCursor && query.cursor !== undefined) {
    clauses.push('id < ?')
    params.push(query.cursor)
  }
  return { sql: clauses.join(' AND '), params }
}

function rowOf(row: Record<string, SQLOutputValue>): UsageRow {
  const startedAtMs = integerOf(row.started_at_ms)
  return {
    id: integerOf(row.id),
    reqId: String(row.req_id ?? ''),
    userId: integerOf(row.user_id),
    apiKeyId: String(row.api_key_id ?? ''),
    apiKeyName: String(row.api_key_name ?? ''),
    profile: String(row.profile ?? ''),
    accountId: String(row.account_id ?? ''),
    model: String(row.model ?? ''),
    upstreamModel: nullableText(row.upstream_model),
    protocol: String(row.protocol ?? ''),
    upstreamProtocol: nullableText(row.upstream_protocol),
    stream: integerOf(row.stream) === 1,
    status: integerOf(row.status),
    errorCode: nullableText(row.error_code),
    inputTokens: integerOf(row.input_tokens),
    outputTokens: integerOf(row.output_tokens),
    cacheReadTokens: integerOf(row.cache_read_tokens),
    cacheWriteTokens: integerOf(row.cache_write_tokens),
    reasoningTokens: integerOf(row.reasoning_tokens),
    totalTokens: integerOf(row.total_tokens),
    usagePresent: integerOf(row.usage_present) === 1,
    usageComplete: integerOf(row.usage_complete) === 1,
    durationMs: integerOf(row.duration_ms),
    clientIp: nullableText(row.client_ip),
    attempts: integerOf(row.attempts),
    startedAt: new Date(startedAtMs).toISOString(),
    costMicros: '0',
  }
}

function withCost(row: UsageRow, pricing: PricingPort | undefined): UsageRow {
  return {
    ...row,
    costMicros: quoteCostMicros(pricing, row.model, {
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      cacheWriteTokens: row.cacheWriteTokens,
    }).toString(),
  }
}

function quoteCostMicros(
  pricing: PricingPort | undefined,
  model: string,
  tokens: TokenCountsLike,
): bigint {
  if (pricing === undefined) return 0n
  try {
    return BigInt(pricing.quote(model, tokens))
  } catch {
    // 价格表里没有这个模型 / 价格条目损坏时按 0 显示；不能让一条记录毁掉整页。
    return 0n
  }
}

function emptyAccumulator(): TotalsAccumulator {
  return {
    requests: 0n,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    reasoningTokens: 0n,
    totalTokens: 0n,
    costMicros: 0n,
  }
}

function totalsOf(acc: TotalsAccumulator): UsageTokenTotals {
  return {
    // 正常 token 远小于 2^53；夹到安全整数边界只是防御坏数据。
    requests: safeNumber(acc.requests),
    inputTokens: safeNumber(acc.inputTokens),
    outputTokens: safeNumber(acc.outputTokens),
    cacheReadTokens: safeNumber(acc.cacheReadTokens),
    cacheWriteTokens: safeNumber(acc.cacheWriteTokens),
    reasoningTokens: safeNumber(acc.reasoningTokens),
    totalTokens: safeNumber(acc.totalTokens),
    costMicros: acc.costMicros.toString(),
  }
}

function safeNumber(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (value > max) return Number.MAX_SAFE_INTEGER
  if (value < -max) return Number.MIN_SAFE_INTEGER
  return Number(value)
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

function integerOf(value: unknown): number {
  if (typeof value === 'bigint') {
    return value > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(value)
  }
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.trunc(parsed))
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return 0n
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function nullableText(value: unknown): string | null {
  const text = value === null || value === undefined ? '' : String(value)
  return text === '' ? null : text
}

function parseStartedAt(entry: UsageEntry): number {
  const parsed = Date.parse(typeof entry.startedAt === 'string' ? entry.startedAt : '')
  if (!Number.isFinite(parsed)) {
    throw new UsageError('USAGE_STORE_FAILED', `用量记录的时间不合法：${String(entry.startedAt)}`)
  }
  return parsed
}

function requireRequestId(entry: UsageEntry): string {
  const value = typeof entry.requestId === 'string' ? entry.requestId : ''
  if (value === '') throw new UsageError('USAGE_STORE_FAILED', '用量记录缺少 requestId')
  return value
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
