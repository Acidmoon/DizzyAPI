/**
 * 控制面服务的结构接口。
 *
 * 不 import 任何插件实现（AGENTS.md 2.2）：只声明页面用到的只读/写入方法，
 * 运行期用 `ctx.get(name, false)` 解析；服务不在时页面明确降级，不 PENDING。
 */

export type UserId = number

export interface UserView {
  readonly id: UserId
  readonly name: string
  readonly status: 'enabled' | 'banned'
  readonly role: 'admin' | 'user'
  readonly balance: bigint
  readonly balanceEnabled: boolean
  readonly avatar: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SessionView {
  readonly sessionId: string
  readonly userId: UserId
  readonly user: UserView
  readonly email?: string
  readonly expiresAt: string
}

export interface LoginResult {
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: string
  readonly user: UserView
}

export interface Ticket {
  readonly email: string
  readonly expiresAt: string
  readonly resendAfterMs: number
}

export interface AuthLike {
  verifySession(token: string): Promise<SessionView>
  login(input: { email: string; password: string }): Promise<LoginResult>
  logout(token: string): Promise<void>
  requestRegistration(input: { email: string; password: string; name?: string }): Promise<Ticket>
  confirmRegistration(input: { email: string; code: string }): Promise<LoginResult>
  changePassword(input: {
    token: string
    currentPassword: string
    newPassword: string
  }): Promise<void>
}

export interface UserLike {
  get(id: UserId): Promise<UserView | undefined>
  list(query?: { status?: 'enabled' | 'banned'; role?: 'admin' | 'user'; offset?: number; limit?: number }): Promise<UserView[]>
  count(): Promise<number>
  setStatus(actor: string, id: UserId, status: 'enabled' | 'banned'): Promise<UserView>
  setRole(actor: string, id: UserId, role: 'admin' | 'user'): Promise<UserView>
  setBalanceEnabled(actor: string, id: UserId, enabled: boolean): Promise<UserView>
  adjustBalance(actor: string, id: UserId, delta: bigint, reason: string): Promise<bigint>
  updateProfile(id: UserId, patch: { name?: string; avatar?: string | null }): Promise<UserView>
  remove(actor: string, id: UserId): Promise<UserView>
}

export interface ApiKeyView {
  readonly id: string
  readonly userId: number
  readonly name: string
  readonly trackingId: string
  /** 完整 key；旧库历史行可能为 null。 */
  readonly secret: string | null
  readonly maskedKey: string
  readonly enabled: boolean
  readonly appManaged: boolean
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly rotatedAt: string | null
}

export interface ApiKeyLike {
  list(userId: UserId): Promise<ApiKeyView[]>
  listAll(): Promise<ApiKeyView[]>
  create(userId: UserId, input: { name: string }): Promise<{ readonly key: ApiKeyView; readonly secret: string }>
  update(userId: UserId, id: string, patch: { name?: string; enabled?: boolean }): Promise<ApiKeyView>
  rotate(userId: UserId, id: string): Promise<{ readonly key: ApiKeyView; readonly secret: string }>
  remove(userId: UserId, id: string): Promise<unknown>
}

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
  readonly startedAt: string
  readonly model: string
  readonly apiKeyName: string
  readonly totalTokens: number
  readonly costMicros: string
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

export interface ModelPrice {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly updatedAt: string
}

export interface PricingLike {
  list(): readonly ModelPrice[]
  set(actor: string, model: string, input: {
    inputPerMillion: string
    outputPerMillion: string
    cacheReadPerMillion?: string
    cacheWritePerMillion?: string
  }): Promise<ModelPrice>
  remove(actor: string, model: string): Promise<boolean>
}

// ───────────────────────────── 模型广场 ─────────────────────────────

export interface ModelPriceView {
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: string
  readonly updatedAt: string
}

export interface ModelEntryView {
  readonly model: string
  readonly priced: boolean
  readonly price: ModelPriceView | null
  readonly accountCount: number
  readonly healthyAccountCount: number
  readonly protocols: readonly string[]
  readonly upstreamModels: readonly string[]
  readonly mapped: boolean
}

export interface ModelUnavailableView {
  readonly model: string
  readonly reason: string
  readonly detail: string
  readonly accountCount: number
  readonly price: ModelPriceView | null
  readonly priced: boolean
}

export interface ModelCatalogView {
  readonly available: readonly ModelEntryView[]
  readonly unavailable: readonly ModelUnavailableView[]
  readonly summary: {
    readonly total: number
    readonly availableCount: number
    readonly unavailableCount: number
    readonly pricedCount: number
    readonly accountCount: number
  }
}

/** 模型广场服务（只读聚合）：页面不 import 插件实现。 */
export interface ModelHubLike {
  catalog(query?: {
    readonly search?: string
    readonly availability?: 'all' | 'available' | 'unavailable'
    readonly priced?: 'all' | 'priced' | 'unpriced'
  }): ModelCatalogView
}

// ───────────────────────────── 兑换码 ─────────────────────────────

export interface RedeemResultView {
  readonly amount: bigint
  readonly balance: bigint
  readonly batchName: string
}

export interface RedemptionView {
  readonly codeId: string
  readonly codeMask: string
  readonly amountMicro: bigint
  readonly batchName: string | null
  readonly redeemedAt: string | null
}

export interface RedeemBatchView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly amountMicro: bigint
  readonly total: number
  readonly notes: string | null
  readonly createdBy: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly codeCount: number
  readonly usedCount: number
}

export interface RedeemCodeView {
  readonly id: string
  readonly batchId: string
  readonly batchName: string | null
  readonly codeMask: string
  readonly kind: string
  readonly amountMicro: bigint
  readonly status: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly reservedAt: string | null
  readonly reservedBy: string | null
  readonly redeemedAt: string | null
  readonly redeemedBy: string | null
  readonly disabledBy: string | null
  readonly disabledAt: string | null
}

export interface RedeemStatsView {
  readonly batches: number
  readonly codes: number
  readonly enabled: number
  readonly disabled: number
  readonly redeeming: number
  readonly used: number
  readonly expired: number
  readonly redeemedAmountMicro: bigint
}

export interface RedeemLike {
  redeemCode(input: { readonly userId: UserId; readonly code: string }): Promise<RedeemResultView>
  listMyRedemptions(userId: UserId, limit?: number): Promise<readonly RedemptionView[]>
  createBatch(actor: string, input: {
    readonly name: string
    readonly amountMicro: bigint
    readonly count: number
    readonly expiresAt?: string | null
    readonly notes?: string | null
  }): Promise<{ readonly batch: RedeemBatchView; readonly codes: readonly string[] }>
  listBatches(
    actor: string,
    query?: { readonly limit?: number; readonly offset?: number },
  ): Promise<readonly RedeemBatchView[]>
  listCodes(
    actor: string,
    query?: {
      readonly batchId?: string
      readonly status?: string
      readonly keyword?: string
      readonly limit?: number
      readonly offset?: number
    },
  ): Promise<{ readonly items: readonly RedeemCodeView[]; readonly total: number }>
  setCodeStatus(
    actor: string,
    codeId: string,
    status: 'enabled' | 'disabled',
  ): Promise<RedeemCodeView>
  deleteCodes(
    actor: string,
    ids: readonly string[],
  ): Promise<{ readonly deleted: number; readonly rejected: readonly { readonly id: string; readonly reason: string }[] }>
  resolveRedeeming(
    actor: string,
    codeId: string,
    outcome: 'used' | 'enabled',
  ): Promise<RedeemCodeView>
  stats(actor: string): Promise<RedeemStatsView>
}

// ───────────────────────────── 结算（只读） ─────────────────────────────

export interface SettleRecordView {
  readonly reqId: string
  readonly userId: number
  readonly accountId: string
  readonly model: string
  readonly day: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMicro: bigint
  /** 扣费后余额为负（后付费透支）：稳定布尔事实，页面据此显示「透支」。 */
  readonly overdrawn: boolean
  /** 扣费之后的余额（整数微元）；没扣款时 null。 */
  readonly balanceAfter: bigint | null
  readonly status: string
  readonly note: string | null
  readonly attempts: number
  readonly startedAt: string
  readonly settledAt: string | null
}

export interface SettleTotalsView {
  readonly records: number
  readonly settled: number
  readonly noPrice: number
  readonly noUser: number
  readonly failed: number
  readonly review: number
  readonly settling: number
  readonly overdrawn: number
  readonly chargedMicros: bigint
  readonly todayChargedMicros: bigint
}

export interface SettleSummaryView {
  readonly totals: SettleTotalsView
  readonly daily: readonly {
    readonly date: string
    readonly records: number
    readonly settled: number
    readonly chargedMicros: bigint
  }[]
  readonly models: readonly {
    readonly model: string
    readonly records: number
    readonly chargedMicros: bigint
  }[]
}

/** 结算服务的只读面；真实扣费由 usage 的结算钩子驱动，页面只读。 */
export interface BillingLike {
  list(
    actor: string,
    query?: { readonly status?: string; readonly userId?: number; readonly limit?: number; readonly offset?: number },
  ): { readonly items: readonly SettleRecordView[]; readonly total: number }
  summary(actor: string, nowMs?: number): SettleSummaryView
}

// ───────────────────────────── 充值订单 ─────────────────────────────

export interface TopupOrderView {
  readonly orderNo: string
  readonly userId: number
  readonly amountMicro: bigint
  readonly status: string
  readonly provider: string
  readonly providerLabel: string
  readonly providerOrderId: string | null
  readonly instructions: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly paidAt: string | null
  readonly canceledAt: string | null
}

export interface TopupOptionsView {
  readonly currency: 'CNY'
  readonly providerId: string
  readonly providerLabel: string
  readonly online: boolean
  readonly minAmountMicros: bigint
  readonly maxAmountMicros: bigint
  readonly expiresMinutes: number
  readonly notice: string
}

export interface TopupStatsView {
  readonly todayPaidCount: number
  readonly todayPaidMicros: bigint
  readonly totalPaidCount: number
  readonly totalPaidMicros: bigint
  readonly pendingCount: number
  readonly expiredCount: number
}

/** 充值订单服务（只读 + 三个写动作）；页面不 import 插件实现。 */
export interface TopupLike {
  options(): TopupOptionsView
  createOrder(input: {
    readonly userId: number
    readonly amountYuan: unknown
    readonly provider?: string
    readonly note?: string | null
  }): Promise<{ readonly order: TopupOrderView }>
  listMine(
    userId: number,
    limit?: number,
  ): { readonly items: readonly TopupOrderView[]; readonly total: number }
  getMine(userId: number, orderNo: string): TopupOrderView
  cancelMine(userId: number, orderNo: string): TopupOrderView
  list(
    actor: string,
    query?: { readonly status?: string; readonly userId?: number; readonly limit?: number; readonly offset?: number },
  ): { readonly items: readonly TopupOrderView[]; readonly total: number }
  confirmPaid(
    actor: string,
    orderNo: string,
  ): Promise<{ readonly order: TopupOrderView; readonly credited: boolean }>
  cancel(actor: string, orderNo: string): TopupOrderView
  stats(actor: string, nowMs?: number): TopupStatsView
}

// ───────────────────────────────── 管理员审计 ─────────────────────────────────

/** 写一条审计记录的输入（web 侧只塞这些字段）。 */
export interface AuditEntryView {
  readonly actor: string
  readonly actorPlugin: string
  readonly action: string
  readonly targetType?: string
  readonly targetId?: string
  readonly summary: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly result?: 'ok' | 'failed'
  readonly errorCode?: string | null
  readonly atMs?: number
}

/** 一条审计记录（元数据已脱敏）。 */
export interface AuditRecordView {
  readonly id: number
  readonly at: string
  readonly atMs: number
  readonly actor: string
  readonly actorPlugin: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly summary: string
  readonly metadata: Readonly<Record<string, unknown>> | null
  readonly result: 'ok' | 'failed'
  readonly errorCode: string | null
}

export interface AuditQueryView {
  readonly actor?: string
  readonly actorPlugin?: string
  readonly action?: string
  readonly targetType?: string
  readonly targetId?: string
  readonly fromMs?: number
  readonly toMs?: number
  readonly limit?: number
  readonly offset?: number
}

export interface AuditPageView {
  readonly items: readonly AuditRecordView[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}

export interface AuditStatsView {
  readonly total: number
  readonly today: number
  readonly last24h: number
  readonly failed: number
  readonly lastAt: string | null
  readonly byAction: readonly { readonly action: string; readonly count: number }[]
  readonly byActor: readonly { readonly actor: string; readonly count: number }[]
}

/**
 * 审计服务（写 + 读）。写不设限；读要求 actor 在审计插件的 `adminPlugins` 白名单里。
 * 页面与动作**绝不 inject** 它：审计缺席只让 `/admin/audit` 降级，写操作照常。
 */
export interface AuditLike {
  record(entry: AuditEntryView): unknown
  list(actor: string, query?: AuditQueryView): AuditPageView
  stats(actor: string): AuditStatsView
}

export interface SettingsField {
  readonly path: string
  readonly label: string
  readonly kind: string
  readonly writable: boolean
  readonly secret: boolean
  readonly credentialRef: boolean
  readonly value?: unknown
  readonly configured?: boolean
  readonly children?: readonly SettingsField[]
}

export interface SettingsNamespaceView {
  readonly ns: string
  readonly plugin: string
  readonly active: boolean
  readonly disabled: boolean
  readonly writable: boolean
  readonly overridden: boolean
  readonly revision: string | null
  readonly pending: boolean
  readonly fields: readonly SettingsField[]
}

export interface SettingsLike {
  describe(): Promise<readonly SettingsNamespaceView[]>
  update(actor: string, ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<SettingsNamespaceView>
  reset(actor: string, ns: string): Promise<SettingsNamespaceView>
}

export interface CatalogPlugin {
  readonly id: string
  readonly name?: string
  readonly status?: string
  readonly capabilities?: readonly string[]
}

export interface CatalogSnapshot {
  readonly plugins: readonly CatalogPlugin[]
}

export interface CatalogLike {
  snapshot(): Promise<CatalogSnapshot>
}

export interface AccountView {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly kind: string
  readonly enabled: boolean
  readonly status: string
  readonly credentialConfigured: boolean
  readonly priority: number
  readonly labels: readonly string[]
  readonly weight: number | null
  readonly concurrency: number | null
  readonly health: string
  readonly autoDisabledAt: string | null
  readonly autoDisabledReason: string | null
  readonly lastUsedAt: string | null
  /** 凭据在 credentials 里的引用名——只是名字，不是秘密。 */
  readonly credentialRef: string
  readonly email: string | null
  readonly subject: string | null
  readonly baseUrl: string | null
  readonly protocol: string | null
  readonly models: readonly string[] | null
  readonly modelMap: Readonly<Record<string, string>> | null
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestAt: string | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 列表精简视图（`list(query, { view: 'lite' })`）；详情字段不在里面。 */
export interface AccountListItem {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly kind: string
  readonly enabled: boolean
  readonly status: string
  readonly credentialConfigured: boolean
  readonly priority: number
  readonly labels: readonly string[]
  readonly weight: number | null
  readonly concurrency: number | null
  readonly health: string
  readonly autoDisabledAt: string | null
  readonly autoDisabledReason: string | null
  readonly lastUsedAt: string | null
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
}

/** 列表过滤条件（与 account-admin 的 AccountListQuery 同形）。 */
export interface AccountListQuery {
  readonly provider?: string
  readonly kind?: string
  readonly enabled?: boolean
  readonly status?: string
  readonly search?: string
  readonly labels?: readonly string[]
  readonly health?: string
}

/** 单条改字段：只提交声明过的字段，`null` 表示清空。 */
export interface AccountUpdatePatch {
  readonly label?: string
  readonly email?: string | null
  readonly subject?: string | null
  readonly baseUrl?: string | null
  readonly protocol?: string | null
  readonly models?: readonly string[] | null
  readonly modelMap?: Readonly<Record<string, string>> | null
  readonly priority?: number
  readonly labels?: readonly string[] | null
  readonly weight?: number | null
  readonly concurrency?: number | null
}

/** 批量操作的一项结果。 */
export interface AccountBulkItemResult {
  readonly id: string
  readonly ok: boolean
  readonly account: AccountView | null
  readonly error: { readonly code: string; readonly message: string } | null
}

export interface AccountBulkResult {
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly items: readonly AccountBulkItemResult[]
}

/**
 * 账号管理门面的结构视图。
 *
 * 注意签名与真实服务一致：**写操作都要显式 actor**（`WEB_ACTOR`），启用 / 停用走
 * `enable` / `disable`（`update` 不接受 `enabled`）。少了 actor 或走错方法，服务会
 * 用 `ACCOUNT_ADMIN_ACTOR_REQUIRED` / `ACCOUNT_ADMIN_INPUT_INVALID` 明确拒绝——
 * 2026-10 管理台「停用 / 删除」按钮失效就是撞在这两条上。
 */
export interface AccountAdminLike {
  list(query?: AccountListQuery): AccountView[]
  list(query: AccountListQuery, options: { readonly view: 'lite' }): AccountListItem[]
  get(id: string): AccountView
  update(actor: string, id: string, patch: AccountUpdatePatch): Promise<AccountView>
  remove(actor: string, id: string): Promise<void>
  enable(actor: string, id: string): Promise<AccountView>
  disable(actor: string, id: string): Promise<AccountView>
  refresh(actor: string, id: string): Promise<AccountView>
  setHealth(actor: string, id: string, health: string): Promise<AccountView>
  autoDisable(actor: string, id: string, reason: string): Promise<AccountView>
  autoEnable(actor: string, id: string): Promise<AccountView>
  bulkUpdate(actor: string, ids: readonly string[], patch: AccountUpdatePatch): Promise<AccountBulkResult>
  bulkEnable(actor: string, ids: readonly string[]): Promise<AccountBulkResult>
  bulkDisable(actor: string, ids: readonly string[]): Promise<AccountBulkResult>
  testConnection(
    id: string,
    input?: { model?: string },
  ): Promise<{
    readonly ok: boolean
    readonly status: number | null
    readonly latencyMs: number
    readonly model: string | null
    readonly error: string | null
  }>
}

/** 站点字体：web 只用到这两件事。 */
export interface FontLike {
  css(): string
  file(): { readonly name: string; readonly contentType: string; readonly body: Buffer }
}

/** 页面能看到的全部控制面服务；缺哪个页面就降级哪块。 */
// ───────────────────────────────── 运维总览 ─────────────────────────────────

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

export interface WebRuntime {
  readonly user: UserLike | undefined
  readonly auth: AuthLike | undefined
  readonly apiKey: ApiKeyLike | undefined
  readonly usage: UsageLike | undefined
  readonly pricing: PricingLike | undefined
  readonly modelhub: ModelHubLike | undefined
  readonly settings: SettingsLike | undefined
  readonly catalog: CatalogLike | undefined
  readonly accountAdmin: AccountAdminLike | undefined
  readonly redeem: RedeemLike | undefined
  readonly billing: BillingLike | undefined
  readonly topup: TopupLike | undefined
  readonly audit: AuditLike | undefined
  readonly observability: ObservabilityLike | undefined
  readonly fontSmiley: FontLike | undefined
}

/** 写入时用的 actor 名（app.yml 白名单里登记同一字符串）。 */
export const WEB_ACTOR = '@dizzyapi/plugin-web'
