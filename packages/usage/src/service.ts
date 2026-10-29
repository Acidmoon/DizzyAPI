/**
 * 用量插件（服务名 `usage`）。
 *
 * 定位：**用量事实的唯一存储者**。Go 在请求结束时把记录放进环形缓冲，本插件定期经
 * 控制桥拉取（`usage.since`），幂等落 SQLite；查询侧按 `pricing` 服务的当前价格表
 * 在读取时算费用。
 *
 * 几条纪律：
 * - 上行用**轮询**而不是事件推送：断线可补拉，TS 重启也不会丢。
 * - 一轮的顺序固定为 **拉取 → 落库 → 结算 → 推进游标**：结算由 `billing` 服务做
 *   （`reqId` 幂等），结算抛错就**不推进游标**，下一轮带同一 `afterSeq` 重放
 *   （记录已在库里，重放只补结算，不会重复扣）。`billing` 不在运行时（被禁用）
 *   不结算，统计照常落库。
 * - `req_id` 唯一，写入一律 `INSERT OR IGNORE`；`{epoch, lastSeq}` 与记录同一事务落库。
 * - **落库失败不推进游标**：失败记警告并下一轮用同一 `afterSeq` 重试；游标只推进到
 *   实际落库成功的最大 seq（`data/usage.db` 只有本插件写，AGENTS.md §2.4）。
 * - **坏记录有界隔离**：连续失败到 `rejectAfterFailures` 后逐条独立事务重试，能插的插、
 *   插不进的进 `usage_rejected`，游标照常前进；被隔离的记录不结算、不扣钱。
 * - 缺口 / epoch 重启 / Go 缓冲健康度（`usage.stats`）都有明确告警，不静默。
 * - 只存 token 事实；费用读取时按 `pricing.quote()` 现算，不落库（AGENTS.md §8）。
 * - token / 费用在内部用 BigInt 聚合，对外 token 是 number（不会超过 2^53），
 *   费用是十进制字符串（整数微元）。
 * - 不 inject `accountPriority` / `pricing` / `billing`：它们被禁用时本插件仍要能查历史
 *   （D5：禁用只关闭它自己的入口）。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { FiberState, Service, type Context, type Logger } from 'cordis'
import { USAGE_CONFIG_SCHEMA, USAGE_DEFAULTS, type ResolvedUsageConfig, type UsageConfig } from './config.ts'
import { openUsageDatabase } from './db.ts'
import { UsageError } from './errors.ts'
import type {
  BillingPort,
  PricingPort,
  SettleBatchOutcomeLike,
  SettleCandidateLike,
  TokenCountsLike,
  UsageEntry,
  UsageListPage,
  UsageQuery,
  UsageRejectedPage,
  UsageRejectedQuery,
  UsageRejectedRow,
  UsageRejectedStatus,
  UsageReplayResult,
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
const DEFAULT_REJECTED_LIMIT = 20
const MAX_REJECTED_LIMIT = 200
const PRUNE_BATCH = 1_000
/** 失败重试时每多少轮再报一次警（1s 一轮，避免刷屏又不静默）。 */
const POLL_FAILURE_LOG_EVERY = 30
const REJECTED_STATUSES: readonly UsageRejectedStatus[] = ['pending', 'ignored', 'replayed']

/** `usage.since` 的返回形状（控制消息载荷，不 import account-priority 的实现）。 */
interface UsageSinceResultLike {
  readonly epoch: string
  readonly firstSeq: number
  readonly lastSeq: number
  readonly dropped: number
  readonly records: readonly UsageEntry[]
}

/** `usage.stats` 的返回形状：Go 环形缓冲的容量与投递健康度（整数）。 */
interface UsageStatsResultLike {
  readonly epoch: string
  readonly capacity: number
  readonly size: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly dropped: number
  readonly gap: number
}

interface AccountPrioritySeam {
  usageSince(params: {
    readonly epoch?: string
    readonly afterSeq?: number
    readonly limit?: number
  }): Promise<UsageSinceResultLike>
  /**
   * 可选：只在异常路径上调用（缺口 / 连续失败）。老版本门面没有这个方法时，
   * 告警只是少一段缓冲上下文，不影响轮询与落库。
   */
  usageStats?(): Promise<UsageStatsResultLike>
}

/** 一轮轮询的可观察结果；公开给测试，Timer 不关心返回值。 */
export interface UsagePollOutcome {
  readonly status: 'ok' | 'skipped' | 'error'
  readonly epochChanged: boolean
  /** `firstSeq` 与本地 lastSeq 之间缺了多少条（环形缓冲回绕）。 */
  readonly gap: number
  readonly ingested: number
  /** 本轮被隔离的坏记录条数（0 = 正常）；被隔离的记录**没有**进明细、也不能结算。 */
  readonly rejected: number
  /**
   * 本轮**实际落库成功**的记录：正常路径是整批，隔离路径是逐条成功的那些。
   *
   * 结算钩子（`billing.settle`）只能拿这个数组，绝不能拿整批 `result.records`：
   * 否则被隔离的记录会被"静默扣钱"。
   */
  readonly persisted: readonly UsageEntry[]
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
  total_tokens, usage_present, usage_complete, duration_ms, ttft_ms, client_ip, attempts
`

export class UsageService extends Service implements UsageServiceLike {
  static Config = USAGE_CONFIG_SCHEMA

  /**
   * 不 inject account-priority / pricing / billing：它们被禁用时，用量服务仍应能提供历史查询
   * （D5：禁用某个插件只关闭它自己的入口）。三者都在运行期按需解析。
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
    storage: [
      {
        key: 'dataPath',
        kind: 'file',
        description:
          'SQLite 用量库：usage_records 明细 + usage_rejected 坏记录隔离区（都不含费用；隔离记录不结算）',
      },
    ],
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
          ttftMs: { type: 'integer', optional: true },
          clientIp: { type: 'string', optional: true },
          startedAt: { type: 'string' },
        },
      },
      UsageRejectedRow: {
        description: '被隔离的坏记录；状态是 pending / ignored / replayed，不结算',
        fields: {
          reqId: { type: 'string' },
          epoch: { type: 'string' },
          seq: { type: 'integer' },
          payload: { type: 'string' },
          error: { type: 'string' },
          failures: { type: 'integer' },
          status: { type: 'string' },
          firstFailedAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
    },
  } as const

  readonly config: ResolvedUsageConfig
  private readonly logger: Logger
  private db: DatabaseSync | undefined
  private ready = false
  private polling = false
  private epoch: string | null = null
  private lastSeq = 0
  private pollFailures = 0
  private lastPollError: string | null = null
  private gapRecords = 0
  /** 已经按哪个游标位置报过缺口：落库失败重试时游标不动，不能重复告警/累计。 */
  private gapCountedAtSeq = -1
  /** 同一游标位置上连续落库失败了几轮（与拉取失败分开计数，否则桥抖动会误判坏记录）。 */
  private persistFailures = 0
  private persistFailureSeq = -1
  private pollTimer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined

  constructor(ctx: Context, config: UsageConfig | ResolvedUsageConfig = {}) {
    super(ctx, 'usage')
    this.config = {
      dataPath: config.dataPath ?? USAGE_DEFAULTS.dataPath,
      retentionDays: config.retentionDays ?? USAGE_DEFAULTS.retentionDays,
      pollIntervalMs: config.pollIntervalMs ?? USAGE_DEFAULTS.pollIntervalMs,
      maxBatch: config.maxBatch ?? USAGE_DEFAULTS.maxBatch,
      rejectAfterFailures: config.rejectAfterFailures ?? USAGE_DEFAULTS.rejectAfterFailures,
    }
    this.logger = ctx.logger('usage')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.db = openUsageDatabase(resolveDataPath(this.ctx, this.config.dataPath))
    this.loadMeta()
    this.ready = true
    this.logger.info(
      `用量插件已装载：存储 ${this.config.dataPath ?? ':memory:'}；保留 ${this.config.retentionDays} 天；` +
        `轮询 ${this.config.pollIntervalMs}ms；坏记录连续失败 ${this.config.rejectAfterFailures} 轮后隔离`,
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
   *
  * 可靠性纪律：
   * - **落库失败不推进游标、不推进 epoch**：下一轮带同一个 `afterSeq` 重试，
   *   `req_id` 唯一 + `INSERT OR IGNORE` 让重放幂等；
   * - 失败不吞：记 warning（首轮 + 每 30 轮）并暴露在 `status()` 里；
   * - **有界出口**：同一游标位置连续落库失败达到 `rejectAfterFailures` 轮后，逐条独立事务重试，
   *   插不进的坏记录进 `usage_rejected`、游标照常前进（否则一条坏记录会让结算永久停摆）；
   * - 缺口（`firstSeq > lastSeq+1`）按游标位置只报一次，并尽量带上 Go 缓冲健康度；
   * - epoch 变化（gatewayd 重启）时把游标重置到 0，再按新 epoch 重新对齐。
   */
  async pollOnce(): Promise<UsagePollOutcome> {
    const priority = this.accountPrioritySeam()
    if (priority === undefined) {
      return skippedOutcome()
    }
    if (this.polling) {
      return skippedOutcome()
    }

    this.polling = true
    const failuresBefore = this.pollFailures
    try {
      const params =
        this.epoch === null
          ? { limit: this.config.maxBatch }
          : { epoch: this.epoch, afterSeq: this.lastSeq, limit: this.config.maxBatch }

      let result: UsageSinceResultLike
      try {
        result = await priority.usageSince(params)
      } catch (error) {
        this.recordPollFailure('拉取', error)
        return failedOutcome(false, 0)
      }

      const epochChanged = this.epoch !== null && this.epoch !== result.epoch
      const previousLast = epochChanged ? 0 : this.lastSeq
      if (epochChanged) {
        // 新进程的 seq 从 1 重来，缺口去重标记也要重置（否则第二次重启的缺口会被吞掉）。
        this.gapCountedAtSeq = -1
        this.logger.warn(`用量 epoch 变化：${this.epoch ?? '(空)'} → ${result.epoch || '(空)'}，lastSeq 重置为 0`)
      }

      const firstSeq = integerOf(result.firstSeq)
      const dropped = integerOf(result.dropped)
      const gap = firstSeq > previousLast + 1 ? firstSeq - previousLast - 1 : 0
      if (gap > 0 && this.gapCountedAtSeq !== previousLast) {
        // 落库失败会带着同一个游标重试，所以按「游标位置」只报一次，避免 1s 一条刷屏。
        this.gapCountedAtSeq = previousLast
        this.gapRecords += gap
        await this.warnGap(priority, { gap, firstSeq, previousLast, dropped })
      }

      // 游标只推进到**实际拿到的记录**，不能用 result.lastSeq：它是环形缓冲的尾部，
      // 当 maxBatch 小于积压量时，后面的记录这一轮根本没返回，用尾部会把它们永久跳过。
      let lastSeq = previousLast
      for (const record of result.records) {
        lastSeq = Math.max(lastSeq, integerOf(record.seq))
      }

      let ingested = 0
      let rejected = 0
      let persisted: readonly UsageEntry[] = []
      try {
        // 明细落库**不带游标**：游标必须在结算之后才写（见下面的 advanceCursor）。
        // 结算失败时游标原地不动，下一轮带同一 afterSeq 重放。
        const outcome = this.insertEntries(result.records)
        ingested = outcome.inserted
        persisted = result.records
        this.resetPersistFailures()
      } catch (error) {
        // 不吞错：游标与 epoch 停在原处，下一轮用同一 afterSeq 重试。
        this.recordPollFailure('落库', error)
        if (this.persistFailureSeq !== previousLast) {
          this.persistFailureSeq = previousLast
          this.persistFailures = 0
        }
        this.persistFailures += 1
        if (this.persistFailures < (this.config.rejectAfterFailures ?? USAGE_DEFAULTS.rejectAfterFailures)) {
          return failedOutcome(epochChanged, gap)
        }
        // 到达阈值：走有界出口。逐条独立事务重试，能插的插、插不进的进隔离表，游标照常前进。
        try {
          const isolated = this.isolateBatch(result.records)
          ingested = isolated.ingested
          rejected = isolated.rejected
          persisted = isolated.persisted
          this.resetPersistFailures()
        } catch (isolationError) {
          // 连隔离都写不进去（比如磁盘/锁问题）：仍然不推进游标，下轮整个流程重来。
          this.recordPollFailure('隔离', isolationError)
          return failedOutcome(epochChanged, gap)
        }
      }

      // ── 结算钩子位置（feat/money-settle）──
      // 只对 `persisted` 结算：正常路径是整批，隔离路径是逐条成功的那些。
      // 被隔离的坏记录不能结算、不能扣钱；结算失败必须抛错，游标不得推进。
      const billing = this.billingSeam()
      if (billing !== undefined && persisted.length > 0) {
        const candidates = persisted.map(settleCandidateOf)
        const settleable = candidates.filter((item) => item !== null)
        const invalid = candidates.length - settleable.length
        if (invalid > 0) {
          // 缺 requestId / 时间非法的记录不进结算批次（billing 侧也做同样防御）：
          // 绝不把错抛到整轮——一条坏记录卡死结算和统计，比少扣一笔糟糕得多。
          this.logger.warn(
            `本轮有 ${invalid} 条用量缺少 requestId 或时间非法：已跳过结算（不扣费），` +
              '明细仍在（可见性问题见隔离区）',
          )
        }
        if (settleable.length > 0) {
          try {
            const outcome = await billing.settle(settleable)
            this.reportSettleOutcome(outcome)
          } catch (error) {
            // 结算失败：游标原地不动，下一轮带同一 afterSeq 重放——
            // 记录已在库里（INSERT OR IGNORE 不新增），billing 按 reqId 幂等，不会重复扣。
            this.logger.warn(`结算失败（本轮不推进游标，下一轮重放）：${describeError(error)}`)
            return failedOutcome(epochChanged, gap, ingested, rejected)
          }
        }
      }

      // 最后推进游标：走到这里才算这一轮真的落地（结算成功，或根本没有结算服务）。
      // 游标单独写：结算跨库（billing / user），没法和明细进同一个事务。
      this.advanceCursor(result.epoch, lastSeq)
      this.epoch = result.epoch
      this.lastSeq = lastSeq
      this.pollFailures = 0
      this.lastPollError = null
      if (failuresBefore > 0) {
        this.logger.info(`用量轮询已恢复：此前连续失败 ${failuresBefore} 轮，游标推进到 seq=${lastSeq}`)
      }
      return { status: 'ok', epochChanged, gap, ingested, rejected, persisted }
    } finally {
      this.polling = false
    }
  }

  /** 清空「同一游标位置连续落库失败」计数（落库成功或隔离完成后）。 */
  private resetPersistFailures(): void {
    this.persistFailures = 0
    this.persistFailureSeq = -1
  }

  /**
   * 报告一轮失败：第一条必报，之后每 `POLL_FAILURE_LOG_EVERY` 轮再报一次。
   *
   * 既不能吞错（否则「测试全绿、账上没数据」），也不能 1s 一条刷屏。
   */
  private recordPollFailure(stage: '拉取' | '落库' | '隔离', error: unknown): void {
    this.pollFailures += 1
    this.lastPollError = describeError(error)
    if (this.pollFailures === 1 || this.pollFailures % POLL_FAILURE_LOG_EVERY === 0) {
      this.logger.warn(
        `用量${stage}失败（连续第 ${this.pollFailures} 轮，游标停在 seq=${this.lastSeq}，下一轮重试）：${this.lastPollError}`,
      )
    }
  }

  /**
   * 记缺口告警，并尽量补一段 Go 缓冲上下文。
   *
   * 上下文取不到（桥断开 / 门面没有 `usage.stats`）只是少一句话，不影响告警本身。
   */
  private async warnGap(
    priority: AccountPrioritySeam,
    info: { gap: number; firstSeq: number; previousLast: number; dropped: number },
  ): Promise<void> {
    let context = ''
    if (typeof priority.usageStats === 'function') {
      try {
        const stats = await priority.usageStats()
        context =
          `；Go 缓冲 ${integerOf(stats.size)}/${integerOf(stats.capacity)} 条，` +
          `累计丢弃 ${integerOf(stats.dropped)}（其中真丢 ${integerOf(stats.gap)}）`
      } catch (error) {
        context = `；读取 Go 缓冲状态失败：${describeError(error)}`
      }
    }
    this.logger.warn(
      `用量序号缺口：缺少 ${info.gap} 条（firstSeq=${info.firstSeq}，本地已落库游标=${info.previousLast}，` +
        `Go 累计丢弃 ${info.dropped}）${context}；继续落库`,
    )
  }

  /**
   * 删除超过保留期的记录，分批删到删空。
   *
   * 明细（`usage_records`）按 `started_at_ms` 清，隔离区（`usage_rejected`）另算：
   * **只清 `ignored` 与过了保留期的 `replayed`，`pending` 永不自动清**——
   * 待人工处理的坏记录不能自己消失。两段清理互不影响。
   *
   * 公开给单测；定时器每天调用一次。返回明细删除条数（隔离区删除数见返回值第二个字段）。
   */
  pruneExpired(nowMs: number = Date.now()): { records: number; rejected: number } {
    const db = this.db
    if (db === undefined) return { records: 0, rejected: 0 }
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
    return { records: removed, rejected: this.pruneRejected(cutoff) }
  }

  /**
   * 清理隔离区里已经处理完的过期记录（分批，学 `PRUNE_BATCH`）。
   *
   * 只删 `ignored` 与 `replayed` 且 `updated_at_ms` 早于保留期的那部分；
   * **`pending` 永不自动删**：它要等人工「忽略 / 重放」，自己消失就等于静默免单。
   */
  private pruneRejected(cutoffMs: number): number {
    const db = this.db
    if (db === undefined) return 0
    const statement = db.prepare(
      `DELETE FROM usage_rejected WHERE req_id IN (
         SELECT req_id FROM usage_rejected
         WHERE status IN ('ignored', 'replayed') AND updated_at_ms < ?
         LIMIT ${PRUNE_BATCH}
       )`,
    )
    let removed = 0
    for (;;) {
      const changes = Number(statement.run(cutoffMs).changes)
      removed += changes
      if (changes < PRUNE_BATCH) break
    }
    if (removed > 0) {
      this.logger.info(
        `已清理 ${removed} 条过期隔离记录（ignored / replayed，保留 ${this.config.retentionDays} 天；pending 不自动清）`,
      )
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

  /**
   * 按 `reqId` 取单条明细（详情弹窗用）。
   *
   * 权限在 HTTP 层判（普通用户只能查自己的、管理员可查全部）；这里只做查询，
   * 查不到返回 null。不受时间窗口限制：`req_id` 上有唯一索引，本身就是精确定位。
   */
  get(reqId: string): UsageRow | null {
    this.assertReady()
    const db = this.requireDb()
    const row = db.prepare(
      `SELECT ${ROW_COLUMNS} FROM usage_records WHERE req_id = ?`,
    ).get(reqId) as Record<string, SQLOutputValue> | undefined
    if (row === undefined) return null
    return withCost(rowOf(row), this.pricingSeam())
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
      consecutiveFailures: this.pollFailures,
      lastError: this.lastPollError,
      gapRecords: this.gapRecords,
      rejectedCount: this.countRejected(),
      rejectedPending: this.countRejected('pending'),
    }
  }

  // ───────────────────────────────── 隔离区（坏记录的有界出口）

  /**
   * 隔离区列表（分页 + 计数）。只读。
   *
   * 这些记录**没有**进 `usage_records`、也**不会**被结算；管理面必须能看见，
   * 否则就是静默免单。
   */
  listRejected(query: UsageRejectedQuery = {}): UsageRejectedPage {
    this.assertReady()
    const db = this.requireDb()
    const limit = clampLimit(query.limit, DEFAULT_REJECTED_LIMIT, MAX_REJECTED_LIMIT)
    const offset = clampOffset(query.offset)
    let status: UsageRejectedStatus | undefined
    if (query.status !== undefined) {
      if (!REJECTED_STATUSES.includes(query.status)) {
        throw new UsageError(
          'USAGE_QUERY_INVALID',
          `隔离记录状态只能是 ${REJECTED_STATUSES.join(' / ')}`,
        )
      }
      status = query.status
    }
    const where = status === undefined ? '' : ' WHERE status = ?'
    const params: SQLInputValue[] = status === undefined ? [] : [status]
    const rows = db
      .prepare(`SELECT * FROM usage_rejected${where} ORDER BY updated_at_ms DESC, req_id ASC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Record<string, SQLOutputValue>[]
    const counted = db.prepare(`SELECT COUNT(*) AS n FROM usage_rejected${where}`).get(...params) as
      | Record<string, SQLOutputValue>
      | undefined
    return {
      items: rows.map((row) => this.rejectedRowOf(row)),
      total: counted === undefined ? 0 : integerOf(counted.n),
      pending: this.countRejected('pending'),
    }
  }

  /** 把 pending 的隔离记录标记为 ignored（= 明确放弃这笔未结算的用量）；幂等。 */
  ignoreRejected(reqId: string): void {
    this.assertReady()
    const db = this.requireDb()
    const changes = Number(
      db
        .prepare(
          "UPDATE usage_rejected SET status = 'ignored', updated_at_ms = ? WHERE req_id = ? AND status = 'pending'",
        )
        .run(Date.now(), reqId).changes,
    )
    if (changes > 0) {
      this.logger.info(`隔离记录已忽略：${reqId}（不会结算、也不会再进明细）`)
      return
    }
    const row = db.prepare('SELECT status FROM usage_rejected WHERE req_id = ?').get(reqId) as
      | Record<string, SQLOutputValue>
      | undefined
    if (row === undefined) throw new UsageError('USAGE_REJECTED_NOT_FOUND', `没有这条隔离记录：${reqId}`)
    const status = textOf(row.status)
    if (status === 'ignored') return
    throw new UsageError('USAGE_REJECTED_STATE', `隔离记录已是 ${status}，不能再忽略`)
  }

  /**
   * 按 `req_id` 重放一条隔离记录：用原始载荷重新插入明细，成功则 `pending → replayed`。
   *
   * 幂等：已经是 `replayed` 时直接返回（`inserted: false`），明细靠 `req_id` 唯一约束
   * 不会重复。重放失败时**保持 pending**、更新错误文案并抛错（不会静默丢）。
   *
   * 结算补做（fail-closed）：明细写成功后必须调 `billing.settle([entry])` 补一次结算
   * （`req_id` 幂等）；`billing` 不在运行 → 整体失败（409 语义），不允许「只记明细不扣钱」。
   */
  async replayRejected(reqId: string): Promise<UsageReplayResult> {
    this.assertReady()
    const db = this.requireDb()
    const row = db.prepare('SELECT * FROM usage_rejected WHERE req_id = ?').get(reqId) as
      | Record<string, SQLOutputValue>
      | undefined
    if (row === undefined) throw new UsageError('USAGE_REJECTED_NOT_FOUND', `没有这条隔离记录：${reqId}`)
    const current = this.rejectedRowOf(row)
    if (current.status === 'ignored') {
      throw new UsageError('USAGE_REJECTED_STATE', '已忽略的隔离记录不再重放')
    }
    if (current.status === 'replayed') return { status: 'replayed', inserted: false }

    let entry: UsageEntry
    try {
      const parsed: unknown = JSON.parse(current.payload)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('载荷不是对象')
      entry = parsed as UsageEntry
    } catch (error) {
      throw new UsageError(
        'USAGE_REJECTED_FAILED',
        `隔离记录的原始载荷不可用：${describeError(error)}`,
      )
    }
    if (textOf(entry.requestId) !== reqId) {
      throw new UsageError('USAGE_REJECTED_FAILED', '隔离记录的载荷与 req_id 不一致，拒绝重放')
    }

    try {
      const outcome = this.insertEntries([entry], { emit: false })
      this.emitAccountUsed(outcome.usedAccounts)
      // ── 结算补做（fail-closed）──
      //   1. 明细写成功后调 billing.settle([entry]) 补结算一次（req_id 幂等，重复重放不重复扣）；
      //   2. billing 不在运行 → 整体失败（记录保持 pending，可重试），不允许「只记明细不扣钱」；
      //   3. 位置：结算成功之后才置 replayed。
      await this.settleReplayed([entry])
      db.prepare(
        "UPDATE usage_rejected SET status = 'replayed', updated_at_ms = ? WHERE req_id = ? AND status = 'pending'",
      ).run(Date.now(), reqId)
      this.logger.info(`隔离记录已重放：${reqId}（新增明细 ${outcome.inserted} 条）`)
      return { status: 'replayed', inserted: outcome.inserted > 0 }
    } catch (error) {
      const message = describeError(error)
      db.prepare(
        "UPDATE usage_rejected SET error = ?, updated_at_ms = ? WHERE req_id = ? AND status = 'pending'",
      ).run(message, Date.now(), reqId)
      // 结算插件缺席是**依赖缺席**（503），不是数据冲突：保留原 code，不要压成 409。
      if (error instanceof UsageError && error.code === 'USAGE_SETTLE_UNAVAILABLE') throw error
      throw new UsageError('USAGE_REJECTED_FAILED', `重放失败：${message}`)
    }
  }

  /**
   * 重放后的结算补做：调 `billing.settle([那一条])`（`req_id` 幂等，重复重放不会重复扣）。
   *
   * fail-closed：`billing` 不在运行就抛错，让整个重放失败、记录保持 `pending` 可重试——
   * **不允许**「只记明细不扣钱」的静默降级。
   */
  private async settleReplayed(records: readonly UsageEntry[]): Promise<void> {
    const billing = this.billingSeam()
    if (billing === undefined) {
      throw new UsageError(
        'USAGE_SETTLE_UNAVAILABLE',
        '结算插件未运行：无法为重放的用量补结算（请先启用 billing 插件；不做只记明细不扣钱）',
      )
    }
    const candidates = records.map(settleCandidateOf).filter((item) => item !== null)
    if (candidates.length === 0) {
      throw new UsageError(
        'USAGE_REJECTED_FAILED',
        '重放的用量缺少 requestId 或时间非法：无法结算（请在隔离区忽略这条）',
      )
    }
    const outcome = await billing.settle(candidates)
    this.reportSettleOutcome(outcome)
  }

  // ───────────────────────────────── 内部：存储

  /**
   * 落库一批记录（一个事务）。
   *
   * **不写游标**：游标由 `advanceCursor` 在结算之后单独推进——一轮的顺序固定为
   * 「拉取 → 落库 → 结算 → 推进游标」，游标必须最后写（结算跨库，没法进同一事务；
   * 结算失败时游标原地不动，下一轮带同一 afterSeq 重放）。
   *
   * 返回 `inserted`（真正新增的条数，重复 req_id 是 0）与 `usedAccounts`
   * （只含真的新落库的账号）。`emit: false` 用于隔离区逐条重试：那时要等整批做完再统一发事件，
   * 不能让几百条记录变成几百个 `usage/account-used`。
   */
  private insertEntries(
    entries: readonly UsageEntry[],
    options: { emit?: boolean } = {},
  ): { inserted: number; usedAccounts: readonly string[] } {
    const db = this.requireDb()
    if (entries.length === 0) return { inserted: 0, usedAccounts: [] }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO usage_records (
        req_id, epoch, seq, started_at_ms, day, user_id, api_key_id, api_key_name, profile,
        account_id, model, upstream_model, protocol, upstream_protocol, stream, status,
        error_code, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_tokens, usage_present, usage_complete, duration_ms, ttft_ms,
        client_ip, attempts, ingested_at_ms
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `)
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
          // 首字延迟只有流式请求才有：Go 那边是 omitempty，非流式连键都没有。
          // **缺失必须落 NULL**，不能落 0——0 会被页面当成「首字 0 毫秒」。
          nullableInteger(entry.ttftMs),
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
    if (options.emit !== false) {
      this.emitAccountUsed([...usedAccounts], now)
    }
    return { inserted, usedAccounts: [...usedAccounts] }
  }

  private emitAccountUsed(accountIds: readonly string[], nowMs: number = Date.now()): void {
    if (accountIds.length === 0) return
    this.ctx.emit('usage/account-used', {
      accountIds: [...accountIds],
      at: new Date(nowMs).toISOString(),
    })
  }

  /**
   * 推进游标（epoch + lastSeq），**单独一次事务**。
   *
   * 为什么不在明细那笔事务里：一轮的顺序是「拉取 → 落库 → 结算 → 推进游标」，
   * 结算要跨到 billing / user 两个库（没有事务），所以游标必须最后单独写——
   * 结算失败时这一句根本不执行，游标停在原地，下一轮带同一 afterSeq 重放。
   */
  private advanceCursor(epoch: string, lastSeq: number): void {
    const db = this.requireDb()
    const upsert = db.prepare(
      'INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    db.exec('BEGIN IMMEDIATE')
    try {
      upsert.run('epoch', epoch)
      upsert.run('lastSeq', String(lastSeq))
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 事务可能已经被 SQLite 自动回滚。
      }
      throw error instanceof UsageError
        ? error
        : new UsageError('USAGE_STORE_FAILED', `用量游标写入失败：${describeError(error)}`)
    }
  }

  /**
   * 有界出口：整批落库连续失败到阈值后，逐条独立事务重试。
   *
   * 能插的插（正常记录不受坏记录连累），插不进的写进 `usage_rejected`（一条 req_id 只一行），
   * 最后由调用方推进游标 —— 否则坏记录会让轮询（以及下游结算）永久停摆。
   *
   * 游标由调用方在结算之后统一推进（`advanceCursor`），这里只管逐条落库与隔离。
   * 只在异常路径调用；正常路径仍然整批一个事务。
   */
  private isolateBatch(
    entries: readonly UsageEntry[],
  ): { ingested: number; rejected: number; persisted: readonly UsageEntry[] } {
    const persisted: UsageEntry[] = []
    const usedAccounts = new Set<string>()
    let ingested = 0
    let rejected = 0
    const failures = this.persistFailures

    for (const entry of entries) {
      try {
        const outcome = this.insertEntries([entry], { emit: false })
        ingested += outcome.inserted
        for (const accountId of outcome.usedAccounts) usedAccounts.add(accountId)
        persisted.push(entry)
      } catch (error) {
        rejected += 1
        this.recordRejected(entry, error, failures)
      }
    }

    this.emitAccountUsed([...usedAccounts])
    this.logger.warn(
      `用量落库连续失败 ${failures} 轮，已隔离 ${rejected} 条坏记录（同批 ${persisted.length} 条照常落库）；` +
        '被隔离的记录未进明细、不会结算',
    )
    return { ingested, rejected, persisted }
  }

  /** 把一条坏记录写进隔离区；同一 `req_id` 只有一行（重复隔离只更新原因与次数）。 */
  private recordRejected(entry: UsageEntry, error: unknown, failures: number): void {
    const db = this.requireDb()
    const now = Date.now()
    const reqId = isNonEmptyText(entry.requestId) ? entry.requestId : `missing-req-id:${textOf(entry.epoch)}:${integerOf(entry.seq)}`
    const statement = db.prepare(`
      INSERT INTO usage_rejected (req_id, epoch, seq, payload, error, failures, status, first_failed_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(req_id) DO UPDATE SET
        error = excluded.error,
        failures = excluded.failures,
        updated_at_ms = excluded.updated_at_ms
    `)
    statement.run(
      reqId,
      textOf(entry.epoch),
      integerOf(entry.seq),
      safeJsonOf(entry),
      describeError(error),
      failures,
      now,
      now,
    )
  }

  /** 隔离记录的状态列 → 稳定英文字符串；库里出现未知值时按 pending 处理并返回 undefined 之外的兜底。 */
  private rejectedRowOf(row: Record<string, SQLOutputValue>): UsageRejectedRow {
    const raw = textOf(row.status)
    const status: UsageRejectedStatus =
      raw === 'ignored' || raw === 'replayed' || raw === 'pending' ? raw : 'pending'
    return {
      reqId: String(row.req_id ?? ''),
      epoch: String(row.epoch ?? ''),
      seq: integerOf(row.seq),
      payload: String(row.payload ?? ''),
      error: String(row.error ?? ''),
      failures: integerOf(row.failures),
      status,
      firstFailedAt: new Date(integerOf(row.first_failed_at_ms)).toISOString(),
      updatedAt: new Date(integerOf(row.updated_at_ms)).toISOString(),
    }
  }

  private countRejected(status?: UsageRejectedStatus): number {
    const db = this.db
    if (db === undefined) return 0
    const row = status === undefined
      ? (db.prepare('SELECT COUNT(*) AS n FROM usage_rejected').get() as Record<string, SQLOutputValue> | undefined)
      : (db.prepare('SELECT COUNT(*) AS n FROM usage_rejected WHERE status = ?').get(status) as
          | Record<string, SQLOutputValue>
          | undefined)
    return row === undefined ? 0 : integerOf(row.n)
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

  /**
   * 运行期解析结算服务，**不 inject**：`billing` 被禁用或正在重启时，用量照常落库、
   * 只是不结算（D5：禁用某个插件只关闭它自己的入口，不能让用量历史跟着消失）。
   */
  private billingSeam(): BillingPort | undefined {
    const impl = this.ctx.root.reflect._getImpl('billing', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<BillingPort> | undefined
    return typeof value?.settle === 'function' ? (value as BillingPort) : undefined
  }

  /** 结算的业务结果只记日志：无价 / 无用户 / 待核查都是终态，不阻塞游标推进。 */
  private reportSettleOutcome(outcome: SettleBatchOutcomeLike): void {
    if (outcome.noPrice > 0) {
      this.logger.warn(`有 ${outcome.noPrice} 笔用量因模型没有价格而按 0 结算（未扣费）`)
    }
    if (outcome.noUser > 0) {
      this.logger.warn(`有 ${outcome.noUser} 笔用量没有用户 id，无法扣费（已记 no-user）`)
    }
    if (outcome.failed > 0 || outcome.review > 0) {
      this.logger.warn(
        `结算异常：failed=${outcome.failed} review=${outcome.review}；` +
          '明细见 /admin/billing（这些记录已经消费，不会自动重试）',
      )
    }
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

function skippedOutcome(): UsagePollOutcome {
  return { status: 'skipped', epochChanged: false, gap: 0, ingested: 0, rejected: 0, persisted: [] }
}

function failedOutcome(
  epochChanged: boolean,
  gap: number,
  ingested = 0,
  rejected = 0,
): UsagePollOutcome {
  return { status: 'error', epochChanged, gap, ingested, rejected, persisted: [] }
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), 1_000_000)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * 隔离区的原始载荷。理论上 Go 送来的记录都能序列化；这里只是保证
 * 「记隔离」本身不会因为一条坏记录再抛一次异常。
 */
function safeJsonOf(entry: UsageEntry): string {
  try {
    return JSON.stringify(entry)
  } catch {
    return JSON.stringify({ requestId: textOf(entry.requestId), seq: integerOf(entry.seq) })
  }
}

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
    ttftMs: integerOrNull(row.ttft_ms),
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

/**
 * 上行载荷里的「可空整数」：缺失 / 非数 / ≤0 一律 null。
 *
 * 专门给 `ttftMs` 用：Go 侧 `omitempty` 让非流式请求连键都没有，0 与「没采集」不可区分，
 * 所以只有正数才算采集到。**不能**退回 `integerOf`（它把缺失变成 0）。
 */
function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string') return null
  const parsed = integerOf(value)
  return parsed > 0 ? parsed : null
}

/** 读库时的可空整数：NULL 保持 null（历史记录 / 非流式请求），其余转 number。 */
function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return integerOf(value)
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

/**
 * 把一条用量记录收成结算事实；不合格返回 null（**绝不抛**）。
 * 不合格只有两种：缺 `requestId`（没有幂等键就结算不了）与时间非法（算不出结算日）。
 * 这两类记录不能进结算批次——`.map()` 抛错会让整轮放弃、游标不动，一条坏记录就把
 * 结算和统计一起卡死（billing 侧也做同样防御，双保险）。
 */
function settleCandidateOf(entry: UsageEntry): SettleCandidateLike | null {
  const requestId = isNonEmptyText(entry.requestId) ? entry.requestId : ''
  if (requestId === '') return null
  const startedAtMs = Date.parse(typeof entry.startedAt === 'string' ? entry.startedAt : '')
  if (!Number.isFinite(startedAtMs)) return null
  return {
    requestId,
    userId: typeof entry.userId === 'string' ? entry.userId : String(entry.userId ?? ''),
    accountId: typeof entry.accountId === 'string' ? entry.accountId : '',
    model: typeof entry.model === 'string' ? entry.model : '',
    inputTokens: integerOf(entry.inputTokens),
    outputTokens: integerOf(entry.outputTokens),
    cacheReadTokens: integerOf(entry.cacheReadTokens),
    cacheWriteTokens: integerOf(entry.cacheWriteTokens),
    startedAt: new Date(startedAtMs).toISOString(),
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
