/**
 * 运维总览的**只读视图**（从 `runtime.ts` 拆出来：那个文件全是端口接口，已经 977 行）。
 *
 * 这些类型只有 `/admin/observability` 与它的用例在用，与「页面能用哪些服务」无关。
 */

/** 单个数据源的健康度（与 observability 插件同一套取值）。 */
export type SourceStateView = 'ok' | 'degraded' | 'unavailable'

export interface SourceHealthView {
  readonly state: SourceStateView
  readonly detail: string
}

export interface UsageChainView {
  readonly health: SourceHealthView
  readonly service: {
    readonly records: number
    readonly polling: boolean
    readonly consecutiveFailures: number
    readonly lastError: string | null
    readonly gapRecords: number
    readonly rejectedCount: number
    readonly rejectedPending: number
    readonly pricingAvailable: boolean
    readonly epoch: string | null
    readonly lastSeq: number
  } | null
  readonly gateway: {
    readonly epoch: string
    readonly capacity: number
    readonly size: number
    readonly firstSeq: number
    readonly lastSeq: number
    readonly dropped: number
    readonly gap: number
  } | null
  readonly gatewayHealth: SourceHealthView
}

export interface BillingView {
  readonly health: SourceHealthView
  readonly totals: {
    readonly records: number
    readonly settled: number
    readonly pending: number
    readonly settling: number
    readonly noPrice: number
    readonly noUser: number
    readonly failed: number
    readonly review: number
    readonly overdrawn: number
  } | null
  /** 整数微元字符串（页面用 formatYuan 渲染，不经浮点）。 */
  readonly chargedMicros: string | null
  readonly today: {
    readonly date: string
    readonly settled: number
    readonly chargedMicros: string
  } | null
}

export interface QuotaView {
  readonly health: SourceHealthView
  readonly ready: boolean | null
  readonly revision: string | null
  readonly generation: number | null
  readonly size: number | null
  readonly ageMs: number | null
  readonly ttlMs: number | null
  readonly stale: boolean | null
}

export interface RuntimeView {
  readonly health: SourceHealthView
  readonly active: number | null
  readonly cooling: number | null
}

export interface AuditItemView {
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly summary: string
  readonly result: 'ok' | 'failed'
  readonly errorCode: string | null
}

export interface AuditView {
  readonly health: SourceHealthView
  readonly total: number
  readonly failed: number
  readonly lastAt: string | null
  readonly recentActions: readonly { readonly action: string; readonly count: number }[]
  readonly windowLimit: number
  readonly windowTruncated: boolean
  readonly latest: readonly AuditItemView[]
}

export interface AccountsView {
  readonly health: SourceHealthView
  readonly total: number
  readonly enabled: number
  readonly unknown: number
  readonly healthy: number
  readonly degraded: number
  readonly unhealthy: number
  readonly autoDisabled: number
  readonly lastPass: {
    readonly checked: number
    readonly healthy: number
    readonly failed: number
    readonly autoDisabled: number
    readonly autoEnabled: number
  } | null
  readonly lastPassAt: string | null
  readonly running: boolean | null
}

/** 运维总览报告（observability 插件现算的同一份事实；金额是字符串、无账号明细）。 */
export interface ObservabilityReportView {
  readonly generatedAt: string
  readonly usage: UsageChainView
  readonly billing: BillingView
  readonly quota: QuotaView
  readonly runtime: RuntimeView
  readonly audit: AuditView
  readonly accounts: AccountsView
  readonly warnings: readonly string[]
  readonly degraded: boolean
}

/** 运维总览服务：只有现算这一个方法（没有任何写入口）。 */
export interface ObservabilityLike {
  observe(nowMs?: number): Promise<ObservabilityReportView>
}

