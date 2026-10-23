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
  readonly models: readonly string[] | null
  readonly lastTestOk: boolean | null
  readonly lastTestAt: string | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
}

export interface AccountAdminLike {
  list(): AccountView[]
  get(id: string): AccountView
  update(id: string, patch: { enabled?: boolean; label?: string; priority?: number }): Promise<AccountView>
  remove(id: string): Promise<void>
  testConnection(id: string, input?: { model?: string }): Promise<{ readonly ok: boolean; readonly status: number | null; readonly latencyMs: number; readonly model: string | null; readonly error: string | null }>
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
  readonly fontSmiley: FontLike | undefined
}

/** 写入时用的 actor 名（app.yml 白名单里登记同一字符串）。 */
export const WEB_ACTOR = '@dizzyapi/plugin-web'
