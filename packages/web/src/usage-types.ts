/**
 * 用量相关的运行时类型（从 `runtime.ts` 拆出来）。
 *
 * 为什么单独一个文件：`runtime.ts` 已经超过 400 行软上限（AGENTS.md §5.6），
 * 而用量这两页（概览 / 明细）与它只是**类型**依赖。拆出来之后 `runtime.ts` 净减，
 * 用量页的视图层也可以只依赖这一个小文件，不再拉整份运行时类型。
 */
export interface UsageQuery {
  readonly fromMs: number
  readonly toMs: number
  readonly userId?: number
  readonly apiKeyId?: string
}

export interface UsageTotals {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly requests: number
  readonly costMicros: string
}

export interface UsageDailyPoint {
  readonly date: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly requests: number
  readonly costMicros: string
}

export interface UsageSummary {
  readonly totals: UsageTotals
  readonly daily: readonly UsageDailyPoint[]
  readonly models: readonly { readonly model: string; readonly requests: number; readonly totalTokens: number; readonly costMicros: string }[]
}

export interface UsageRow {
  readonly id: number
  readonly reqId: string
  readonly userId: number
  readonly startedAt: string
  readonly model: string
  readonly apiKeyId: string
  readonly apiKeyName: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly usagePresent: boolean
  readonly usageComplete: boolean
  readonly costMicros: string
  readonly durationMs: number
  /** 首字延迟（毫秒）；null = 没采集到（非流式请求 / 历史记录），页面显示「—」。 */
  readonly ttftMs: number | null
  readonly status: number
}

export interface UsageListPage {
  readonly items: readonly UsageRow[]
  readonly nextCursor: number | null
}

export interface UsageStats {
  readonly today: UsageTotals
  readonly total: UsageTotals
  readonly models: readonly { readonly model: string; readonly requests: number; readonly totalTokens: number; readonly costMicros: string }[]
}

export interface UsageLike {
  summary(query: UsageQuery): UsageSummary
  list(query: UsageQuery & { cursor?: number; limit?: number }): UsageListPage
  /** 按 reqId 取单条（无脚本降级路径用）；**归属检查在页面层**（服务不判权限）。 */
  get(reqId: string): UsageRow | null
  exportRows(query: UsageQuery, limit?: number): readonly UsageRow[]
  stats(nowMs?: number): UsageStats
  /** 坏记录隔离区（分页 + 计数）；这些记录没有进明细、也不会结算。 */
  listRejected(query?: UsageRejectedQuery): UsageRejectedPage
  /** 把 pending 的隔离记录标记为 ignored（= 明确放弃这笔未结算用量）。 */
  ignoreRejected(reqId: string): void
  /** 按 req_id 重放隔离记录；重复重放不会重复插入。 */
  replayRejected(reqId: string): Promise<{ readonly status: string; readonly inserted: boolean }>
}

export interface UsageRejectedRow {
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

export interface UsageRejectedQuery {
  readonly status?: string
  readonly limit?: number
  readonly offset?: number
}

export interface UsageRejectedPage {
  readonly items: readonly UsageRejectedRow[]
  readonly total: number
  readonly pending: number
}
