/**
 * 运维总览的对外形状。
 *
 * 三条不变式：
 * - **每块都带自己的数据源健康度**（`ok` / `degraded` / `unavailable` + 原因）：
 *   一个源挂了不影响其它块，页面照常渲染，只把那一块标成不可用（D5 的同一取向）。
 * - **金额一律十进制字符串**（整数微元），页面与 JSON 都不经浮点、不承载 bigint。
 * - **不出现**账号 id / label / baseUrl / 用户隐私 / 任何秘密：只有计数、时间、稳定码。
 */

/** 单个数据源的健康度。 */
export type SourceState = 'ok' | 'degraded' | 'unavailable'

export interface SourceHealth {
  readonly state: SourceState
  /** 人话说明；`ok` 时是空字符串。页面直接展示，不含秘密。 */
  readonly detail: string
}

/** 用量链路：TS 侧轮询状态 + Go 环形缓冲健康度。 */
export interface UsageChainView {
  readonly health: SourceHealth
  /** `usage.status()`；服务不在时为 null。 */
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
  /** 桥命令 `usage.stats`；桥没连上时为 null（单独一个健康度）。 */
  readonly gateway: {
    readonly epoch: string
    readonly capacity: number
    readonly size: number
    readonly firstSeq: number
    readonly lastSeq: number
    readonly dropped: number
    readonly gap: number
  } | null
  readonly gatewayHealth: SourceHealth
}

/** 结算：各状态计数 + 扣费额（整数微元字符串）。 */
export interface BillingView {
  readonly health: SourceHealth
  readonly totals: {
    readonly records: number
    readonly settled: number
    /** 计算值：records 减去其它状态之和；billing 没有单独暴露 pending 计数。 */
    readonly pending: number
    readonly settling: number
    readonly noPrice: number
    readonly noUser: number
    readonly failed: number
    readonly review: number
    readonly overdrawn: number
  } | null
  /** 累计扣费（整数微元字符串）。 */
  readonly chargedMicros: string | null
  /**
   * 「今天（UTC，按请求发生日）」的结算笔数与金额。
   *
   * 注意口径：billing 的 `daily` 桶按**请求发生日**分，不是滚动 24 小时——
   * 滚动窗口需要 billing 新增时间范围查询（本批不改它的读语义）。页面必须写清口径。
   */
  readonly today: {
    readonly date: string
    readonly settled: number
    readonly chargedMicros: string
  } | null
}

/** 额度快照（Go 侧余额只读快照）。 */
export interface QuotaView {
  readonly health: SourceHealth
  readonly ready: boolean | null
  readonly revision: string | null
  readonly generation: number | null
  readonly size: number | null
  readonly ageMs: number | null
  readonly ttlMs: number | null
  /** 快照年龄超过 TTL（= 严格模式下会 503）。未就绪时为 null。 */
  readonly stale: boolean | null
}

/** 账号运行时（Go 侧全站聚合）。 */
export interface RuntimeView {
  readonly health: SourceHealth
  readonly active: number | null
  readonly cooling: number | null
}

/** 审计：总量 + 最近窗口按动作分组 + 最近几条。 */
export interface AuditView {
  readonly health: SourceHealth
  readonly total: number
  readonly failed: number
  readonly lastAt: string | null
  readonly recentActions: readonly { readonly action: string; readonly count: number }[]
  readonly windowLimit: number
  /** 窗口里扫到的条数 == 上限，说明分组计数可能偏小。 */
  readonly windowTruncated: boolean
  readonly latest: readonly AuditItemView[]
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

/** 账号池：健康四态分布 + 自动停用数 + 最近一轮检查结果。 */
export interface AccountsView {
  readonly health: SourceHealth
  readonly total: number
  readonly enabled: number
  readonly unknown: number
  readonly healthy: number
  readonly degraded: number
  readonly unhealthy: number
  /** `status === 'auto_disabled'` 的数量（系统自动停用，不是人手停的）。 */
  readonly autoDisabled: number
  /** account-health 的 `status()`；插件不在时为 null。 */
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

/** 完整报告。 */
export interface ObservabilityReport {
  readonly generatedAt: string
  readonly usage: UsageChainView
  readonly billing: BillingView
  readonly quota: QuotaView
  readonly runtime: RuntimeView
  readonly audit: AuditView
  readonly accounts: AccountsView
  /** 异常摘要（稳定英文码，页面据此高亮）。 */
  readonly warnings: readonly string[]
  /** 有任何一块不是 ok（`degraded` 或 `unavailable`）：页面顶部据此提示「部分数据源不完整」。 */
  readonly degraded: boolean
}

/** 本插件对外的服务面（api / web 只依赖这一个方法）。 */
export interface ObservabilityServiceLike {
  observe(nowMs?: number): Promise<ObservabilityReport>
}
