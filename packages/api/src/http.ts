/**
 * 产品 HTTP 入口（同源 SPA + /api/*）。
 *
 * 访问控制（与开发者面板同一套思路，见 packages/admin/src/http.ts）：
 *
 * 1. `Host` 必须等于实际监听地址（`127.0.0.1:<port>` 或 `localhost:<port>`），
 *    挡 DNS rebinding；
 * 2. `Origin` 若存在必须同源；`Sec-Fetch-Site: cross-site` 一律拒绝；
 * 3. **所有 `/api/*`** 都要求 `X-Requested-With: dizzyapi`（GET 也要）。
 *    浏览器发自定义头会先预检，而我们**不发任何 CORS 头**，第三方页面发不出来；
 *    它同时挡住 `<form>` 这类不带自定义头的跨站提交；
 * 4. 会话只走 HttpOnly cookie，不进 JSON、日志、URL。
 *
 * 只用 `node:http` / `node:fs` / `node:crypto` 等标准库：这是产品入口，
 * 不引第三方运行时依赖。
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { BALANCE_MINOR_UNITS_PER_CENT, type ResolvedApiConfig } from './config.ts'
import { audited, auditActorOf } from './audit.ts'
import { ApiError, badRequest, forbidden, isApiError, notFound, toApiError, unauthorized } from './errors.ts'
import type {
  AccountAdminPort,
  AccountPriorityPort,
  AccountViewLike,
  AdminUserView,
  ApiKeyPort,
  ApiKeySummaryView,
  ApiRuntime,
  AuditQueryLike,
  AuthPort,
  BillingPort,
  CatalogModuleView,
  CatalogPort,
  ContentAuditPort,
  ContentAuditRuleInputLike,
  ContentAuditRuleLike,
  ContentAuditRulePatchLike,
  ContentAuditStatusLike,
  FrontendPageLike,
  FrontendPort,
  GatewayComponentHealth,
  GatewayHealthState,
  GatewayHealthView,
  LoginResultLike,
  ModelCatalogLike,
  ModelEntryLike,
  ModelPriceInputLike,
  ModelPriceLike,
  PricingPort,
  RedeemBatchLike,
  RedeemCodeLike,
  RedeemPort,
  RedeemResultLike,
  RedeemStatsLike,
  RedemptionLike,
  SessionInfoView,
  SessionRole,
  SessionUserView,
  SessionViewLike,
  SettleDailyLike,
  SettleModelLike,
  SettleRecordLike,
  SettleSummaryLike,
  SettleTotalsLike,
  SettingsPort,
  TopupOptionsLike,
  TopupOrderLike,
  TopupPort,
  TopupStatsLike,
  UsageDailyPointLike,
  UsageModelBreakdownLike,
  UsagePort,
  UsageQueryLike,
  UsageRejectedQueryLike,
  UsageRejectedRowLike,
  UsageRowLike,
  UsageTotalsLike,
  UsageUserBreakdownLike,
  UserLike,
  UserPort,
  UserStatusLike,
} from './types.ts'
import { contentTypeOf, decodeSegment, deviceMeta, isSpaPath, readBody, readCookie, requestIdOf } from './http_io.ts'
import { accountCredentialOf, assertOnlyKeys, errorCodeOf, isPlainObject, nullableString, nullableStringArray, nullableStringMap, optionalAvatar, optionalInteger, optionalString, optionalStringArray, optionalStringMap, parseIntegerParam, parsePositiveInteger, queryStringOf, readStringArray, requiredBoolean, requiredInteger, requiredMicros, requiredString, safeJson } from './params.ts'
import { centsOf, dateOf } from './views/common.ts'
import { adminUsageCsv, adminUsageRowOf, rejectedRowOf, usageCsv, usageDailyOf, usageDetailOf, usageModelOf, usageRowOf, usageTotalsOf, usageUserOf } from './views/usage.ts'
import { adminUserOf, parseUserId, roleOf, sessionInfoOf, sessionUserOf } from './views/session.ts'
import { redeemBatchOf, redeemCodeOf, redeemResultOf, redeemStatsOf, redemptionOf, settleDailyOf, settleModelOf, settleRecordOf, settleTotalsOf, topupOptionsOf, topupOrderOf, topupStatsOf } from './views/commerce.ts'
import { catalogState, modelCatalogOf, priorityState } from './views/catalog.ts'
import { accountOf, keyPortResult, normalizeBulkImport, normalizeCreatedKey, normalizeKeyList, normalizeKeySummary } from './views/account.ts'
import { contentAuditInputOf, contentAuditPatchOf, contentAuditRuleMetadata, contentAuditRuleOf, contentAuditStatusOf } from './views/audit.ts'
import { ADMIN_USAGE_EXPORT_LIMIT, API_ACTOR, API_REQUEST_HEADER, API_VERSION, CONTENT_SECURITY_POLICY, IMMUTABLE, NO_STORE, STATS_USER_MAX_PAGES, STATS_USER_PAGE, USAGE_RANGE_DAYS, UsageRange } from './constants.ts'

export { API_ACTOR, API_REQUEST_HEADER, API_VERSION } from './constants.ts'
import { health } from './routes/health.ts'
import { routeAuth } from './routes/auth.ts'
import { routeProfile } from './routes/profile.ts'
import { routeKeys } from './routes/keys.ts'
import { usage, usageExport, usageDetail } from './routes/usage.ts'
import { routePricing } from './routes/pricing.ts'
import { routeModels } from './routes/models.ts'
import { routeTopup } from './routes/topup.ts'
import { routeRedeem } from './routes/redeem.ts'
import { routeAdminRedeemCodes, routeAdminRedeemBatches, routeAdminRedeemStats } from './routes/admin_redeem.ts'
import { routeAdminBilling } from './routes/admin_billing.ts'
import { routeAdminTopupOrders } from './routes/admin_topup.ts'
import { routeAdminAudit } from './routes/admin_audit.ts'
import { routeAdminContentAudit } from './routes/admin_content_audit.ts'
import { routeAdminObservability } from './routes/admin_observability.ts'
import { routeAdminUsage, adminUsageQuery, userNameResolver } from './routes/admin_usage.ts'
import { routeAdminUsageRejected, adminRejectedView } from './routes/admin_usage_rejected.ts'
import { adminStats, allUsers } from './routes/admin_stats.ts'
import { routeUsers } from './routes/admin_users.ts'
import { routeAccounts } from './routes/admin_accounts.ts'
import { routeSettings, catalogModules } from './routes/settings.ts'
import { assetPrefix, isAssetPath, serveAsset, serveIndex, frontendEnabled } from './http_static.ts'
import { sessionToken, requireSession, requireAdmin, sessionResponse, loginResponse, emailOf, setSessionCookie, clearSessionCookie, secureCookie } from './http_session.ts'
import { allowRead, allowMethod, jsonBody, sendJson, sendBody, sendMethodNotAllowed, respondError } from './http_respond.ts'

/**
 * HTTP 服务器。它只依赖 `ApiRuntime` 这组端口，不 import 任何具体插件类；
 * 测试可以直接构造运行时，不需要拉起 cordis。
 */
export class ApiServer {
  readonly runtime: ApiRuntime
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
  readonly config: ResolvedApiConfig
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
  private server: Server | undefined
  port = 0
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
  private stopTask: Promise<void> | undefined

  constructor(runtime: ApiRuntime) {
    this.runtime = runtime
    this.config = runtime.config
  }

  get address(): { readonly host: '127.0.0.1'; readonly port: number } | undefined {
    return this.server === undefined ? undefined : { host: '127.0.0.1', port: this.port }
  }

  get origin(): string | undefined {
    return this.server === undefined ? undefined : `http://127.0.0.1:${this.port}`
  }

  get listening(): boolean {
    return this.server !== undefined
  }

  /** 绑 127.0.0.1；端口冲突直接失败，不静默换端口。 */
  start(port: number = this.config.port): Promise<void> {
    if (this.server !== undefined) {
      throw new ApiError('API_INTERNAL', 500, '产品 HTTP 入口已经启动过了')
    }
    const server = createServer((req, res) => {
      void this.dispatch(req, res)
    })
    this.server = server

    return new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening)
        this.server = undefined
        reject(error)
      }
      const onListening = (): void => {
        server.off('error', onError)
        const address = server.address()
        if (address === null || typeof address === 'string') {
          this.server = undefined
          reject(new ApiError('API_INTERNAL', 500, '产品 HTTP 入口没有拿到 TCP 地址'))
          return
        }
        this.port = address.port
        server.on('error', (error) => {
          if (this.server !== undefined) this.runtime.log('error', `产品 HTTP 入口错误：${error.message}`)
        })
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  /** 停止监听并断开所有连接。幂等。 */
  async stop(): Promise<void> {
    if (this.stopTask !== undefined) return this.stopTask
    const server = this.server
    if (server === undefined) return
    const task = new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
    this.stopTask = task
    try {
      await task
    } finally {
      if (this.server === server) this.server = undefined
      this.port = 0
      this.stopTask = undefined
    }
  }

  // ───────────────────────────────── 分发 ─────────────────────────────────

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Request-Id', randomBytes(8).toString('hex'))
    try {
      this.assertHost(req)
      this.assertOrigin(req)

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      const pathname = url.pathname

      if (pathname === '/api' || pathname.startsWith('/api/')) {
        this.assertApiRequestHeader(req)
        await this.routeApi(req, res, url)
        return
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendMethodNotAllowed(req, res, ['GET', 'HEAD'])
        return
      }

      if (pathname === '/') {
        res.writeHead(303, { Location: '/console/usage', 'Cache-Control': NO_STORE })
        res.end()
        return
      }

      if (this.isAssetPath(pathname)) {
        await this.serveAsset(req, res, pathname)
        return
      }

      if (isSpaPath(pathname)) {
        await this.serveIndex(req, res)
        return
      }

      throw notFound('没有这个页面')
    } catch (error) {
      this.respondError(req, res, error)
    }
  }

  private assertHost(req: IncomingMessage): void {
    const host = req.headers.host
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    if (typeof host !== 'string' || !allowed.includes(host)) {
      throw new ApiError('API_HOST_FORBIDDEN', 403, `Host 必须是 ${allowed.join(' 或 ')}`)
    }
  }

  private assertOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin
    if (origin !== undefined) {
      const allowed = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`]
      if (typeof origin !== 'string' || !allowed.includes(origin)) {
        throw new ApiError('API_ORIGIN_FORBIDDEN', 403, 'Origin 必须与网关同源')
      }
    }
    const site = req.headers['sec-fetch-site']
    if (site === 'cross-site') {
      throw new ApiError('API_ORIGIN_FORBIDDEN', 403, '拒绝跨站请求（Sec-Fetch-Site: cross-site）')
    }
  }

  private assertApiRequestHeader(req: IncomingMessage): void {
    const value = req.headers['x-requested-with']
    if (typeof value !== 'string' || value !== API_REQUEST_HEADER) {
      throw new ApiError(
        'API_REQUEST_HEADER_REQUIRED',
        403,
        `所有 /api/* 请求都必须带 X-Requested-With: ${API_REQUEST_HEADER}`,
      )
    }
  }

  // ───────────────────────────────── API 路由 ─────────────────────────────────

  private async routeApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const pathname = url.pathname
    if (pathname === '/api' || pathname === '/api/') throw notFound('没有这个接口')

    const raw = pathname.slice('/api/'.length).replace(/\/$/, '')
    const parts = raw.split('/').map(decodeSegment)
    if (parts.length === 0 || parts[0] === '') throw notFound('没有这个接口')

    // 公开面
    if (parts.length === 1 && parts[0] === 'health') {
      if (!this.allowRead(req, res)) return
      sendJson(this, req, res, 200, await health(this))
      return
    }
    if (parts.length === 2 && parts[0] === 'console' && parts[1] === 'manifest') {
      if (!this.allowRead(req, res)) return
      const frontend = this.requireFrontend()
      this.sendJson(req, res, 200, await frontend.manifest(), { 'Cache-Control': NO_STORE })
      return
    }
    if (parts[0] === 'auth') {
      await routeAuth(this, req, res, parts)
      return
    }

    // 需要会话
    if (parts.length === 1 && parts[0] === 'session') {
      if (!this.allowRead(req, res)) return
      const view = await this.requireSession(req)
      this.sendJson(req, res, 200, await this.sessionResponse(view))
      return
    }
    if (parts[0] === 'profile') {
      await routeProfile(this, req, res, parts)
      return
    }
    if (parts[0] === 'keys') {
      await routeKeys(this, req, res, parts)
      return
    }
    if (parts.length === 1 && parts[0] === 'usage') {
      if (!this.allowRead(req, res)) return
      sendJson(this, req, res, 200, await usage(this, req, url))
      return
    }
    if (parts.length === 2 && parts[0] === 'usage' && parts[1] === 'export') {
      if (!this.allowRead(req, res)) return
      await usageExport(this, req, res, url)
      return
    }
    // GET /api/usage/:reqId —— 单条用量详情（详情弹窗用）。
    // 必须排在 `usage/export` 之后：那个是固定子路径，不能被当成 reqId。
    if (parts.length === 2 && parts[0] === 'usage') {
      if (!this.allowRead(req, res)) return
      await usageDetail(this, req, res, parts[1] as string)
      return
    }
    if (parts[0] === 'pricing') {
      await this.routePricing(req, res, parts)
      return
    }
    if (parts.length === 1 && parts[0] === 'models') {
      await this.routeModels(req, res, url)
      return
    }
    if (parts[0] === 'topup') {
      await this.routeTopup(req, res, parts, url)
      return
    }
    if (parts[0] === 'redeem') {
      await this.routeRedeem(req, res, parts, url)
      return
    }

    // 管理员面
    if (parts[0] === 'admin' && parts[1] === 'redeem-codes') {
      await this.routeAdminRedeemCodes(req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'redeem-batches') {
      await this.routeAdminRedeemBatches(req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'redeem-stats') {
      await this.routeAdminRedeemStats(req, res)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'billing') {
      await this.routeAdminBilling(req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'topup-orders') {
      await this.routeAdminTopupOrders(req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'audit') {
      await this.routeAdminAudit(req, res, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'content-audit') {
      await this.routeAdminContentAudit(req, res, parts)
      return
    }
    if (parts.length === 2 && parts[0] === 'admin' && parts[1] === 'observability') {
      await this.routeAdminObservability(req, res)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'usage') {
      await this.routeAdminUsage(req, res, parts, url)
      return
    }
    if (parts.length === 2 && parts[0] === 'admin' && parts[1] === 'stats') {
      if (!this.allowRead(req, res)) return
      await this.adminStats(req, res)
      return
    }
    if (parts[0] === 'users') {
      await this.routeUsers(req, res, parts)
      return
    }
    if (parts[0] === 'accounts') {
      await this.routeAccounts(req, res, parts)
      return
    }
    if (parts.length === 2 && parts[0] === 'catalog' && parts[1] === 'modules') {
      if (!this.allowRead(req, res)) return
      await this.requireAdmin(req)
      const catalog = this.requireCatalog()
      this.sendJson(req, res, 200, await this.catalogModules(catalog))
      return
    }
    if (parts[0] === 'settings') {
      await this.routeSettings(req, res, parts)
      return
    }

    throw notFound('没有这个接口')
  }

  // ───────────────────────────────── 内部工具 ─────────────────────────────────

  requireFrontend(): FrontendPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const frontend = this.runtime.frontend()
    if (frontend === undefined) {
      throw new ApiError('FRONTEND_UNAVAILABLE', 503, '前端宿主不在运行：静态资源与 SPA 暂时不可用')
    }
    return frontend
  }

  private requireCatalog(): CatalogPort {
    const catalog = this.runtime.catalog()
    if (catalog === undefined) {
      throw new ApiError('CATALOG_UNAVAILABLE', 503, '能力目录不在运行')
    }
    return catalog
  }

  requireAccountAdmin(): AccountAdminPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const accountAdmin = this.runtime.accountAdmin()
    if (accountAdmin === undefined) {
      throw new ApiError('ACCOUNT_ADMIN_UNAVAILABLE', 503, '账号管理门面不在运行')
    }
    return accountAdmin
  }

  requireApiKey(): ApiKeyPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const apiKey = this.runtime.apiKey()
    if (apiKey === undefined) {
      throw new ApiError('API_KEY_UNAVAILABLE', 503, 'API key 服务不在运行')
    }
    return apiKey
  }

  requireUsage(): UsagePort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const usage = this.runtime.usage()
    if (usage === undefined) {
      throw new ApiError('API_ADMIN_USAGE_UNAVAILABLE', 503, '用量插件不在运行')
    }
    return usage
  }

  requireSettings(): SettingsPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const settings = this.runtime.settings()
    if (settings === undefined) {
      throw new ApiError('API_SETTINGS_UNAVAILABLE', 503, '设置插件不在运行')
    }
    return settings
  }

  requireRedeem(): RedeemPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const redeem = this.runtime.redeem()
    if (redeem === undefined) {
      throw new ApiError('REDEEM_UNAVAILABLE', 503, '兑换码服务不在运行')
    }
    return redeem
  }

  requireBilling(): BillingPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const billing = this.runtime.billing()
    if (billing === undefined) {
      throw new ApiError(
        'BILLING_UNAVAILABLE',
        503,
        '结算服务不在运行：扣费已暂停，用量仍照常落库',
      )
    }
    return billing
  }

  requireTopup(): TopupPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const topup = this.runtime.topup()
    if (topup === undefined) {
      throw new ApiError('TOPUP_UNAVAILABLE', 503, '充值订单服务不在运行：暂时不能下单或确认到账')
    }
    return topup
  }

  requireContentAudit(): ContentAuditPort {
  // 供 routes/* 经 host 读取（TS 没有包级可见性），行为不变。
    const contentAudit = this.runtime.contentAudit()
    if (contentAudit === undefined) {
      throw new ApiError(
        'CONTENT_AUDIT_UNAVAILABLE',
        503,
        '内容审核插件不在运行：暂时不能维护审核规则（LLM 请求照常放行）',
      )
    }
    return contentAudit
  }
  /** @internal 实现在 routes/pricing.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routePricing(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
): Promise<void> {
    return await routePricing(this, req, res, parts)
  }

  /** @internal 实现在 routes/models.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeModels(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return await routeModels(this, req, res, url)
  }

  /** @internal 实现在 routes/topup.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeTopup(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeTopup(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/redeem.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeRedeem(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeRedeem(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/admin_redeem.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminRedeemCodes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeAdminRedeemCodes(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/admin_redeem.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminRedeemBatches(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeAdminRedeemBatches(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/admin_redeem.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminRedeemStats(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
    return await routeAdminRedeemStats(this, req, res)
  }

  /** @internal 实现在 routes/admin_billing.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminBilling(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeAdminBilling(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/admin_topup.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminTopupOrders(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeAdminTopupOrders(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/admin_audit.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminAudit(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
    return await routeAdminAudit(this, req, res, url)
  }

  /** @internal 实现在 routes/admin_content_audit.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminContentAudit(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
): Promise<void> {
    return await routeAdminContentAudit(this, req, res, parts)
  }

  /** @internal 实现在 routes/admin_observability.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminObservability(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
    return await routeAdminObservability(this, req, res)
  }

  /** @internal 实现在 routes/admin_usage.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminUsage(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
): Promise<void> {
    return await routeAdminUsage(this, req, res, parts, url)
  }

  /** @internal 实现在 routes/admin_usage.ts（薄委派；注释与实现在那边，这里只转发）。 */
adminUsageQuery(url: URL): {
  readonly range: UsageRange
  readonly from: string
  readonly to: string
  readonly query: UsageQueryLike
} {
    return adminUsageQuery(this, url)
  }

  /** @internal 实现在 routes/admin_usage.ts（薄委派；注释与实现在那边，这里只转发）。 */
userNameResolver(): (userId: number) => Promise<string | null> {
    return userNameResolver(this)
  }

  /** @internal 实现在 routes/admin_usage_rejected.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAdminUsageRejected(
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
  url: URL,
  actor: string,
): Promise<void> {
    return await routeAdminUsageRejected(this, req, res, parts, url, actor)
  }

  /** @internal 实现在 routes/admin_usage_rejected.ts（薄委派；注释与实现在那边，这里只转发）。 */
adminRejectedView(
  usage: UsagePort,
  url: URL,
): {
  items: ReturnType<typeof rejectedRowOf>[]
  total: number
  pending: number
  limit: number
  offset: number
} {
    return adminRejectedView(this, usage, url)
  }

  /** @internal 实现在 routes/admin_stats.ts（薄委派；注释与实现在那边，这里只转发）。 */
async adminStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return await adminStats(this, req, res)
  }

  /** @internal 实现在 routes/admin_stats.ts（薄委派；注释与实现在那边，这里只转发）。 */
async allUsers(): Promise<UserLike[]> {
    return await allUsers(this)
  }

  /** @internal 实现在 routes/admin_users.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeUsers(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    return await routeUsers(this, req, res, parts)
  }

  /** @internal 实现在 routes/admin_accounts.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeAccounts(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    return await routeAccounts(this, req, res, parts)
  }

  /** @internal 实现在 routes/settings.ts（薄委派；注释与实现在那边，这里只转发）。 */
async routeSettings(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    return await routeSettings(this, req, res, parts)
  }

  /** @internal 实现在 routes/settings.ts（薄委派；注释与实现在那边，这里只转发）。 */
async catalogModules(
  catalog: CatalogPort,
): Promise<{ generatedAt: string; modules: readonly CatalogModuleView[] }> {
    return await catalogModules(this, catalog)
  }

  /** @internal 实现在 http_static.ts（薄委派；注释与实现在那边，这里只转发）。 */
assetPrefix(): string {
    return assetPrefix(this)
  }

  /** @internal 实现在 http_static.ts（薄委派；注释与实现在那边，这里只转发）。 */
isAssetPath(pathname: string): boolean {
    return isAssetPath(this, pathname)
  }

  /** @internal 实现在 http_static.ts（薄委派；注释与实现在那边，这里只转发）。 */
async serveAsset(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    return await serveAsset(this, req, res, pathname)
  }

  /** @internal 实现在 http_static.ts（薄委派；注释与实现在那边，这里只转发）。 */
async serveIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return await serveIndex(this, req, res)
  }

  /** @internal 实现在 http_static.ts（薄委派；注释与实现在那边，这里只转发）。 */
async frontendEnabled(frontend: FrontendPort): Promise<boolean> {
    return await frontendEnabled(this, frontend)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
sessionToken(req: IncomingMessage): string {
    return sessionToken(this, req)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
async requireSession(req: IncomingMessage): Promise<SessionViewLike> {
    return await requireSession(this, req)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
async requireAdmin(req: IncomingMessage): Promise<{ view: SessionViewLike; role: SessionRole }> {
    return await requireAdmin(this, req)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
async sessionResponse(view: SessionViewLike): Promise<unknown> {
    return await sessionResponse(this, view)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
loginResponse(result: LoginResultLike): unknown {
    return loginResponse(this, result)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
async emailOf(userId: number): Promise<string | null> {
    return await emailOf(this, userId)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
setSessionCookie(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  expiresAt: string,
): void {
    return setSessionCookie(this, req, res, token, expiresAt)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    return clearSessionCookie(this, req, res)
  }

  /** @internal 实现在 http_session.ts（薄委派；注释与实现在那边，这里只转发）。 */
secureCookie(req: IncomingMessage): string {
    return secureCookie(this, req)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
allowRead(req: IncomingMessage, res: ServerResponse): boolean {
    return allowRead(this, req, res)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
allowMethod(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean {
    return allowMethod(this, req, res, allowed)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
async jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return await jsonBody(this, req)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
    return sendJson(this, req, res, status, value, headers)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
sendBody(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): void {
    return sendBody(this, req, res, status, contentType, body, headers)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
sendMethodNotAllowed(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): void {
    return sendMethodNotAllowed(this, req, res, allowed)
  }

  /** @internal 实现在 http_respond.ts（薄委派；注释与实现在那边，这里只转发）。 */
respondError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    return respondError(this, req, res, error)
  }

}