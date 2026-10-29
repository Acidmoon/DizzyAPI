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
  /** 可选的全表计数；没有时管理概览退回分页 `list()` 统计。 */
  count?(): Promise<number>
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
  readonly baseUrl: string | null
  readonly protocol: string | null
  readonly models: string[] | null
  readonly modelMap: Record<string, string> | null
  readonly priority: number
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
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
  create?(actor: string, input: unknown): Promise<unknown>
  update(
    actor: string,
    id: string,
    patch: {
      label?: string
      email?: string | null
      subject?: string | null
      baseUrl?: string | null
      protocol?: string | null
      models?: string[] | null
      modelMap?: Record<string, string> | null
      priority?: number
    },
  ): Promise<unknown>
  enable(actor: string, id: string): Promise<unknown>
  disable(actor: string, id: string): Promise<unknown>
  remove(actor: string, id: string): Promise<unknown>
  importCredentials?(actor: string, id: string, input: unknown): Promise<unknown>
  importAccounts?(actor: string, input: unknown): Promise<unknown>
  previewImport?(input: unknown): unknown
  /** 连通性测试：不发秘密、不回显秘密；返回状态码与耗时。 */
  testConnection?(id: string, input: { model?: string; protocol?: string }): Promise<AccountTestResultLike>
  /** 导入来源预检：逐条归一化，不含凭据。 */
  previewImportSource?(input: unknown): unknown
  /** 导入来源批量创建：部分成功，逐条返回结果。 */
  importSource?(actor: string, input: unknown): Promise<unknown>
}

export interface AccountTestResultLike {
  readonly ok: boolean
  readonly status: number | null
  readonly latencyMs: number
  readonly model: string | null
  readonly protocol: string | null
  readonly error: string | null
  readonly testedAt: string
}

// ───────────────────────────── 用量与价格 ─────────────────────────────

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
}

export interface UsageUserBreakdownLike extends UsageTotalsLike {
  readonly userId: number
}

export interface UsageSummaryLike {
  readonly totals: UsageTotalsLike
  readonly daily: readonly UsageDailyPointLike[]
  readonly models: readonly UsageModelBreakdownLike[]
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
  summary(query: UsageQueryLike): UsageSummaryLike
  stats(nowMs?: number): UsageStatsLike
  exportRows(query: UsageQueryLike, limit?: number): readonly UsageRowLike[]
  status(): UsageStatusLike
  listRejected(query?: UsageRejectedQueryLike): UsageRejectedPageLike
  ignoreRejected(reqId: string): void
  replayRejected(reqId: string): Promise<UsageReplayResultLike>
}

export interface ModelPriceLike {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: string
  readonly updatedAt: string
}

export interface ModelPriceInputLike {
  readonly inputPerMillion: string | number
  readonly outputPerMillion: string | number
  readonly cacheReadPerMillion?: string | number
  readonly cacheWritePerMillion?: string | number
}

export interface PricingPort {
  list(): readonly ModelPriceLike[]
  get(model: string): ModelPriceLike | null
  set(actor: string, model: string, input: ModelPriceInputLike): Promise<ModelPriceLike>
  remove(actor: string, model: string): Promise<boolean>
}

// ───────────────────────────── 模型广场 ─────────────────────────────

export interface ModelEntryLike {
  readonly model: string
  readonly priced: boolean
  readonly price: ModelPriceLike | null
  readonly accountCount: number
  readonly healthyAccountCount: number
  readonly protocols: readonly string[]
  readonly upstreamModels: readonly string[]
  readonly mapped: boolean
}

export interface ModelUnavailableEntryLike {
  readonly model: string
  readonly reason: string
  readonly detail: string
  readonly accountCount: number
  readonly price: ModelPriceLike | null
  readonly priced: boolean
}

export interface ModelCatalogSummaryLike {
  readonly total: number
  readonly availableCount: number
  readonly unavailableCount: number
  readonly pricedCount: number
  readonly accountCount: number
}

export interface ModelCatalogLike {
  readonly available: readonly ModelEntryLike[]
  readonly unavailable: readonly ModelUnavailableEntryLike[]
  readonly summary: ModelCatalogSummaryLike
}

/** 模型广场服务（只读聚合）：`/api/models` 与 `/console/models` 共用一份事实。 */
export interface ModelHubPort {
  catalog(query?: {
    readonly search?: string
    readonly availability?: 'all' | 'available' | 'unavailable'
    readonly priced?: 'all' | 'priced' | 'unpriced'
  }): ModelCatalogLike
}

// ───────────────────────────── 管理员审计 ─────────────────────────────

/** 一次操作的结果（审计侧同一套取值）。 */
export type AuditResultLike = 'ok' | 'failed'

/** 写一条审计记录的形状（api 只往 `record` 里塞这些字段）。 */
export interface AuditEntryLike {
  readonly actor: string
  readonly actorPlugin: string
  readonly action: string
  readonly targetType?: string
  readonly targetId?: string
  readonly summary: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly result?: AuditResultLike
  readonly errorCode?: string | null
  readonly atMs?: number
}

/** 落库后的一条审计记录（响应里原样给出，元数据已脱敏）。 */
export interface AuditRecordLike {
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
  readonly result: AuditResultLike
  readonly errorCode: string | null
}

/** `/api/admin/audit` 的查询条件。 */
export interface AuditQueryLike {
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

export interface AuditPageLike {
  readonly items: readonly AuditRecordLike[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}

export interface AuditStatsLike {
  readonly total: number
  readonly today: number
  readonly last24h: number
  readonly failed: number
  readonly lastAt: string | null
  readonly byAction: readonly { readonly action: string; readonly count: number }[]
  readonly byActor: readonly { readonly actor: string; readonly count: number }[]
}

/**
 * 审计服务端口。
 *
 * `record` 用来写（不设限），`list` / `stats` 是**读**，要求 actor 在审计插件的
 * `adminPlugins` 白名单里（默认拒绝）。
 */
export interface AuditPort {
  record(entry: AuditEntryLike): unknown
  list(actor: string, query?: AuditQueryLike): AuditPageLike
  stats(actor: string): AuditStatsLike
}

// ───────────────────────────── 运维总览 ─────────────────────────────

/**
 * 运维总览服务端口。
 *
 * `observe()` 返回的是一份**已经 JSON 友好**的报告：金额是十进制字符串、没有 bigint、
 * 没有账号 id / label / baseUrl / 秘密（由 observability 插件保证）。所以 HTTP 层直接透传，
 * 不再做二次转换——这也让「插件与接口看到的是同一份事实」。
 */
export interface ObservabilityPort {
  observe(nowMs?: number): Promise<unknown>
}

// ───────────────────────────── 内容审核 ─────────────────────────────

/** 一条内容审核规则（管理面视图）。规则本身是关键词，不含任何秘密。 */
export interface ContentAuditRuleLike {
  readonly id: string
  readonly pattern: string
  readonly action: 'block' | 'log'
  readonly category?: string
  readonly enabled: boolean
  readonly note?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 新建规则的入参；HTTP 层只做形状校验，语义（长度 / 去重 / 上限）由插件判。 */
export interface ContentAuditRuleInputLike {
  readonly pattern: string
  readonly action?: 'block' | 'log'
  readonly category?: string
  readonly enabled?: boolean
  readonly note?: string
}

/**
 * 修改规则的入参：没给的字段保持不变（`enabled` 用来启停单条规则）。
 *
 * `category` / `note` 给 `null` 表示清空（与账号标签同一套「PATCH 里 null = 清空」约定）。
 */
export interface ContentAuditRulePatchLike {
  readonly pattern?: string
  readonly action?: 'block' | 'log'
  readonly category?: string | null
  readonly enabled?: boolean
  readonly note?: string | null
}

/** Go 侧命中统计；读不到 Go 时整块是 `null`，**不编造 0**。 */
export interface ContentAuditHitsLike {
  readonly blocked: number
  readonly logged: number
  readonly allowedStale: number
  readonly strictFailed: number
  readonly parseFailed: number
  readonly noText: number
  readonly truncated: number
  readonly ruleHitTotal: number
  readonly byRule: Readonly<Record<string, number>>
  readonly staleStreak: number
}

/**
 * 插件状态：本地推送健康度 + Go 侧快照新鲜度 + 命中统计。
 *
 * `ageMs` / `ttlMs` / `stale` / `goReady` / `hits` 读不到 Go 时是 `null`：
 * 桥断或旧二进制不能伪装成「新鲜、零命中」。
 */
export interface ContentAuditStatusLike {
  readonly enabled: boolean
  readonly pushIntervalMs: number
  readonly ruleCount: number
  readonly revision: string | null
  readonly generation: number
  readonly ageMs: number | null
  readonly ttlMs: number | null
  readonly stale: boolean | null
  readonly goReady: boolean | null
  readonly lastPushAt: string | null
  readonly lastError: string | null
  readonly pushes: number
  readonly heartbeats: number
  readonly failureStreak: number
  readonly goTtlMs: number | null
  readonly heartbeatTooSlow: boolean
  readonly hits: ContentAuditHitsLike | null
}

/**
 * 内容审核服务端口。
 *
 * 读与写都要求 actor 在插件的 `adminPlugins` 白名单里（`api` 以自己的插件名调用）。
 * 审计不在服务层记：`api` / `web` 在调用点用 `audited(...)` 留痕。
 */
export interface ContentAuditPort {
  list(actor: string): readonly ContentAuditRuleLike[]
  get(actor: string, id: string): ContentAuditRuleLike | null
  create(actor: string, input: ContentAuditRuleInputLike): Promise<ContentAuditRuleLike>
  update(actor: string, id: string, patch: ContentAuditRulePatchLike): Promise<ContentAuditRuleLike>
  remove(actor: string, id: string): Promise<boolean>
  status(): Promise<ContentAuditStatusLike>
  pushNow(): Promise<string | null>
}

// ───────────────────────────── 设置与 API key ─────────────────────────────

/** 设置插件的读/写面。只有运行中的 settings 服务才提供。 */
export interface SettingsPort {
  /** 真实服务返回 `{ namespaces }`；旧实现返回数组，HTTP 层两种都接。 */
  describe(): Promise<unknown>
  update(actor: string, ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<unknown>
  reset(actor: string, ns: string): Promise<unknown>
}

/**
 * API key 服务。本分支还不存在，方法返回 `unknown`，HTTP 层只做形状归一化。
 *
 * 与 feat/api-keys 的真实形状：
 * - `list(userId)` → `ApiKeyView[]`（HTTP 层包成 `{ items }`）；
 * - `create(userId, { name })` / `rotate(userId, id)` →
 *   `{ key: ApiKeyView, secret: string }`（HTTP 层展开成扁平的 `CreatedApiKey`）。
 * 兼容旧实现的数组 / 扁平返回，但测试以真实形状为准。
 */
export interface ApiKeyPort {
  list(userId: number): Promise<unknown>
  create(userId: number, input: { name: string }): Promise<unknown>
  update(userId: number, id: string, patch: { name?: string; enabled?: boolean }): Promise<unknown>
  remove(userId: number, id: string): Promise<unknown>
  rotate(userId: number, id: string): Promise<unknown>
  /** 全站 key 计数（管理概览用）；拿到就不必为了一个数字加载整表。 */
  count?(): Promise<number>
  /** 管理面只读列表（掩码、无完整 key）；启用 / 停用拆分从这里读。 */
  listAll?(): Promise<unknown>
}

export interface ApiKeySummaryView {
  readonly id: string
  readonly name: string
  readonly trackingId: string
  readonly secret: string | null
  readonly maskedKey: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly appManaged: boolean
  readonly enabled: boolean
}

// ───────────────────────────── 兑换码 ─────────────────────────────

/**
 * 兑换码服务（`redeem`）的端口。
 *
 * 金额一律是 bigint 微元；HTTP 层负责把它们写成十进制字符串（浏览器用 BigInt 解析）。
 * 码明文只出现在 `createBatch` 的 `codes` 里，且只出现一次；其余视图只有掩码。
 */
export interface RedeemResultLike {
  readonly amount: bigint
  readonly balance: bigint
  readonly batchName: string
}

export interface RedemptionLike {
  readonly codeId: string
  readonly codeMask: string
  readonly amountMicro: bigint
  readonly batchName: string | null
  readonly redeemedAt: string | null
}

export interface RedeemBatchLike {
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

export interface RedeemCodeLike {
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

export interface RedeemCodePageLike {
  readonly items: readonly RedeemCodeLike[]
  readonly total: number
}

export interface RedeemStatsLike {
  readonly batches: number
  readonly codes: number
  readonly enabled: number
  readonly disabled: number
  readonly redeeming: number
  readonly used: number
  readonly expired: number
  readonly redeemedAmountMicro: bigint
}

export interface RedeemDeletionRejectionLike {
  readonly id: string
  readonly reason: string
}

export interface RedeemDeletionResultLike {
  readonly deleted: number
  readonly rejected: readonly RedeemDeletionRejectionLike[]
}

export interface CreateRedeemBatchInputLike {
  readonly name: string
  readonly amountMicro: bigint
  readonly count: number
  readonly expiresAt?: string | null
  readonly notes?: string | null
}

export interface CreateRedeemBatchResultLike {
  readonly batch: RedeemBatchLike
  readonly codes: readonly string[]
}

export interface RedeemPort {
  redeemCode(input: { readonly userId: number; readonly code: string }): Promise<RedeemResultLike>
  listMyRedemptions(userId: number, limit?: number): Promise<readonly RedemptionLike[]>
  createBatch(
    actor: string,
    input: CreateRedeemBatchInputLike,
  ): Promise<CreateRedeemBatchResultLike>
  listBatches(
    actor: string,
    query?: { readonly limit?: number; readonly offset?: number },
  ): Promise<readonly RedeemBatchLike[]>
  getBatch(actor: string, batchId: string): Promise<RedeemBatchLike>
  listCodes(
    actor: string,
    query?: {
      readonly batchId?: string
      readonly status?: string
      readonly keyword?: string
      readonly limit?: number
      readonly offset?: number
    },
  ): Promise<RedeemCodePageLike>
  setCodeStatus(actor: string, codeId: string, status: 'enabled' | 'disabled'): Promise<RedeemCodeLike>
  deleteCodes(actor: string, ids: readonly string[]): Promise<RedeemDeletionResultLike>
  resolveRedeeming(
    actor: string,
    codeId: string,
    outcome: 'used' | 'enabled',
  ): Promise<RedeemCodeLike>
  stats(actor: string): Promise<RedeemStatsLike>
}

// ───────────────────────────── 充值订单（可选） ─────────────────────────────

/**
 * 充值订单服务（`topup`）的端口。
 *
 * 金额一律 bigint 微元，HTTP 层写成十进制字符串；订单状态是稳定英文串。
 * 本批只有 `manual`（人工确认到账）——**没有在线支付**，也没有回调路由。
 */
export interface TopupOrderLike {
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

export interface TopupOrderPageLike {
  readonly items: readonly TopupOrderLike[]
  readonly total: number
}

export interface TopupOptionsLike {
  readonly currency: 'CNY'
  readonly providerId: string
  readonly providerLabel: string
  readonly online: boolean
  readonly minAmountMicros: bigint
  readonly maxAmountMicros: bigint
  readonly expiresMinutes: number
  readonly notice: string
}

export interface TopupStatsLike {
  readonly todayPaidCount: number
  readonly todayPaidMicros: bigint
  readonly totalPaidCount: number
  readonly totalPaidMicros: bigint
  readonly pendingCount: number
  readonly expiredCount: number
}

export interface ConfirmTopupResultLike {
  readonly order: TopupOrderLike
  /** false = 这笔订单此前已经到账（幂等命中，没有再加钱）。 */
  readonly credited: boolean
}

export interface TopupPort {
  options(): TopupOptionsLike
  createOrder(input: {
    readonly userId: number
    readonly amountYuan: unknown
    readonly provider?: string
    readonly note?: string | null
  }): Promise<{ readonly order: TopupOrderLike }>
  listMine(userId: number, limit?: number): TopupOrderPageLike
  getMine(userId: number, orderNo: string): TopupOrderLike
  cancelMine(userId: number, orderNo: string): TopupOrderLike
  list(
    actor: string,
    query?: {
      readonly status?: string
      readonly userId?: number
      readonly fromMs?: number
      readonly toMs?: number
      readonly limit?: number
      readonly offset?: number
    },
  ): TopupOrderPageLike
  confirmPaid(actor: string, orderNo: string): Promise<ConfirmTopupResultLike>
  cancel(actor: string, orderNo: string): TopupOrderLike
  stats(actor: string, nowMs?: number): TopupStatsLike
}

// ───────────────────────────── 结算（可选） ─────────────────────────────

/**
 * 结算服务（`billing`）的端口。
 *
 * 只读：真实扣费由 usage 的结算钩子驱动，HTTP 层没有写入口。金额一律 bigint 微元，
 * HTTP 层负责写成十进制字符串。
 */
export interface SettleRecordLike {
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
  /** 扣费后余额为负（后付费透支）：稳定布尔事实。 */
  readonly overdrawn: boolean
  /** 扣费之后的余额（整数微元）；没扣款时 null。 */
  readonly balanceAfter: bigint | null
  readonly status: string
  readonly note: string | null
  readonly attempts: number
  readonly startedAt: string
  readonly claimedAt: string | null
  readonly settledAt: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SettlePageLike {
  readonly items: readonly SettleRecordLike[]
  readonly total: number
}

export interface SettleTotalsLike {
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

export interface SettleDailyLike {
  readonly date: string
  readonly records: number
  readonly settled: number
  readonly chargedMicros: bigint
}

export interface SettleModelLike {
  readonly model: string
  readonly records: number
  readonly chargedMicros: bigint
}

export interface SettleSummaryLike {
  readonly totals: SettleTotalsLike
  readonly daily: readonly SettleDailyLike[]
  readonly models: readonly SettleModelLike[]
}

export interface BillingPort {
  list(
    actor: string,
    query?: { readonly status?: string; readonly userId?: number; readonly limit?: number; readonly offset?: number },
  ): SettlePageLike
  summary(actor: string, nowMs?: number): SettleSummaryLike
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
  /** 新前端 `web` 是否在运行；只用于健康检查判断「旧 SPA 已由 web 接管」。 */
  web(): unknown
  catalog(): CatalogPort | undefined
  accountAdmin(): AccountAdminPort | undefined
  settings(): SettingsPort | undefined
  apiKey(): ApiKeyPort | undefined
  accountPriority(): AccountPriorityPort | undefined
  usage(): UsagePort | undefined
  pricing(): PricingPort | undefined
  /** 模型广场（只读聚合）；不在运行时只有 /api/models 503。 */
  modelhub(): ModelHubPort | undefined
  /** 兑换码服务；不在运行时只有兑换相关路由 503（入口本身不受影响）。 */
  redeem(): RedeemPort | undefined
  /** 结算服务；不在运行时只有 /api/admin/billing 503（扣费暂停，用量照常落库）。 */
  billing(): BillingPort | undefined
  /** 充值订单服务；不在运行时只有充值相关路由 503（页面本身仍可打开）。 */
  topup(): TopupPort | undefined
  /** 审计服务；不在运行时只有 /api/admin/audit 503，写操作照常成功（审计是旁路）。 */
  audit(): AuditPort | undefined
  /** 运维总览（只读聚合）；不在运行时只有 /api/admin/observability 503。 */
  observability(): ObservabilityPort | undefined
  /** 内容审核规则；不在运行时只有内容审核相关路由 503，LLM 链路照常放行。 */
  contentAudit(): ContentAuditPort | undefined
  now(): Date
  uptimeSec(): number
  log(level: 'info' | 'warn' | 'error', message: string): void
}
