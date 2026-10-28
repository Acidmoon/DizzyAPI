/**
 * 用量记录的对外形状。
 *
 * 这里只存 **token 事实**，不存费用：费用由读取方按 `pricing` 服务的当前价格表算
 * （AGENTS.md §8：真实扣费尚未实现，页面显示的是「应扣费用」）。
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
}

/** 价格服务的结构面：只依赖一个方法，不 import 实现类。 */
export interface PricingPort {
  quote(model: string, tokens: TokenCountsLike): string
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
  summary(query: UsageQuery): UsageSummary
  stats(nowMs?: number): UsageStats
  exportRows(query: UsageQuery, limit?: number): readonly UsageRow[]
  status(): UsageStatus
}
