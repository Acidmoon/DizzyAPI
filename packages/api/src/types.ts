/**
 * 产品 HTTP 入口的对外形状与「服务端口」。
 *
 * 两个原则：
 *
 * 1. **响应里没有秘密**：会话用户、账号、设置都只有前端能安全看到的字段；
 *    完整 API key 只出现在 create / rotate 的一次性响应里。
 * 2. **端口按结构声明，不 import 服务的类**：settings 与 apiKey 在别的分支里
 *    才存在，这里只描述「调用时至少要有什么方法」，取不到就返回 503。
 */

// ───────────────────────────── 会话与用户 ─────────────────────────────

export type SessionRole = 'admin' | 'user'
export type UserStatusLike = 'enabled' | 'banned'

/** 用户服务返回的最小结构。`role` / `balanceEnabled` / `avatar` 由 user-system 分支补齐。 */
export interface UserLike {
  readonly id: number
  readonly name: string
  readonly status: UserStatusLike
  readonly balance: bigint
  readonly createdAt: string
  readonly updatedAt: string
  readonly role?: SessionRole
  readonly balanceEnabled?: boolean
  readonly avatar?: string | null
}

export interface SessionUserView {
  readonly id: number
  readonly name: string
  readonly status: UserStatusLike
  readonly role: SessionRole
  readonly balanceEnabled: boolean
  /** 只有 admin 或 balanceEnabled 才有值；否则为 null。 */
  readonly balanceCents: number | null
  readonly avatar: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SessionInfoView {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
}

export interface SessionViewLike {
  readonly sessionId: string
  readonly userId: number
  readonly user: UserLike
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
  /** user-system 分支会在会话视图里带上邮箱；没有时退回 `auth.getEmail`。 */
  readonly email?: string | null
}

export interface LoginResultLike {
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: string
  readonly user: UserLike
}

export interface TicketLike {
  readonly email: string
  readonly expiresAt: string
  readonly resendAfterMs: number
}

/** 管理台的用户行；余额是十进制字符串，浏览器用 BigInt 解析。 */
export interface AdminUserView {
  readonly id: number
  readonly name: string
  readonly status: UserStatusLike
  readonly role: SessionRole
  readonly balanceEnabled: boolean
  readonly balanceMinor: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface UserPort {
  get(id: number): Promise<UserLike | undefined>
  list(query?: { readonly status?: UserStatusLike; readonly offset?: number; readonly limit?: number }): Promise<UserLike[]>
  rename(actor: string, id: number, name: string): Promise<UserLike>
  setStatus(actor: string, id: number, status: UserStatusLike): Promise<UserLike>
  remove(actor: string, id: number): Promise<UserLike>
  adjustBalance(actor: string, id: number, delta: bigint, reason: string): Promise<bigint>
  updateProfile?(userId: number, patch: { readonly name?: string; readonly avatar?: string | null }): Promise<unknown>
  setRole?(actor: string, id: number, role: SessionRole): Promise<unknown>
  setBalanceEnabled?(actor: string, id: number, enabled: boolean): Promise<unknown>
}

export interface AuthPort {
  requestRegistration(input: { email: string; password: string; name?: string }): Promise<TicketLike>
  confirmRegistration(input: { email: string; code: string }): Promise<LoginResultLike>
  login(input: { email: string; password: string; meta?: { userAgent?: string; ip?: string } }): Promise<LoginResultLike>
  logout(token: string): Promise<void>
  verifySession(token: string): Promise<SessionViewLike>
  changePassword(token: string, currentPassword: string, newPassword: string): Promise<{ revokedSessions: number }>
  requestPasswordReset(email: string): Promise<TicketLike>
  confirmPasswordReset(input: {
    email: string
    code: string
    password: string
  }): Promise<{ userId: number; revokedSessions: number }>
  /** 可选的邮箱读口；本分支的 auth 还没有，拿不到时返回 null。 */
  getEmail?(userId: number): string | null | Promise<string | null>
}

// ───────────────────────────── 前端宿主 ─────────────────────────────

export interface FrontendPageLike {
  readonly id: string
  readonly owner: string
  readonly area: 'console' | 'admin'
  readonly path: string
  readonly title: string
}

export interface FrontendManifestLike {
  readonly [key: string]: unknown
}

export interface FrontendPort {
  readonly config: { readonly publicBase: string }
  current(): Promise<{ readonly version: string } | null>
  assetPath(path: string, version?: string): Promise<string>
  indexFile?(): Promise<string | null>
  manifest(): Promise<FrontendManifestLike>
  pages(area?: 'console' | 'admin'): readonly FrontendPageLike[]
  assets(): Promise<{ readonly dataPath: string }>
}

// ───────────────────────────── 能力目录 ─────────────────────────────

export interface CatalogPluginLike {
  readonly id: string
  readonly package: string
  readonly kind: 'plugin' | 'group'
  readonly state: string
  readonly disabled: boolean
  readonly manifest: { readonly description: string | null }
  readonly capabilities: readonly string[]
}

export interface CatalogPort {
  query(params?: unknown): Promise<{ readonly generatedAt: string; readonly plugins: readonly CatalogPluginLike[] }>
}

export interface CatalogModuleView {
  readonly id: string
  readonly package: string
  readonly kind: 'plugin' | 'module' | 'group'
  readonly state: 'active' | 'pending' | 'disabled' | 'failed' | 'unloaded'
  readonly version: string | null
  readonly description: string | null
  readonly provides: readonly string[]
  readonly pages: readonly string[]
}

// ───────────────────────────── 账号管理 ─────────────────────────────

export interface AccountViewLike {
  readonly id: string
  readonly provider: string
  readonly kind: string
  readonly label: string
  readonly enabled: boolean
  readonly status: string
  readonly email: string | null
  readonly subject: string | null
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AccountAdminQueryLike {
  readonly provider?: string
  readonly status?: string
  readonly cursor?: string
  readonly limit?: number
}

export interface AccountAdminPort {
  list(query?: AccountAdminQueryLike): readonly AccountViewLike[] | Promise<readonly AccountViewLike[]>
  get(id: string): AccountViewLike | Promise<AccountViewLike>
  update(
    actor: string,
    id: string,
    patch: { label?: string; email?: string | null; subject?: string | null },
  ): Promise<unknown>
  enable(actor: string, id: string): Promise<unknown>
  disable(actor: string, id: string): Promise<unknown>
  remove(actor: string, id: string): Promise<unknown>
  importCredentials?(actor: string, id: string, input: unknown): Promise<unknown>
  importAccounts?(actor: string, input: unknown): Promise<unknown>
  previewImport?(input: unknown): unknown
}

// ───────────────────────────── 设置与 API key ─────────────────────────────

/** 设置插件的读/写面。只有运行中的 settings 服务才提供。 */
export interface SettingsPort {
  describe(): Promise<readonly unknown[]>
  update(actor: string, ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<unknown>
  reset(actor: string, ns: string): Promise<unknown>
}

/**
 * API key 服务。本分支还不存在，方法返回 `unknown`，HTTP 层只做形状归一化。
 * 约定：list 返回数组或 `{items}`；create / rotate 的返回值里带一次性 `secret`。
 */
export interface ApiKeyPort {
  list(userId: number): Promise<unknown>
  create(userId: number, input: { name: string }): Promise<unknown>
  update(userId: number, id: string, patch: { name?: string; enabled?: boolean }): Promise<unknown>
  remove(userId: number, id: string): Promise<unknown>
  rotate(userId: number, id: string): Promise<unknown>
}

export interface ApiKeySummaryView {
  readonly id: string
  readonly name: string
  readonly trackingId: string
  readonly maskedKey: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly appManaged: boolean
  readonly enabled: boolean
}

// ───────────────────────────── 账户优先级（可选） ─────────────────────────────

export interface AccountPriorityStatusLike {
  readonly state: string
  readonly bridgeConnected: boolean
  readonly transport: 'unix' | 'tcp' | null
  readonly address: string | null
  readonly revision: string | null
  readonly accounts: number
}

export interface AccountPriorityPort {
  status(): AccountPriorityStatusLike | Promise<AccountPriorityStatusLike>
}

// ───────────────────────────── 健康面 ─────────────────────────────

export type GatewayHealthState = 'ok' | 'degraded' | 'down'

export interface GatewayComponentHealth {
  readonly name: string
  readonly state: GatewayHealthState
  readonly detail?: string
}

export interface GatewayHealthView {
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

/**
 * HTTP 层需要的全部依赖；测试可以直接构造这个对象，不需要 cordis。
 *
 * `user` / `auth` 是必需依赖：没有身份就没有会话，产品入口整体不可用是合理的。
 * 其余服务（frontend / catalog / accountAdmin / settings / apiKey / accountPriority）
 * 全部在运行期按需解析：插件被禁用或正在重启时，只有对应路由 503，入口本身照常存活
 * （D5：禁用某个插件不应让整个用户站跟着 PENDING 消失）。
 */
export interface ApiRuntime {
  readonly config: import('./config.ts').ResolvedApiConfig
  readonly user: UserPort
  readonly auth: AuthPort
  frontend(): FrontendPort | undefined
  catalog(): CatalogPort | undefined
  accountAdmin(): AccountAdminPort | undefined
  settings(): SettingsPort | undefined
  apiKey(): ApiKeyPort | undefined
  accountPriority(): AccountPriorityPort | undefined
  now(): Date
  uptimeSec(): number
  log(level: 'info' | 'warn' | 'error', message: string): void
}
