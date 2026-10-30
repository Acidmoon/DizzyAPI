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
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { ResolvedApiConfig } from './config.ts'
import { ApiError, notFound } from './errors.ts'
import type {
  AccountAdminPort,
  ApiKeyPort,
  ApiRuntime,
  BillingPort,
  CatalogPort,
  ContentAuditPort,
  FrontendPort,
  RedeemPort,
  SettingsPort,
  TopupPort,
  UsagePort,
} from './types.ts'
import { decodeSegment, isSpaPath } from './http_io.ts'
import { API_ACTOR, API_REQUEST_HEADER, API_VERSION, NO_STORE } from './constants.ts'

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
import { routeAdminUsage } from './routes/admin_usage.ts'
import { adminStats } from './routes/admin_stats.ts'
import { routeUsers } from './routes/admin_users.ts'
import { routeAccounts } from './routes/admin_accounts.ts'
import { routeSettings, catalogModules } from './routes/settings.ts'
import { isAssetPath, serveAsset, serveIndex } from './http_static.ts'
import { requireSession, requireAdmin, sessionResponse } from './http_session.ts'
import { allowRead, sendJson, sendMethodNotAllowed, respondError } from './http_respond.ts'

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
        sendMethodNotAllowed(this, req, res, ['GET', 'HEAD'])
        return
      }

      if (pathname === '/') {
        res.writeHead(303, { Location: '/console/usage', 'Cache-Control': NO_STORE })
        res.end()
        return
      }

      if (isAssetPath(this, pathname)) {
        await serveAsset(this, req, res, pathname)
        return
      }

      if (isSpaPath(pathname)) {
        await serveIndex(this, req, res)
        return
      }

      throw notFound('没有这个页面')
    } catch (error) {
      respondError(this, req, res, error)
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
      if (!allowRead(this, req, res)) return
      sendJson(this, req, res, 200, await health(this))
      return
    }
    if (parts.length === 2 && parts[0] === 'console' && parts[1] === 'manifest') {
      if (!allowRead(this, req, res)) return
      const frontend = this.requireFrontend()
      sendJson(this, req, res, 200, await frontend.manifest(), { 'Cache-Control': NO_STORE })
      return
    }
    if (parts[0] === 'auth') {
      await routeAuth(this, req, res, parts)
      return
    }

    // 需要会话
    if (parts.length === 1 && parts[0] === 'session') {
      if (!allowRead(this, req, res)) return
      const view = await requireSession(this, req)
      sendJson(this, req, res, 200, await sessionResponse(this, view))
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
      if (!allowRead(this, req, res)) return
      sendJson(this, req, res, 200, await usage(this, req, url))
      return
    }
    if (parts.length === 2 && parts[0] === 'usage' && parts[1] === 'export') {
      if (!allowRead(this, req, res)) return
      await usageExport(this, req, res, url)
      return
    }
    // GET /api/usage/:reqId —— 单条用量详情（详情弹窗用）。
    // 必须排在 `usage/export` 之后：那个是固定子路径，不能被当成 reqId。
    if (parts.length === 2 && parts[0] === 'usage') {
      if (!allowRead(this, req, res)) return
      await usageDetail(this, req, res, parts[1] as string)
      return
    }
    if (parts[0] === 'pricing') {
      await routePricing(this, req, res, parts)
      return
    }
    if (parts.length === 1 && parts[0] === 'models') {
      await routeModels(this, req, res, url)
      return
    }
    if (parts[0] === 'topup') {
      await routeTopup(this, req, res, parts, url)
      return
    }
    if (parts[0] === 'redeem') {
      await routeRedeem(this, req, res, parts, url)
      return
    }

    // 管理员面
    if (parts[0] === 'admin' && parts[1] === 'redeem-codes') {
      await routeAdminRedeemCodes(this, req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'redeem-batches') {
      await routeAdminRedeemBatches(this, req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'redeem-stats') {
      await routeAdminRedeemStats(this, req, res)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'billing') {
      await routeAdminBilling(this, req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'topup-orders') {
      await routeAdminTopupOrders(this, req, res, parts, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'audit') {
      await routeAdminAudit(this, req, res, url)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'content-audit') {
      await routeAdminContentAudit(this, req, res, parts)
      return
    }
    if (parts.length === 2 && parts[0] === 'admin' && parts[1] === 'observability') {
      await routeAdminObservability(this, req, res)
      return
    }
    if (parts[0] === 'admin' && parts[1] === 'usage') {
      await routeAdminUsage(this, req, res, parts, url)
      return
    }
    if (parts.length === 2 && parts[0] === 'admin' && parts[1] === 'stats') {
      if (!allowRead(this, req, res)) return
      await adminStats(this, req, res)
      return
    }
    if (parts[0] === 'users') {
      await routeUsers(this, req, res, parts)
      return
    }
    if (parts[0] === 'accounts') {
      await routeAccounts(this, req, res, parts)
      return
    }
    if (parts.length === 2 && parts[0] === 'catalog' && parts[1] === 'modules') {
      if (!allowRead(this, req, res)) return
      await requireAdmin(this, req)
      const catalog = this.requireCatalog()
      sendJson(this, req, res, 200, await catalogModules(this, catalog))
      return
    }
    if (parts[0] === 'settings') {
      await routeSettings(this, req, res, parts)
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
}