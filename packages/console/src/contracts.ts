/**
 * 浏览器侧 API 的跨层契约（TypeScript 真相）。
 *
 * 这些形状是**预期的 Go `httpapi` 输出**，不是当前现状：Go 侧还没有这些路由。
 * 前端 mock 适配器与 HTTP 适配器都实现同一组接口；将来换真实 REST 只改适配器。
 *
 * 两条硬约束：
 * 1. 账号 DTO **没有** `credentialRef`、token、key 字段——前端不接触秘密；
 * 2. 设置 DTO 与 `@dizzyapi/plugin-settings` 的 `SettingsNamespaceView` 同形，
 *    但这里独立声明，避免前端包 import 服务实现。
 */
import type { FrontendManifest, FrontendPage, FrontendSettingsCard, FrontendSlot } from './manifest.ts'

export type AccountProvider = 'claude' | 'openai' | 'custom'
/** 上游端点说哪种协议；`null` = 未声明，走旧行为。 */
export type AccountProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'
export type AccountKind = 'oauth' | 'api_key'
export type AccountStatus = 'active' | 'needs_reauth'

/** 可安全外露的账号元数据；秘密只在 credentials 插件里。 */
export interface AccountSummary {
  readonly id: string
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly label: string
  readonly enabled: boolean
  readonly status: AccountStatus
  readonly email: string | null
  readonly subject: string | null
  readonly baseUrl: string | null
  readonly protocol: AccountProtocol | null
  /** 这个账号服务的对外模型名；null / 空 = 未声明。 */
  readonly models: string[] | null
  /** 对外模型名 → 上游真实模型名；null / 空 = 不改写。 */
  readonly modelMap: Record<string, string> | null
  readonly priority: number
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  /** 最近一次连通性测试；mock / 旧服务可能没有这几个字段。 */
  readonly lastTestAt?: string | null
  readonly lastTestOk?: boolean | null
  readonly lastTestError?: string | null
  readonly lastTestLatencyMs?: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AccountListQuery {
  readonly provider?: AccountProvider
  readonly status?: AccountStatus
  readonly cursor?: string
  readonly limit?: number
}

export interface AccountListResponse {
  readonly items: readonly AccountSummary[]
  readonly nextCursor: string | null
}

/** 只允许改非秘密元数据；令牌导入走独立的凭据接口。 */
export interface AccountUpdateInput {
  readonly label?: string
  readonly email?: string | null
  readonly subject?: string | null
  readonly baseUrl?: string | null
  readonly protocol?: AccountProtocol | null
  /** `undefined` = 不改；`null` 或空数组 = 清空为未声明。 */
  readonly models?: string[] | null
  /** `undefined` = 不改；`null` 或空对象 = 清空为不改写。 */
  readonly modelMap?: Record<string, string> | null
  readonly priority?: number
  readonly enabled?: boolean
}

/** 凭据格式；`auto` 让服务端按 payload 形状推断。 */
export type AccountCredentialFormat =
  | 'auto'
  | 'claude-oauth'
  | 'openai-codex'
  | 'api-key'
  | 'identity-bundle'

/** 一段待导入的凭据。payload 只上行、不回显。 */
export interface AccountCredentialInput {
  readonly format?: AccountCredentialFormat
  readonly payload: string | Record<string, unknown>
  readonly provider?: AccountProvider
  readonly kind?: AccountKind
}

/** 新建账号；credential 省略时创建一个尚未导入凭据的账号。 */
export interface CreateAccountInput {
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly label: string
  readonly email?: string
  readonly subject?: string
  readonly baseUrl?: string
  readonly protocol?: AccountProtocol
  /** 这个账号服务的对外模型名；空数组与未声明等价。 */
  readonly models?: string[]
  /** 对外模型名 → 上游真实模型名；空对象与未声明等价。 */
  readonly modelMap?: Record<string, string>
  readonly priority?: number
  readonly enabled?: boolean
  readonly credential?: AccountCredentialInput
}

/** 向已有账号导入 / 重新授权一份凭据。 */
export interface ImportAccountCredentialsInput {
  readonly format?: AccountCredentialFormat
  readonly payload: string | Record<string, unknown>
}

/** 导入预检：只回答识别结果，不返回令牌本体。 */
export interface CredentialImportPreview {
  readonly format: Exclude<AccountCredentialFormat, 'auto'>
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly email: string | null
  readonly subject: string | null
  readonly expiresAt: string | null
  readonly hasAccessToken: boolean
  readonly hasRefreshToken: boolean
  readonly hasApiKey: boolean
}

export type CatalogModuleKind = 'plugin' | 'module' | 'group'
export type CatalogModuleState = 'active' | 'pending' | 'disabled' | 'failed' | 'unloaded'

export interface CatalogModule {
  readonly id: string
  readonly package: string
  readonly kind: CatalogModuleKind
  readonly state: CatalogModuleState
  readonly version: string | null
  readonly description: string | null
  readonly provides: readonly string[]
  readonly pages: readonly string[]
}

export interface CatalogResponse {
  readonly generatedAt: string
  readonly modules: readonly CatalogModule[]
}

export type SettingsFieldKind = 'string' | 'boolean' | 'integer' | 'enum' | 'stringArray' | 'object'

export interface SettingsFieldView {
  readonly path: string
  readonly label: string
  readonly kind: SettingsFieldKind
  readonly writable: boolean
  readonly secret: boolean
  readonly credentialRef: boolean
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly unit?: string
  readonly value?: unknown
  readonly configured?: boolean
  readonly children?: readonly SettingsFieldView[]
}

export interface SettingsNamespaceView {
  readonly ns: string
  readonly plugin: string
  readonly active: boolean
  readonly disabled: boolean
  readonly writable: boolean
  readonly overridden: boolean
  readonly revision: string | null
  readonly updatedAt: string | null
  readonly pending: boolean
  readonly pendingReason?: 'missing' | 'disabled' | 'inactive'
  readonly fields: readonly SettingsFieldView[]
}

export interface SettingsDescribeResponse {
  readonly namespaces: readonly SettingsNamespaceView[]
}

export type SettingsPatch = Readonly<Record<string, unknown>>

export type GatewayHealthState = 'ok' | 'degraded' | 'down'

export interface GatewayComponentHealth {
  readonly name: string
  readonly state: GatewayHealthState
  readonly detail?: string
}

/** gatewayd 的健康面；`down` 表示浏览器连 REST 都读不到时由前端推断。 */
export interface GatewayHealth {
  readonly state: GatewayHealthState
  readonly at: string
  readonly version: string
  readonly uptimeSec: number
  readonly descriptorRevision: string | null
  readonly bridge: {
    readonly connected: boolean
    readonly transport: 'unix' | 'tcp' | null
    readonly address: string | null
  }
  readonly components: readonly GatewayComponentHealth[]
}

export interface ConsoleManifestResponse extends FrontendManifest {}

// ── 用户站：用量 / API keys / 充值 ──────────────────────────────────────

export type UsageRange = '7d' | '30d' | '90d'
export type UsageMetric = 'cost' | 'requests' | 'tokens'

export interface UsageQuery {
  readonly range: UsageRange
  readonly apiKeyId?: string
  readonly model?: string
  /** keyset 分页：只取 id 小于它的明细。 */
  readonly cursor?: number
  readonly limit?: number
}

/** 管理员口径：多一个按用户过滤的目标。 */
export interface AdminUsageQuery extends UsageQuery {
  readonly userId?: number
  readonly status?: number
}

/** 金额一律是整数分（D10：禁止浮点存余额）；前端只做显示换算。 */
export interface UsageBalances {
  readonly paidCents: number
  readonly grantedCents: number
  readonly spentCents: number
}

/**
 * 一组用量数字。
 *
 * `tokens` 是四个桶之和；`costCents` 是图表的粗口径，`costMicros` 是精确值
 * （整数微元，十进制字符串——30 位以上的大整数不能进 number）。
 */
export interface UsageTotals {
  readonly requests: number
  readonly tokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costCents: number
  readonly costMicros: string
}

export interface UsageDailyPoint extends UsageTotals {
  /** `YYYY-MM-DD`（UTC）。 */
  readonly date: string
}

export interface UsageModelBreakdown extends UsageTotals {
  readonly model: string
}

export interface UsageUserBreakdown extends UsageTotals {
  readonly userId: number
  readonly name: string | null
}

/** 一条请求明细。费用是读取时按价格表算的「应扣」金额。 */
export interface UsageRowView {
  readonly id: number
  readonly reqId: string
  readonly userId: number
  readonly apiKeyId: string
  readonly apiKeyName: string
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
  readonly totalTokens: number
  readonly durationMs: number
  readonly clientIp: string | null
  readonly startedAt: string
  readonly costMicros: string
}

/** 管理员明细：多账号与用户维度；用户页永远拿不到这些字段。 */
export interface AdminUsageRowView extends UsageRowView {
  readonly userName: string | null
  readonly accountId: string | null
  readonly attempts: number
}

export interface UsageListResponse<T extends UsageRowView = UsageRowView> {
  readonly items: readonly T[]
  readonly nextCursor: number | null
}

export interface UsageResponse {
  readonly range: UsageRange
  readonly from: string
  readonly to: string
  readonly apiKeyId: string | null
  readonly balances: UsageBalances
  readonly totals: UsageTotals
  readonly daily: readonly UsageDailyPoint[]
  readonly models: readonly UsageModelBreakdown[]
  readonly records: UsageListResponse
  /** false = pricing 插件不在运行，费用全是 0。 */
  readonly pricingAvailable: boolean
  readonly generatedAt: string
}

export interface AdminUsageResponse {
  readonly range: UsageRange
  readonly from: string
  readonly to: string
  readonly totals: UsageTotals
  readonly daily: readonly UsageDailyPoint[]
  readonly models: readonly UsageModelBreakdown[]
  readonly records: UsageListResponse<AdminUsageRowView>
  readonly pricingAvailable: boolean
  readonly generatedAt: string
}

/** 全站概览：计数 + 用量汇总。`usage` 为 null 表示用量插件不在运行。 */
export interface GatewayStats {
  readonly generatedAt: string
  readonly users: { readonly total: number; readonly admins: number; readonly enabled: number; readonly banned: number }
  readonly accounts: {
    readonly total: number
    readonly enabled: number
    readonly disabled: number
    readonly needsReauth: number
  }
  readonly keys: { readonly total: number; readonly enabled: number; readonly disabled: number }
  readonly usage: {
    readonly today: UsageTotals
    readonly total: UsageTotals
    readonly series: readonly UsageDailyPoint[]
    readonly models: readonly UsageModelBreakdown[]
    readonly topUsers: readonly UsageUserBreakdown[]
  } | null
}

/** 模型价格（元 / 百万 token，十进制字符串）。 */
export interface ModelPriceView {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: 'CNY'
  readonly updatedAt: string
}

export interface ModelPriceInput {
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion?: string
  readonly cacheWritePerMillion?: string
}

export interface PricingListResponse {
  readonly items: readonly ModelPriceView[]
}

/** 列表里只有掩码；完整 key 只在创建响应里出现一次。 */
export interface ApiKeySummary {
  readonly id: string
  readonly name: string
  readonly trackingId: string
  /** 完整 key；旧库历史行为 null，轮换后写入。 */
  readonly secret: string | null
  readonly maskedKey: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly appManaged: boolean
  /** 省略时按启用处理（兼容旧服务）。 */
  readonly enabled?: boolean
}

export interface ApiKeyListResponse {
  readonly items: readonly ApiKeySummary[]
}

export interface CreateApiKeyInput {
  readonly name: string
}

/** 创建 / 轮换响应；`secret` 与列表里的完整 key 相同。 */
export interface CreatedApiKey extends ApiKeySummary {
  readonly secret: string
}

export interface UpdateApiKeyInput {
  readonly name?: string
  readonly enabled?: boolean
}

// ── 会话 / 个人资料 ─────────────────────────────────────────────────────

export interface AuthTicket {
  readonly email: string
  readonly expiresAt: string
  readonly resendAfterMs: number
}

export type SessionRole = 'admin' | 'user'

/** 浏览器能看到的用户视图：没有密码哈希、没有令牌；余额只在允许时出现。 */
export interface SessionUser {
  readonly id: number
  readonly name: string
  readonly status: 'enabled' | 'banned'
  readonly role: SessionRole
  readonly balanceEnabled: boolean
  /** 只有 admin 或 balanceEnabled 时才有值；否则为 null。 */
  readonly balanceCents: number | null
  readonly avatar: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SessionInfo {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
}

/** 登录 / 注册确认的直接响应；完整权限在随后一次 `session.get()` 里读。 */
export interface LoginResponse {
  readonly user: SessionUser
  readonly session: SessionInfo
}

export interface SessionResponse {
  readonly user: SessionUser
  readonly email: string | null
  readonly session: SessionInfo
  readonly permissions: { readonly admin: boolean }
}

export interface ProfileUpdateInput {
  readonly name?: string
  readonly avatar?: string | null
}

export interface PasswordChangeInput {
  readonly currentPassword: string
  readonly newPassword: string
}

export interface RegisterRequestInput {
  readonly email: string
  readonly password: string
  readonly name?: string
}

export interface PasswordResetConfirmInput {
  readonly email: string
  readonly code: string
  readonly password: string
}

export interface SessionApi {
  get(): Promise<SessionResponse>
  login(input: { readonly email: string; readonly password: string }): Promise<LoginResponse>
  logout(): Promise<void>
  registerRequest(input: RegisterRequestInput): Promise<AuthTicket>
  registerConfirm(input: { readonly email: string; readonly code: string }): Promise<LoginResponse>
  requestPasswordReset(input: { readonly email: string }): Promise<AuthTicket>
  confirmPasswordReset(input: PasswordResetConfirmInput): Promise<{ readonly userId: number; readonly revokedSessions: number }>
  updateProfile(patch: ProfileUpdateInput): Promise<SessionUser>
  changePassword(input: PasswordChangeInput): Promise<{ readonly revokedSessions: number }>
}

// ── 管理台：用户 ───────────────────────────────────────────────────────

/** 管理台用户行；余额用十进制字符串表示最小单位，避免 JS number 丢精度。 */
export interface AdminUserSummary {
  readonly id: number
  readonly name: string
  readonly status: 'enabled' | 'banned'
  readonly role: SessionRole
  readonly balanceEnabled: boolean
  readonly balanceMinor: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AdminUserListResponse {
  readonly items: readonly AdminUserSummary[]
}

export interface AdminUserUpdateInput {
  readonly name?: string
  readonly role?: SessionRole
  readonly status?: 'enabled' | 'banned'
  readonly balanceEnabled?: boolean
}

export interface AdminBalanceInput {
  /** 最小单位的十进制字符串；负数表示扣减。 */
  readonly deltaMinor: string
  readonly reason: string
}

export interface AdminUsersApi {
  list(query?: { readonly status?: 'enabled' | 'banned'; readonly offset?: number; readonly limit?: number }): Promise<AdminUserListResponse>
  get(id: number): Promise<AdminUserSummary>
  update(id: number, patch: AdminUserUpdateInput): Promise<AdminUserSummary>
  remove(id: number): Promise<{ readonly removed: true }>
  adjustBalance(id: number, input: AdminBalanceInput): Promise<{ readonly balanceMinor: string }>
}

export type PaymentMethod = 'alipay' | 'wechat'

export interface TopupMethod {
  readonly id: PaymentMethod
  readonly label: string
  readonly enabled: boolean
  readonly note?: string
}

export interface TopupOptions {
  readonly currency: 'CNY'
  readonly amountsCents: readonly number[]
  readonly minCents: number
  readonly maxCents: number
  readonly methods: readonly TopupMethod[]
  readonly notice: string
}

export interface TopupOrderInput {
  readonly amountCents: number
  readonly method: PaymentMethod
}

export interface TopupOrder {
  readonly orderId: string
  readonly status: 'pending' | 'paid' | 'closed'
  readonly amountCents: number
  readonly method: PaymentMethod
  readonly payUrl: string | null
  readonly expiresAt: string
  readonly message?: string
}

/** 业务适配器 + 清单。HTTP 与 mock 实现的是同一组签名。 */
export interface AccountsApi {
  list(query?: AccountListQuery): Promise<AccountListResponse>
  get(id: string): Promise<AccountSummary>
  create(input: CreateAccountInput): Promise<AccountSummary>
  update(id: string, patch: AccountUpdateInput): Promise<AccountSummary>
  remove(id: string): Promise<{ readonly removed: true }>
  /** 只上行凭据，不回显；成功返回账号元数据。 */
  importCredentials(id: string, input: ImportAccountCredentialsInput): Promise<AccountSummary>
  /** 导入预检：识别格式与元数据，不落盘。 */
  previewImport(input: ImportAccountCredentialsInput): Promise<CredentialImportPreview>
  /** 连通性测试：只发最小请求，不回显任何凭据。 */
  test(id: string, input?: AccountTestInput): Promise<AccountTestResult>
  /** 批量导入预检：把来源格式归一化后逐条给出结论，不含秘密。 */
  previewImportSource(input: AccountImportSourceInput): Promise<AccountImportPreview>
  /** 批量导入：部分成功，逐条返回结果。 */
  importSource(input: AccountImportSourceInput): Promise<AccountImportResult>
}

export type AccountImportSourceFormat = 'auto' | 'new-api' | 'sub2api' | 'plain-keys'

export interface AccountImportSourceInput {
  readonly source: AccountImportSourceFormat
  readonly payload: string
  readonly defaults?: {
    readonly provider?: AccountProvider
    readonly kind?: AccountKind
    readonly baseUrl?: string
    readonly protocol?: AccountProtocol
    readonly enabled?: boolean
    readonly labelPrefix?: string
  }
}

export interface AccountImportPreviewItem {
  readonly index: number
  readonly ok: boolean
  readonly label: string | null
  readonly provider: AccountProvider | null
  readonly kind: AccountKind | null
  readonly baseUrl: string | null
  readonly models: readonly string[] | null
  readonly error: string | null
}

export interface AccountImportPreview {
  readonly source: Exclude<AccountImportSourceFormat, 'auto'>
  readonly total: number
  readonly items: readonly AccountImportPreviewItem[]
}

export interface AccountImportItemResult {
  readonly index: number
  readonly ok: boolean
  readonly account: AccountSummary | null
  readonly error: { readonly code: string; readonly message: string } | null
}

export interface AccountImportResult {
  readonly total: number
  readonly created: number
  readonly failed: number
  readonly items: readonly AccountImportItemResult[]
}

export interface AccountTestInput {
  readonly model?: string
  readonly protocol?: AccountProtocol
}

export interface AccountTestResult {
  readonly ok: boolean
  readonly status: number | null
  readonly latencyMs: number
  readonly model: string | null
  readonly protocol: string | null
  readonly error: string | null
  readonly testedAt: string
}

export interface CatalogApi {
  list(): Promise<CatalogResponse>
}

export interface SettingsApi {
  describe(): Promise<SettingsDescribeResponse>
  update(ns: string, patch: SettingsPatch, expectedRevision?: string): Promise<SettingsNamespaceView>
  reset(ns: string): Promise<SettingsNamespaceView>
}

export interface HealthApi {
  get(): Promise<GatewayHealth>
}

export interface ConsoleApi {
  manifest(): Promise<ConsoleManifestResponse>
}

export interface UsageApi {
  get(query: UsageQuery): Promise<UsageResponse>
  /** 返回 CSV 文本与建议文件名；由页面生成 Blob 下载。 */
  exportCsv(query: UsageQuery): Promise<{ readonly filename: string; readonly content: string }>
}

export interface AdminUsageApi {
  list(query: AdminUsageQuery): Promise<AdminUsageResponse>
  exportCsv(query: AdminUsageQuery): Promise<{ readonly filename: string; readonly content: string }>
}

export interface StatsApi {
  get(): Promise<GatewayStats>
}

export interface PricingApi {
  list(): Promise<PricingListResponse>
  get(model: string): Promise<ModelPriceView>
  set(model: string, input: ModelPriceInput): Promise<ModelPriceView>
  remove(model: string): Promise<{ readonly removed: boolean }>
}

export interface ApiKeysApi {
  list(): Promise<ApiKeyListResponse>
  create(input: CreateApiKeyInput): Promise<CreatedApiKey>
  update(id: string, input: UpdateApiKeyInput): Promise<ApiKeySummary>
  remove(id: string): Promise<{ readonly removed: true }>
  /** 轮换密钥：旧 secret 立刻失效，新 secret 只在这次响应里出现一次。 */
  rotate(id: string): Promise<CreatedApiKey>
}

export interface TopupApi {
  options(): Promise<TopupOptions>
  createOrder(input: TopupOrderInput): Promise<TopupOrder>
}

export interface FrontendApis {
  readonly session: SessionApi
  readonly users: AdminUsersApi
  readonly accounts: AccountsApi
  readonly catalog: CatalogApi
  readonly settings: SettingsApi
  readonly health: HealthApi
  readonly usage: UsageApi
  readonly adminUsage: AdminUsageApi
  readonly stats: StatsApi
  readonly pricing: PricingApi
  readonly keys: ApiKeysApi
  readonly topup: TopupApi
  readonly console: ConsoleApi
}

/** 服务写入 `manifest.json` 的行；浏览器通过 `/api/console/manifest` 读到它。 */
export type ManifestPageView = FrontendPage['view']
export type ManifestCard = FrontendSettingsCard
export type ManifestSlot = FrontendSlot
