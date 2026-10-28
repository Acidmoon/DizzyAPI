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
export interface WebRuntime {
  readonly user: UserLike | undefined
  readonly auth: AuthLike | undefined
  readonly apiKey: ApiKeyLike | undefined
  readonly usage: UsageLike | undefined
  readonly pricing: PricingLike | undefined
  readonly settings: SettingsLike | undefined
  readonly catalog: CatalogLike | undefined
  readonly accountAdmin: AccountAdminLike | undefined
  readonly redeem: RedeemLike | undefined
  readonly fontSmiley: FontLike | undefined
}

/** 写入时用的 actor 名（app.yml 白名单里登记同一字符串）。 */
export const WEB_ACTOR = '@dizzyapi/plugin-web'
