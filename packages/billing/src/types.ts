/**
 * 结算插件的对外形状。
 *
 * 三条事实：
 * - **金额一律 bigint 整数微元**（1 元 = 1_000_000 微元），内部换 BigInt，绝无浮点。
 * - **价格事实归 `pricing`**：本插件只经 `pricing.quote()` / `pricing.get()` 取数复算，
 *   不接受调用方传进来的金额（Go 传来的只有 token 事实）。
 * - **钱只经 `user.adjustBalance(...)` 变动**：`user` 是余额唯一写者，本插件只提交增量。
 */

/** 结算状态机：pending →（CAS）→ settling → settled；无价 / 无用户 / 失败 / 待核查是终态。 */
export type SettleStatus =
  | 'pending'
  | 'settling'
  | 'settled'
  | 'no-price'
  | 'no-user'
  | 'failed'
  | 'review'

/** 管理面查询可以额外用 `problem` 一次拿到「失败 / 待核查 / 结算中残留」。 */
export type SettleFilter = SettleStatus | 'problem'

/** 一条待结算的用量事实（来自 usage 的一轮拉取；不含任何金额）。 */
export interface SettleCandidate {
  readonly requestId: string
  /** 用户 id（Go 侧是字符串，这里照样收，内部再收窄成整数）。 */
  readonly userId: string
  readonly accountId: string
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** 请求开始时间（ISO）；结算日按它的 UTC 日期分组。 */
  readonly startedAt: string
}

/** 一轮结算的计数结果。`chargedMicros` 是这一轮**新增**的扣费额。 */
export interface SettleBatchResult {
  readonly records: number
  readonly settled: number
  readonly noPrice: number
  readonly noUser: number
  readonly failed: number
  readonly review: number
  readonly skipped: number
  readonly chargedMicros: bigint
}

/** 单条结算记录（管理面视图）。 */
export interface SettleRecordView {
  readonly reqId: string
  readonly userId: number
  readonly accountId: string
  readonly model: string
  /** 请求发生日（UTC，`YYYY-MM-DD`）。 */
  readonly day: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** 已扣费用（整数微元）。 */
  readonly costMicro: bigint
  /** 扣费后余额为负（后付费透支）：稳定布尔事实，管理面据此查「余额不足」。 */
  readonly overdrawn: boolean
  /** 扣费之后的用户余额（整数微元）；没扣款时为 null。 */
  readonly balanceAfter: bigint | null
  readonly status: SettleStatus
  readonly note: string | null
  readonly attempts: number
  readonly startedAt: string
  readonly claimedAt: string | null
  readonly settledAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SettleQuery {
  readonly status?: SettleFilter
  readonly userId?: number
  readonly limit?: number
  readonly offset?: number
}

export interface SettlePage {
  readonly items: readonly SettleRecordView[]
  readonly total: number
}

/** 按状态聚合的计数与累计扣费。 */
export interface SettleTotals {
  readonly records: number
  readonly settled: number
  readonly noPrice: number
  readonly noUser: number
  readonly failed: number
  readonly review: number
  readonly settling: number
  /** 扣费后余额为负的笔数（透支；不是状态，是 settled 的一个事实）。 */
  readonly overdrawn: number
  readonly chargedMicros: bigint
  /** 今天（按请求发生日，UTC）的扣费额。 */
  readonly todayChargedMicros: bigint
}

export interface SettleDailyPoint {
  readonly date: string
  readonly records: number
  readonly settled: number
  readonly chargedMicros: bigint
}

export interface SettleModelPoint {
  readonly model: string
  readonly records: number
  readonly chargedMicros: bigint
}

export interface SettleSummary {
  readonly totals: SettleTotals
  readonly daily: readonly SettleDailyPoint[]
  readonly models: readonly SettleModelPoint[]
}

/** 本插件对外的服务面（usage 调 settle，api / web 调只读的两个）。 */
export interface BillingServiceLike {
  settle(records: readonly SettleCandidate[]): Promise<SettleBatchResult>
  list(actor: string, query?: SettleQuery): SettlePage
  summary(actor: string, nowMs?: number): SettleSummary
}

/** 扣费时记在余额流水里的调用方名字；同时是 app.yml 的 `balanceWriters` 白名单项。 */
export const BILLING_ACTOR = '@dizzyapi/plugin-billing'

/** 管理面分页上限（与其它插件同量级）。 */
export const SETTLE_LIST_DEFAULT_LIMIT = 50
export const SETTLE_LIST_MAX_LIMIT = 200
