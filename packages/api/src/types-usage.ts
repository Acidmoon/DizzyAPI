/**
 * 用量与价格里「用量」那一半的 DTO 与端口（从 `types.ts` 拆出来）。
 *
 * 为什么单独一个文件：`packages/api/src/types.ts` 已经 1051 行、远超 500 行上限
 * （AGENTS.md §5.6「已有超限文件只许缩短，不许加长」）。这批要给用量加「按 API key」
 * 与「按用户」两个饼图维度，就把整块用量 DTO 搬出来，让 `types.ts` 净减而不是又涨十几行。
 *
 * **只放类型，不放实现**：这些接口是 `api` 插件对 `usage` 服务的最小依赖面，
 * 用来避免 `api` 直接 import `@dizzyapi/plugin-usage` 的实现。
 */

export interface UsageRowLike {
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
  /** 首字延迟（毫秒）；null = 没采集到（非流式请求 / 历史记录）。 */
  readonly ttftMs: number | null
  readonly clientIp: string | null
  readonly attempts: number
  readonly startedAt: string
  readonly costMicros: string
}

export interface UsageQueryLike {
  readonly fromMs: number
  readonly toMs: number
  readonly userId?: number
  readonly apiKeyId?: string
  readonly model?: string
  readonly status?: number
  readonly cursor?: number
  readonly limit?: number
}

export interface UsageTotalsLike {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly costMicros: string
}

export interface UsageDailyPointLike extends UsageTotalsLike {
  readonly date: string
}

export interface UsageModelBreakdownLike extends UsageTotalsLike {
  readonly model: string
  readonly other?: boolean
}

export interface UsageUserBreakdownLike extends UsageTotalsLike {
  readonly userId: number
  readonly other?: boolean
}

/** 按 API key 聚合（饼图「按接口」维度）；`apiKeyName` 只是展示名，绝不是完整 key。 */
export interface UsageApiKeyBreakdownLike extends UsageTotalsLike {
  readonly apiKeyId: string
  readonly apiKeyName: string
  readonly other?: boolean
}

export interface UsageSummaryLike {
  readonly totals: UsageTotalsLike
  readonly daily: readonly UsageDailyPointLike[]
  readonly models: readonly UsageModelBreakdownLike[]
  /** 只在调用方要「按接口」饼图时才非空（多跑一条 GROUP BY 有成本）。 */
  readonly apiKeys: readonly UsageApiKeyBreakdownLike[]
  /** 只在管理面要「按用户」饼图时才非空。 */
  readonly users: readonly UsageUserBreakdownLike[]
}

/**
 * `summary()` 的可选维度开关。
 *
 * 为什么不总是全跑：`gate-feed` 对每个受限 key 都调 `summary()` 但**只读 totals**，
 * 无条件多跑两条 `GROUP BY` 会把「按 key 限额」的快照计算拖慢一倍以上。
 */
export interface UsageSummaryOptionsLike {
  readonly apiKeys?: boolean
  readonly users?: boolean
}

export interface UsageListPageLike {
  readonly items: readonly UsageRowLike[]
  readonly nextCursor: number | null
}

export interface UsageStatsLike {
  readonly today: UsageTotalsLike
  readonly total: UsageTotalsLike
  readonly series: readonly UsageDailyPointLike[]
  readonly models: readonly UsageModelBreakdownLike[]
  readonly topUsers: readonly UsageUserBreakdownLike[]
}

export interface UsageStatusLike {
  readonly records: number
  readonly epoch: string | null
  readonly lastSeq: number
  readonly polling: boolean
  readonly pricingAvailable: boolean
}

/** 一条被隔离的坏记录（`usage_rejected`）；这些记录没有进明细、也不会结算。 */
export interface UsageRejectedRowLike {
  readonly reqId: string
  readonly epoch: string
  readonly seq: number
  readonly payload: string
  readonly error: string
  readonly failures: number
  readonly status: string
  readonly firstFailedAt: string
  readonly updatedAt: string
}

export interface UsageRejectedQueryLike {
  readonly status?: string
  readonly limit?: number
  readonly offset?: number
}

export interface UsageRejectedPageLike {
  readonly items: readonly UsageRejectedRowLike[]
  readonly total: number
  readonly pending: number
}

export interface UsageReplayResultLike {
  readonly status: string
  readonly inserted: boolean
}

export interface UsagePort {
  list(query: UsageQueryLike): UsageListPageLike
  /** 按 reqId 取单条明细；查不到返回 null。权限在 HTTP 层判。 */
  get(reqId: string): UsageRowLike | null
  summary(query: UsageQueryLike, options?: UsageSummaryOptionsLike): UsageSummaryLike
  stats(nowMs?: number): UsageStatsLike
  exportRows(query: UsageQueryLike, limit?: number): readonly UsageRowLike[]
  /** 导出 CSV：格式由 `usage` 插件唯一实现，api 与 web 都调它，不各拼一份。 */
  exportCsv(query: UsageQueryLike, limit?: number): { readonly filename: string; readonly content: string }
  status(): UsageStatusLike
  listRejected(query?: UsageRejectedQueryLike): UsageRejectedPageLike
  ignoreRejected(reqId: string): void
  replayRejected(reqId: string): Promise<UsageReplayResultLike>
}
