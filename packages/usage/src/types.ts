/**
 * 用量记录的对外形状。
 *
 * 这里只存 **token 事实**，不存费用：费用由读取方按 `pricing` 服务的当前价格表算。
 * 真实扣费在**拉取时**发生——先经 `billing.settle(records)` 结算，再落统计、推进游标
 * （见 service.ts 的 pollOnce）；查询侧算的费用仍是「按当前价格表应扣多少」。
 *
 * 金额与费用一律用十进制字符串（整数微元），不用 number/BigInt 直接进 JSON。
 */

/** Go 经控制桥送上来的记录（`usage.record` / `usage.since` 的载荷）。 */
export interface UsageEntry {
  readonly seq: number
  readonly epoch: string
  readonly requestId: string
  readonly userId: string
  readonly keyId: string
  readonly keyName: string
  readonly profile: string
  readonly accountId: string
  readonly model: string
  readonly upstreamModel: string
  readonly protocol: string
  readonly upstreamProtocol: string
  readonly stream: boolean
  readonly status: number
  readonly errorCode: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly usagePresent: boolean
  readonly usageComplete: boolean
  readonly durationMs: number
  /**
   * 首字延迟（毫秒）。Go 侧是 `omitempty`：**非流式请求不带这个键**。
   * 缺失 = 没采集到（不是 0 毫秒），落库写 NULL。
   */
  readonly ttftMs?: number
  readonly clientIp: string
  readonly attempts: number
  readonly startedAt: string
}

/** 查询返回的一行；`costMicros` 是读取时按价格表算出来的。 */
export interface UsageRow {
  readonly id: number
  readonly reqId: string
  readonly userId: number
  readonly apiKeyId: string
  readonly apiKeyName: string
  readonly profile: string
  readonly accountId: string
  readonly model: string
  readonly upstreamModel: string | null
  readonly protocol: string
  readonly upstreamProtocol: string | null
  readonly stream: boolean
  readonly status: number
  readonly errorCode: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly usagePresent: boolean
  readonly usageComplete: boolean
  readonly durationMs: number
  /** 首字延迟（毫秒）；null = 没采集到（非流式请求 / 历史记录），页面显示「—」。 */
  readonly ttftMs: number | null
  readonly clientIp: string | null
  readonly attempts: number
  readonly startedAt: string
  /** 应扣费用（整数微元，十进制字符串）；没配价格时是 "0"。 */
  readonly costMicros: string
}

export interface UsageQuery {
  /** 时间窗口：`[fromMs, toMs)`，按记录的开始时间过滤。 */
  readonly fromMs: number
  readonly toMs: number
  /** 不给 = 不限用户（只有管理员面会这样查）。 */
  readonly userId?: number
  readonly apiKeyId?: string
  readonly model?: string
  readonly status?: number
  /** keyset 分页：只返回 id < cursor 的记录。 */
  readonly cursor?: number
  readonly limit?: number
}

export interface UsageTokenTotals {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly costMicros: string
}

/** 兼容旧名字：页面与 API 都把它当「一组用量数字」。 */
export type UsageTotals = UsageTokenTotals

export interface UsageDailyPoint extends UsageTokenTotals {
  /** `YYYY-MM-DD`（UTC；与 `/api/usage` 现有的 dateOf 口径一致）。 */
  readonly date: string
}

export interface UsageModelBreakdown extends UsageTokenTotals {
  readonly model: string
}

export interface UsageUserBreakdown extends UsageTokenTotals {
  readonly userId: number
}

export interface UsageSummary {
  readonly totals: UsageTotals
  readonly daily: readonly UsageDailyPoint[]
  readonly models: readonly UsageModelBreakdown[]
}

export interface UsageListPage {
  readonly items: readonly UsageRow[]
  /** 下一页 cursor；null = 没有更多。 */
  readonly nextCursor: number | null
}

export interface UsageStats {
  readonly today: UsageTotals
  readonly total: UsageTotals
  readonly series: readonly UsageDailyPoint[]
  readonly models: readonly UsageModelBreakdown[]
  readonly topUsers: readonly UsageUserBreakdown[]
}

export interface UsageStatus {
  readonly records: number
  readonly epoch: string | null
  readonly lastSeq: number
  readonly polling: boolean
  readonly pricingAvailable: boolean
  /** 连续失败的轮询轮数；0 = 最近一轮成功（落库失败会一直重试，游标不动）。 */
  readonly consecutiveFailures: number
  /** 最近一轮失败的原因；成功后清空。 */
  readonly lastError: string | null
  /** 累计观测到的序号缺口条数：这些记录在 Go 缓冲里被覆盖、已经读不回来了。 */
  readonly gapRecords: number
  /** 隔离区里的记录总数（pending + ignored + replayed）。 */
  readonly rejectedCount: number
  /** 隔离区里还没处理的坏记录数（status = pending）；这些记录**没有**进明细、没有结算。 */
  readonly rejectedPending: number
}

/** 隔离记录的状态：稳定英文字符串（落库、API、页面共用，不要用枚举数字）。 */
export type UsageRejectedStatus = 'pending' | 'ignored' | 'replayed'

/** 一条被隔离的坏记录（原始载荷 + 原因 + 失败次数）。 */
export interface UsageRejectedRow {
  readonly reqId: string
  readonly epoch: string
  readonly seq: number
  /** 原始载荷 JSON（就是 Go 送来的那条记录，重放时按它重新插入）。 */
  readonly payload: string
  readonly error: string
  readonly failures: number
  readonly status: UsageRejectedStatus
  readonly firstFailedAt: string
  readonly updatedAt: string
}

export interface UsageRejectedQuery {
  readonly status?: UsageRejectedStatus
  readonly limit?: number
  readonly offset?: number
}

export interface UsageRejectedPage {
  readonly items: readonly UsageRejectedRow[]
  readonly total: number
  readonly pending: number
}

/** 重放结果：`inserted` = 这次是否真的新增了一条明细（重复重放是 false）。 */
export interface UsageReplayResult {
  readonly status: UsageRejectedStatus
  readonly inserted: boolean
}

/** 价格服务的结构面：只依赖一个方法，不 import 实现类。 */
export interface PricingPort {
  quote(model: string, tokens: TokenCountsLike): string
}

/**
 * 交给结算服务的单条事实（token 事实 + 归属；**不含金额**——价格事实归 pricing）。
 *
 * 与 `billing` 插件的 `SettleCandidate` 结构相同，但这里只用结构面声明，
 * 不 import 对方实现（AGENTS.md 2.2：插件间只经服务接口通信）。
 */
export interface SettleCandidateLike {
  readonly requestId: string
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

/** 一轮结算的计数结果（只在日志与状态里用，不影响游标推进）。 */
export interface SettleBatchOutcomeLike {
  readonly settled: number
  readonly noPrice: number
  readonly noUser: number
  readonly failed: number
  readonly review: number
  readonly skipped: number
}

/** 结算服务的结构面：只依赖一个方法，不 import 实现类。 */
export interface BillingPort {
  settle(records: readonly SettleCandidateLike[]): Promise<SettleBatchOutcomeLike>
}

export interface TokenCountsLike {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/** 本插件对外的服务面。 */
export interface UsageServiceLike {
  /** 接收一条来自 Go 的记录；幂等（同一 reqId 只落一次）。 */
  ingest(entry: UsageEntry): void
  list(query: UsageQuery): UsageListPage
  /** 按 reqId 取单条明细；查不到返回 null（权限由 HTTP 层判）。 */
  get(reqId: string): UsageRow | null
  summary(query: UsageQuery): UsageSummary
  stats(nowMs?: number): UsageStats
  exportRows(query: UsageQuery, limit?: number): readonly UsageRow[]
  status(): UsageStatus
  /** 隔离区列表（分页 + 计数）；管理面只读。 */
  listRejected(query?: UsageRejectedQuery): UsageRejectedPage
  /** 把 pending 的隔离记录标记为 ignored（幂等）；不存在或状态不允许时抛错。 */
  ignoreRejected(reqId: string): void
  /**
   * 按 req_id 重放一条隔离记录；成功则 pending → replayed（幂等，重复重放不重复插入）。
   *
   * async：重放成功后必须补结算（`billing.settle`），结算插件不在运行时整体失败。
   */
  replayRejected(reqId: string): Promise<UsageReplayResult>
}
