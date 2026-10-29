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

/** 写操作在白名单里自报的身份；必须出现在 user / account-admin / settings 的 adminPlugins 里。 */
export const API_ACTOR = '@dizzyapi/plugin-api'

/** `/api/*` 的自定义请求头值。 */
export const API_REQUEST_HEADER = 'dizzyapi'

export const API_VERSION = '0.1.0'

const NO_STORE = 'no-store'
const IMMUTABLE = 'public, max-age=31536000, immutable'
// 头像允许 https:// 外链（user 插件接受这种值）；http:// 刻意不放开。
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const USAGE_RANGE_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 }

type UsageRange = '7d' | '30d' | '90d'

/** 导出只受内存与响应体限制；上限防止一次管理操作把整库读进内存。 */
const ADMIN_USAGE_EXPORT_LIMIT = 100_000

/** 管理概览分页读用户时的页大小；user 服务单页上限就是 1000。 */
const STATS_USER_PAGE = 1_000
const STATS_USER_MAX_PAGES = 100

/**
 * HTTP 服务器。它只依赖 `ApiRuntime` 这组端口，不 import 任何具体插件类；
 * 测试可以直接构造运行时，不需要拉起 cordis。
 */
export class ApiServer {
  private readonly runtime: ApiRuntime
  private readonly config: ResolvedApiConfig
  private server: Server | undefined
  private port = 0
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

  // ───────────────────────────────── 静态 ─────────────────────────────────

  private assetPrefix(): string {
    const configured = this.runtime.frontend()?.config?.publicBase
    const base = typeof configured === 'string' && configured !== '' ? configured : '/assets/frontend'
    return `${base.replace(/\/+$/, '')}/`
  }

  private isAssetPath(pathname: string): boolean {
    try {
      return pathname.startsWith(this.assetPrefix())
    } catch {
      return false
    }
  }

  private async serveAsset(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const frontend = this.requireFrontend()
    if (!(await this.frontendEnabled(frontend))) throw notFound('前端资源已停用')

    const prefix = this.assetPrefix()
    const rest = pathname.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash <= 0 || slash === rest.length - 1) throw notFound('资源路径不完整')

    const version = decodeSegment(rest.slice(0, slash))
    const relative = decodeSegment(rest.slice(slash + 1))
    if (version === '' || relative === '') throw notFound('资源路径不完整')

    let file: string
    try {
      // frontend.assetPath 已经做了路径归一化与越界检查（含 `..`、绝对路径）。
      file = await frontend.assetPath(relative, version)
    } catch {
      throw notFound('没有这个前端资源')
    }

    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      throw notFound('没有这个前端资源')
    }

    this.sendBody(req, res, 200, contentTypeOf(relative), body, {
      'Cache-Control': IMMUTABLE,
      'X-Content-Type-Options': 'nosniff',
    })
  }

  private async serveIndex(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const frontend = this.requireFrontend()
    if (!(await this.frontendEnabled(frontend))) throw notFound('前端资源已停用')

    let file: string | null
    try {
      file = frontend.indexFile === undefined
        ? await frontend.assetPath('index.html')
        : await frontend.indexFile()
    } catch {
      throw notFound('还没有安装前端资源')
    }
    if (file === null) throw notFound('还没有安装前端资源')

    let body: Buffer
    try {
      body = await readFile(file)
    } catch {
      throw notFound('还没有安装前端资源')
    }

    this.sendBody(req, res, 200, 'text/html; charset=utf-8', body, {
      'Cache-Control': NO_STORE,
      'Content-Security-Policy': CONTENT_SECURITY_POLICY,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    })
  }

  /** 前端插件卸载时会把 `state.json.enabled` 置 false；此时静态字节一律 404。 */
  private async frontendEnabled(frontend: FrontendPort): Promise<boolean> {
    try {
      const assets = await frontend.assets()
      if (typeof assets?.dataPath !== 'string' || assets.dataPath === '') return true
      const text = await readFile(join(assets.dataPath, 'state.json'), 'utf8')
      const parsed: unknown = JSON.parse(text)
      return !(isPlainObject(parsed) && parsed.enabled === false)
    } catch {
      // 没有 state.json（例如资源还没安装）不构成「禁用」。
      return true
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
      this.sendJson(req, res, 200, await this.health())
      return
    }
    if (parts.length === 2 && parts[0] === 'console' && parts[1] === 'manifest') {
      if (!this.allowRead(req, res)) return
      const frontend = this.requireFrontend()
      this.sendJson(req, res, 200, await frontend.manifest(), { 'Cache-Control': NO_STORE })
      return
    }
    if (parts[0] === 'auth') {
      await this.routeAuth(req, res, parts)
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
      await this.routeProfile(req, res, parts)
      return
    }
    if (parts[0] === 'keys') {
      await this.routeKeys(req, res, parts)
      return
    }
    if (parts.length === 1 && parts[0] === 'usage') {
      if (!this.allowRead(req, res)) return
      this.sendJson(req, res, 200, await this.usage(req, url))
      return
    }
    if (parts.length === 2 && parts[0] === 'usage' && parts[1] === 'export') {
      if (!this.allowRead(req, res)) return
      await this.usageExport(req, res, url)
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

  private async routeAuth(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    const action = parts.slice(1).join('/')
    switch (action) {
      case 'register/request': {
        if (!this.allowMethod(req, res, ['POST'])) return
        const body = await this.jsonBody(req)
        const email = requiredString(body, 'email')
        const password = requiredString(body, 'password')
        const name = optionalString(body, 'name')
        const ticket = await this.runtime.auth.requestRegistration({
          email,
          password,
          ...(name === undefined ? {} : { name }),
        })
        this.sendJson(req, res, 200, ticket)
        return
      }
      case 'register/confirm': {
        if (!this.allowMethod(req, res, ['POST'])) return
        const body = await this.jsonBody(req)
        const email = requiredString(body, 'email')
        const code = requiredString(body, 'code')
        const result = await this.runtime.auth.confirmRegistration({ email, code })
        this.setSessionCookie(req, res, result.token, result.expiresAt)
        this.sendJson(req, res, 200, this.loginResponse(result))
        return
      }
      case 'login': {
        if (!this.allowMethod(req, res, ['POST'])) return
        const body = await this.jsonBody(req)
        const email = requiredString(body, 'email')
        const password = requiredString(body, 'password')
        const result = await this.runtime.auth.login({
          email,
          password,
          meta: deviceMeta(req),
        })
        this.setSessionCookie(req, res, result.token, result.expiresAt)
        this.sendJson(req, res, 200, this.loginResponse(result))
        return
      }
      case 'logout': {
        if (!this.allowMethod(req, res, ['POST'])) return
        const token = readCookie(req, this.config.sessionCookieName)
        if (token !== undefined) {
          try {
            await this.runtime.auth.logout(token)
          } catch {
            // 登出幂等：令牌无效 / 已过期都算成功。
          }
        }
        this.clearSessionCookie(req, res)
        this.sendJson(req, res, 200, { ok: true })
        return
      }
      case 'password/reset/request': {
        if (!this.allowMethod(req, res, ['POST'])) return
        const body = await this.jsonBody(req)
        const email = requiredString(body, 'email')
        this.sendJson(req, res, 200, await this.runtime.auth.requestPasswordReset(email))
        return
      }
      case 'password/reset/confirm': {
        if (!this.allowMethod(req, res, ['POST'])) return
        const body = await this.jsonBody(req)
        const email = requiredString(body, 'email')
        const code = requiredString(body, 'code')
        const password = requiredString(body, 'password')
        this.sendJson(req, res, 200, await this.runtime.auth.confirmPasswordReset({ email, code, password }))
        return
      }
      default:
        throw notFound('没有这个鉴权接口')
    }
  }

  private async routeProfile(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    if (parts.length === 1) {
      if (!this.allowMethod(req, res, ['PATCH'])) return
      const view = await this.requireSession(req)
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, ['name', 'avatar'])
      const patch: { name?: string; avatar?: string | null } = {}
      if (Object.hasOwn(body, 'name')) patch.name = requiredString(body, 'name')
      if (Object.hasOwn(body, 'avatar')) {
        patch.avatar = optionalAvatar(body.avatar)
      }
      if (Object.keys(patch).length === 0) throw badRequest('没有可修改的字段')

      const update = this.runtime.user.updateProfile
      if (typeof update !== 'function') {
        throw new ApiError(
          'API_PROFILE_UNAVAILABLE',
          503,
          '用户插件没有提供 updateProfile 接口',
        )
      }
      await update.call(this.runtime.user, view.userId, patch)
      const user = await this.runtime.user.get(view.userId)
      if (user === undefined) throw unauthorized('账号已不存在，请重新登录')
      this.sendJson(req, res, 200, sessionUserOf(user))
      return
    }

    if (parts.length === 2 && parts[1] === 'password') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const view = await this.requireSession(req)
      const token = this.sessionToken(req)
      const body = await this.jsonBody(req)
      const currentPassword = requiredString(body, 'currentPassword')
      const newPassword = requiredString(body, 'newPassword')
      this.sendJson(req, res, 200, await this.runtime.auth.changePassword(token, currentPassword, newPassword))
      return
    }

    throw notFound('没有这个资料接口')
  }

  private async routeKeys(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    const view = await this.requireSession(req)

    if (parts.length === 1) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const apiKey = this.requireApiKey()
        this.sendJson(req, res, 200, { items: normalizeKeyList(await apiKey.list(view.userId)) })
        return
      }
      if (req.method === 'POST') {
        const apiKey = this.requireApiKey()
        const body = await this.jsonBody(req)
        const name = requiredString(body, 'name')
        this.sendJson(req, res, 200, normalizeCreatedKey(await apiKey.create(view.userId, { name })))
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
      return
    }

    if (parts.length === 2) {
      const id = parts[1] as string
      if (req.method === 'PATCH') {
        const apiKey = this.requireApiKey()
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['name', 'enabled'])
        const patch: { name?: string; enabled?: boolean } = {}
        if (Object.hasOwn(body, 'name')) patch.name = requiredString(body, 'name')
        if (Object.hasOwn(body, 'enabled')) patch.enabled = requiredBoolean(body, 'enabled')
        if (Object.keys(patch).length === 0) throw badRequest('没有可修改的字段')
        this.sendJson(req, res, 200, normalizeKeySummary(await apiKey.update(view.userId, id, patch)))
        return
      }
      if (req.method === 'DELETE') {
        const apiKey = this.requireApiKey()
        await apiKey.remove(view.userId, id)
        this.sendJson(req, res, 200, { removed: true })
        return
      }
      this.sendMethodNotAllowed(req, res, ['PATCH', 'DELETE'])
      return
    }

    if (parts.length === 3 && parts[2] === 'rotate') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const apiKey = this.requireApiKey()
      this.sendJson(req, res, 200, normalizeCreatedKey(await apiKey.rotate(view.userId, parts[1] as string)))
      return
    }

    throw notFound('没有这个 API key 接口')
  }

  private async usage(req: IncomingMessage, url: URL): Promise<unknown> {
    const view = await this.requireSession(req)
    const usage = this.runtime.usage()
    if (usage === undefined) {
      throw new ApiError('API_USAGE_UNAVAILABLE', 503, '用量插件不在运行，暂时无法查询用量')
    }

    const range = url.searchParams.get('range') ?? '30d'
    const days = USAGE_RANGE_DAYS[range]
    if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)

    const now = this.runtime.now()
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const fromMs = todayStart - (days - 1) * 86_400_000
    const toMs = todayStart + 86_400_000

    const user = await this.runtime.user.get(view.userId)
    if (user === undefined) throw unauthorized('账号已不存在，请重新登录')

    // 普通用户只能看自己的；管理员可以用 userId 指定别人（不传 = 全部）。
    const userIdParam = url.searchParams.get('userId')
    let userId: number | undefined
    if (roleOf(view.user) === 'admin') {
      if (userIdParam !== null && userIdParam !== '') userId = parseUserId(userIdParam)
    } else {
      userId = view.userId
    }

    const apiKeyParam = url.searchParams.get('apiKeyId')
    const apiKeyId = apiKeyParam === null || apiKeyParam === '' ? undefined : apiKeyParam
    const modelParam = url.searchParams.get('model')
    const model = modelParam === null || modelParam === '' ? undefined : modelParam
    const cursorParam = url.searchParams.get('cursor')
    const cursor =
      cursorParam === null || cursorParam === ''
        ? undefined
        : parseIntegerParam(cursorParam, 'cursor', 1, 1, Number.MAX_SAFE_INTEGER)
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 200) ?? 20

    const query: UsageQueryLike = {
      fromMs,
      toMs,
      ...(userId === undefined ? {} : { userId }),
      ...(apiKeyId === undefined ? {} : { apiKeyId }),
      ...(model === undefined ? {} : { model }),
    }
    const summary = usage.summary(query)
    const page = usage.list({ ...query, ...(cursor === undefined ? {} : { cursor }), limit })

    return {
      range,
      from: dateOf(new Date(fromMs)),
      to: dateOf(new Date(toMs - 86_400_000)),
      apiKeyId: apiKeyId ?? null,
      // 余额只按当前用户余额换算；历史消费由用量明细体现，不在这里伪造。
      balances: {
        paidCents: centsOf(user.balance),
        grantedCents: 0,
        spentCents: 0,
      },
      totals: usageTotalsOf(summary.totals),
      daily: summary.daily.map((point) => ({ date: point.date, ...usageTotalsOf(point) })),
      models: summary.models.map((item) => ({ model: item.model, ...usageTotalsOf(item) })),
      records: { items: page.items.map(usageRowOf), nextCursor: page.nextCursor },
      pricingAvailable: this.runtime.pricing() !== undefined,
      generatedAt: now.toISOString(),
    }
  }

  /**
   * `GET /api/usage/export`：把当前筛选条件下的明细导出成 CSV。
   *
   * 响应是 JSON `{ filename, content }`，由浏览器自己生成 Blob 下载；
   * 这样不用在 HTTP 层区分下载 / 错误信封，也不会把 CSV 当 JSON 解析。
   */
  private async usageExport(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const view = await this.requireSession(req)
    const usage = this.runtime.usage()
    if (usage === undefined) {
      throw new ApiError('API_USAGE_UNAVAILABLE', 503, '用量插件不在运行，暂时无法导出用量')
    }

    const format = url.searchParams.get('format') ?? 'csv'
    if (format !== 'csv') throw badRequest('format 只支持 csv')

    const range = url.searchParams.get('range') ?? '30d'
    const days = USAGE_RANGE_DAYS[range]
    if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)

    const now = this.runtime.now()
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const fromMs = todayStart - (days - 1) * 86_400_000
    const toMs = todayStart + 86_400_000

    const userIdParam = url.searchParams.get('userId')
    let userId: number | undefined
    if (roleOf(view.user) === 'admin') {
      if (userIdParam !== null && userIdParam !== '') userId = parseUserId(userIdParam)
    } else {
      userId = view.userId
    }

    const apiKeyParam = url.searchParams.get('apiKeyId')
    const apiKeyId = apiKeyParam === null || apiKeyParam === '' ? undefined : apiKeyParam
    const modelParam = url.searchParams.get('model')
    const model = modelParam === null || modelParam === '' ? undefined : modelParam

    const rows = usage.exportRows({
      fromMs,
      toMs,
      ...(userId === undefined ? {} : { userId }),
      ...(apiKeyId === undefined ? {} : { apiKeyId }),
      ...(model === undefined ? {} : { model }),
    })
    const from = dateOf(new Date(fromMs)).replaceAll('-', '')
    const to = dateOf(new Date(toMs - 86_400_000)).replaceAll('-', '')
    this.sendJson(req, res, 200, {
      filename: `usage-${from}-${to}.csv`,
      content: usageCsv(rows),
    })
  }

  /**
   * `/api/pricing`：读价格表（会话）与改价格（管理员）。
   *
   * - `GET /api/pricing` → `{ items }`；
   * - `GET /api/pricing/:model` → 单个价格，没有就 404；
   * - `PUT /api/pricing/:model` → 写入并返回新价格；
   * - `DELETE /api/pricing/:model` → `{ removed }`。
   *
   * 模型名可能含 `/`，由 `encodeURIComponent` 编成 `%2F` 留在同一路径段里。
   */
  private async routePricing(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
  ): Promise<void> {
    const requirePricing = (): PricingPort => {
      const pricing = this.runtime.pricing()
      if (pricing === undefined) {
        throw new ApiError('API_PRICING_UNAVAILABLE', 503, '价格表插件不在运行')
      }
      return pricing
    }
    const viewOf = (price: ModelPriceLike) => ({
      model: price.model,
      inputPerMillion: price.inputPerMillion,
      outputPerMillion: price.outputPerMillion,
      cacheReadPerMillion: price.cacheReadPerMillion,
      cacheWritePerMillion: price.cacheWritePerMillion,
      currency: 'CNY' as const,
      updatedAt: price.updatedAt,
    })
    /** 价格字段只接受字符串或数字；其余在 HTTP 层就拒绝，不把脏值交给服务。 */
    const priceField = (
      body: Record<string, unknown>,
      key: keyof ModelPriceInputLike,
      required: boolean,
    ): string | number | undefined => {
      const value = body[key]
      if (value === undefined) {
        if (!required) return undefined
        throw new ApiError('PRICING_PRICE_INVALID', 400, `${key} 必须是字符串或数字`)
      }
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw new ApiError('PRICING_PRICE_INVALID', 400, `${key} 必须是字符串或数字`)
      }
      return value
    }

    if (parts.length === 1) {
      if (!this.allowRead(req, res)) return
      await this.requireSession(req)
      const pricing = requirePricing()
      this.sendJson(req, res, 200, { items: pricing.list().map(viewOf) })
      return
    }
    if (parts.length > 2) throw notFound('没有这个价格接口')

    const model = parts[1] as string

    if (req.method === 'GET' || req.method === 'HEAD') {
      await this.requireSession(req)
      const pricing = requirePricing()
      const price = pricing.get(model)
      if (price === null) throw new ApiError('PRICING_NOT_FOUND', 404, `没有模型 ${model} 的价格`)
      this.sendJson(req, res, 200, viewOf(price))
      return
    }

    if (req.method === 'PUT') {
      const { view } = await this.requireAdmin(req)
      const pricing = requirePricing()
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, [
        'inputPerMillion',
        'outputPerMillion',
        'cacheReadPerMillion',
        'cacheWritePerMillion',
      ])
      const cacheRead = priceField(body, 'cacheReadPerMillion', false)
      const cacheWrite = priceField(body, 'cacheWritePerMillion', false)
      const input: ModelPriceInputLike = {
        inputPerMillion: priceField(body, 'inputPerMillion', true) as string | number,
        outputPerMillion: priceField(body, 'outputPerMillion', true) as string | number,
        ...(cacheRead === undefined ? {} : { cacheReadPerMillion: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWritePerMillion: cacheWrite }),
      }
      const written = await audited(
        this.runtime,
        { actor: auditActorOf(view), actorPlugin: API_ACTOR },
        {
          action: 'pricing.write',
          targetType: 'pricing',
          targetId: model,
          summary: `写入模型 ${model} 的价格`,
          metadata: {
            inputPerMillion: String(input.inputPerMillion),
            outputPerMillion: String(input.outputPerMillion),
          },
        },
        () => pricing.set(API_ACTOR, model, input),
      )
      this.sendJson(req, res, 200, viewOf(written))
      return
    }

    if (req.method === 'DELETE') {
      const { view } = await this.requireAdmin(req)
      const pricing = requirePricing()
      const removed = await audited(
        this.runtime,
        { actor: auditActorOf(view), actorPlugin: API_ACTOR },
        {
          action: 'pricing.remove',
          targetType: 'pricing',
          targetId: model,
          summary: `删除模型 ${model} 的价格`,
          metadataOf: (result) => ({ removed: result }),
        },
        () => pricing.remove(API_ACTOR, model),
      )
      this.sendJson(req, res, 200, { removed })
      return
    }

    this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'PUT', 'DELETE'])
  }

  /**
   * `/api/models`：模型广场（只读目录）。
   *
   * 与 `GET /v1/models` 的区别：后者是 LLM 入口、只给名字并集、由 Go 服务；
   * 这里是**产品面**的目录，给价格、可用性与覆盖度，**不改动 `/v1/models` 的任何字节**
   * （那条路由归 Go，契约由 `internal/httpapi` 的用例守着）。
   *
   * 查询参数：
   * - `search`：按模型名子串过滤（不区分大小写）；
   * - `availability`：`all` / `available` / `unavailable`（默认 all）；
   * - `priced`：`all` / `priced` / `unpriced`（默认 all）。
   *
   * 金额一律十进制字符串（元 / 百万 token），响应里不出现裸 bigint 或浮点。
   */
  private async routeModels(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.allowRead(req, res)) return
    await this.requireSession(req)
    const modelhub = this.runtime.modelhub()
    if (modelhub === undefined) {
      throw new ApiError('MODELHUB_UNAVAILABLE', 503, '模型广场服务不在运行：暂时不能查询模型目录')
    }

    const query: {
      search?: string
      availability?: 'all' | 'available' | 'unavailable'
      priced?: 'all' | 'priced' | 'unpriced'
    } = {}
    const search = queryStringOf(url, 'search')
    if (search !== undefined) query.search = search
    const availability = queryStringOf(url, 'availability')
    if (availability !== undefined) {
      if (availability !== 'all' && availability !== 'available' && availability !== 'unavailable') {
        throw badRequest('availability 只能是 all / available / unavailable')
      }
      query.availability = availability
    }
    const priced = queryStringOf(url, 'priced')
    if (priced !== undefined) {
      if (priced !== 'all' && priced !== 'priced' && priced !== 'unpriced') {
        throw badRequest('priced 只能是 all / priced / unpriced')
      }
      query.priced = priced
    }

    this.sendJson(req, res, 200, modelCatalogOf(modelhub.catalog(query)))
  }

  /**
   * `/api/admin/usage`：管理员口径的用量明细与导出。
   *
   * 查询窗口与用户侧 `/api/usage` 同口径：[from 当天 00:00 UTC, 明天 00:00 UTC)。
   * `records.items` 比用户侧多 `userName` / `accountId` / `attempts`；
   * `userName` 在同一次请求内按 userId 缓存，查不到就是 null。
   */
  private async routeAdminUsage(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    if (parts[2] === 'rejected') {
      await this.routeAdminUsageRejected(req, res, parts, url, auditActorOf(adminView))
      return
    }
    if (parts.length > 3 || (parts.length === 3 && parts[2] !== 'export')) {
      throw notFound('没有这个管理员用量接口')
    }
    if (!this.allowRead(req, res)) return

    const usage = this.requireUsage()
    const spec = this.adminUsageQuery(url)
    const nameOf = this.userNameResolver()

    if (parts.length === 3) {
      const rows = usage.exportRows(spec.query, ADMIN_USAGE_EXPORT_LIMIT)
      const decorated = await Promise.all(
        rows.map(async (row) => ({ ...row, userName: await nameOf(row.userId) })),
      )
      this.sendJson(req, res, 200, {
        filename: `admin-usage-${spec.from.replaceAll('-', '')}-${spec.to.replaceAll('-', '')}.csv`,
        content: adminUsageCsv(decorated),
      })
      return
    }

    const page = usage.list(spec.query)
    const summary = usage.summary(spec.query)
    const items = await Promise.all(
      page.items.map(async (row) => adminUsageRowOf(row, await nameOf(row.userId))),
    )
    // 隔离区：主接口给「第一页 + 计数」，完整分页在 `/api/admin/usage/rejected`。
    // 这些记录没有进明细、不会被结算；管理面必须能看见，否则就是静默免单。
    const rejected = usage.listRejected({ limit: 20 })
    this.sendJson(req, res, 200, {
      range: spec.range,
      from: spec.from,
      to: spec.to,
      totals: usageTotalsOf(summary.totals),
      daily: summary.daily.map(usageDailyOf),
      models: summary.models.map(usageModelOf),
      records: { items, nextCursor: page.nextCursor },
      rejected: {
        items: rejected.items.map(rejectedRowOf),
        total: rejected.total,
        pending: rejected.pending,
      },
      pricingAvailable: this.runtime.pricing() !== undefined,
      generatedAt: this.runtime.now().toISOString(),
    })
  }

  /**
   * `/api/admin/usage/rejected`：坏记录隔离区（只读列表 + 两个管理动作）。
   *
   * - `GET` → `{ items, total, pending, limit, offset }`（`status` 可筛 pending / ignored / replayed）
   * - `POST .../ignore` `{reqId}` → 标记 ignored（幂等）
   * - `POST .../replay` `{reqId}` → 按 req_id 重放，成功则 pending → replayed（幂等，不重复插入）
   *
   * 这些记录**没有**进用量明细，也不会被结算；管理面必须能看见，否则就是静默免单。
   */
  private async routeAdminUsageRejected(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
    actor: string,
  ): Promise<void> {
    const usage = this.requireUsage()
    if (parts.length === 3) {
      if (!this.allowRead(req, res)) return
      this.sendJson(req, res, 200, this.adminRejectedView(usage, url))
      return
    }
    if (parts.length !== 4) throw notFound('没有这个管理员用量接口')
    const action = parts[3]
    if (action !== 'ignore' && action !== 'replay') {
      throw notFound('没有这个隔离记录操作')
    }
    if (!this.allowMethod(req, res, ['POST'])) return
    const body = await this.jsonBody(req)
    assertOnlyKeys(body, ['reqId'])
    const reqId = requiredString(body, 'reqId')
    const identity = { actor, actorPlugin: API_ACTOR }

    if (action === 'ignore') {
      await audited(
        this.runtime,
        identity,
        {
          action: 'usage.rejected.ignore',
          targetType: 'usage-record',
          targetId: reqId,
          // 忽略 = 这笔用量永久不结算、不扣钱，等于放弃收入：属于高危动作。
          summary: `忽略一条被隔离的用量记录（永久不结算）`,
        },
        async () => usage.ignoreRejected(reqId),
      )
      this.sendJson(req, res, 200, { reqId, status: 'ignored' })
      return
    }

    const replayed = await audited(
      this.runtime,
      identity,
      {
        action: 'usage.rejected.replay',
        targetType: 'usage-record',
        targetId: reqId,
        // 重放会补结算（扣钱），失败也记：漏记一次就是账对不上。
        summary: '重放一条被隔离的用量记录（补结算）',
        metadataOf: (out) => ({ inserted: out.inserted, status: out.status }),
      },
      () => usage.replayRejected(reqId),
    )
    this.sendJson(req, res, 200, { reqId, ...replayed })
  }

  /** 隔离区列表视图：分页与状态筛选都在这里校验，非法值明确 400。 */
  private adminRejectedView(
    usage: UsagePort,
    url: URL,
  ): {
    items: ReturnType<typeof rejectedRowOf>[]
    total: number
    pending: number
    limit: number
    offset: number
  } {
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 200) ?? 20
    const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000) ?? 0
    let status: string | undefined
    const raw = url.searchParams.get('status')
    if (raw !== null && raw !== '') {
      if (raw !== 'pending' && raw !== 'ignored' && raw !== 'replayed') {
        throw badRequest('status 只能是 pending / ignored / replayed')
      }
      status = raw
    }
    const query: UsageRejectedQueryLike = {
      limit,
      offset,
      ...(status === undefined ? {} : { status }),
    }
    const page = usage.listRejected(query)
    return {
      items: page.items.map(rejectedRowOf),
      total: page.total,
      pending: page.pending,
      limit,
      offset,
    }
  }

  /**
   * `GET /api/admin/stats`：全站计数与 token 汇总。
   *
   * 计数优先用服务的 `count()`；user 的角色 / 状态拆分与 key 的启用拆分需要逐条读，
   * 但 key 的总数绝不为了一个数字加载整表。accountAdmin / apiKey 缺席时对应块全 0，
   * 整个接口照常返回；只有 usage 缺席时 `usage: null`。
   */
  private async adminStats(req: IncomingMessage, res: ServerResponse): Promise<void> {
    await this.requireAdmin(req)
    if (!this.allowRead(req, res)) return

    const users = await this.allUsers()
    const userPort = this.runtime.user as UserPort & { count?: () => Promise<number> }
    const countedUsers = typeof userPort.count === 'function' ? await userPort.count.call(this.runtime.user) : null
    const userTotal = countedUsers ?? users.length

    const accountAdmin = this.runtime.accountAdmin()
    const accounts = accountAdmin === undefined ? [] : [...(await accountAdmin.list())]

    const apiKey = this.runtime.apiKey()
    const keyPort = apiKey as (ApiKeyPort & { count?: () => Promise<number>; listAll?: () => Promise<unknown> }) | undefined
    let keyTotal: number | null = null
    let keyEnabled = 0
    let keyDisabled = 0
    if (keyPort !== undefined) {
      if (typeof keyPort.count === 'function') {
        try {
          keyTotal = await keyPort.count.call(keyPort)
        } catch {
          keyTotal = null
        }
      }
      if (typeof keyPort.listAll === 'function') {
        try {
          const listed = keyPortResult(await keyPort.listAll.call(keyPort))
          keyEnabled = listed.filter((item) => item.enabled !== false).length
          keyDisabled = listed.length - keyEnabled
          if (keyTotal === null) keyTotal = listed.length
        } catch {
          // key 列表不可读时保留 count()（如果有）或 0，不让整个概览失败。
        }
      }
    }

    const nameOf = this.userNameResolver()
    const usage = this.runtime.usage()
    let usageView: {
      today: ReturnType<typeof usageTotalsOf>
      total: ReturnType<typeof usageTotalsOf>
      series: ReturnType<typeof usageDailyOf>[]
      models: ReturnType<typeof usageModelOf>[]
      topUsers: { userId: number; name: string | null; requests: number; tokens: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; costCents: number; costMicros: string }[]
    } | null = null
    if (usage !== undefined) {
      const stats = usage.stats()
      usageView = {
        today: usageTotalsOf(stats.today),
        total: usageTotalsOf(stats.total),
        series: stats.series.map(usageDailyOf),
        models: stats.models.map(usageModelOf),
        topUsers: await Promise.all(stats.topUsers.map(async (item) => usageUserOf(item, await nameOf(item.userId)))),
      }
    }

    this.sendJson(req, res, 200, {
      generatedAt: this.runtime.now().toISOString(),
      users: {
        total: userTotal,
        admins: users.filter((user) => user.role === 'admin').length,
        enabled: users.filter((user) => user.status === 'enabled').length,
        banned: users.filter((user) => user.status === 'banned').length,
      },
      accounts: {
        total: accounts.length,
        enabled: accounts.filter((account) => account.enabled === true).length,
        disabled: accounts.filter((account) => account.enabled !== true).length,
        needsReauth: accounts.filter((account) => account.status === 'needs_reauth').length,
      },
      keys: {
        total: keyTotal ?? 0,
        enabled: keyEnabled,
        disabled: keyDisabled,
      },
      usage: usageView,
    })
  }

  /** 分页读完用户表（角色 / 状态拆分要用）；`count()` 只给总数。 */
  private async allUsers(): Promise<UserLike[]> {
    const users: UserLike[] = []
    for (let page = 0; page < STATS_USER_MAX_PAGES; page++) {
      const batch = await this.runtime.user.list({ offset: users.length, limit: STATS_USER_PAGE })
      users.push(...batch)
      if (batch.length < STATS_USER_PAGE) break
    }
    return users
  }

  /**
   * 管理员用量的筛选与时间窗口。`range` 与用户侧一致；`status` 是精确匹配的 HTTP 状态码。
   */
  private adminUsageQuery(url: URL): {
    readonly range: UsageRange
    readonly from: string
    readonly to: string
    readonly query: UsageQueryLike
  } {
    const range = url.searchParams.get('range') ?? '30d'
    const days = USAGE_RANGE_DAYS[range]
    if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)

    const now = this.runtime.now()
    const to = dateOf(now)
    const from = dateOf(new Date(now.getTime() - (days - 1) * 86_400_000))
    const fromMs = Date.parse(`${from}T00:00:00.000Z`)
    const toMs = Date.parse(`${to}T00:00:00.000Z`) + 86_400_000

    const userIdText = url.searchParams.get('userId')
    const userId =
      userIdText === null || userIdText === '' ? undefined : parsePositiveInteger(userIdText, 'userId')

    const apiKeyId = queryStringOf(url, 'apiKeyId')
    const model = queryStringOf(url, 'model')

    const statusText = url.searchParams.get('status')
    let status: number | undefined
    if (statusText !== null && statusText !== '') {
      if (!/^\d+$/.test(statusText)) throw badRequest('status 必须是非负整数')
      status = Number(statusText)
      if (!Number.isSafeInteger(status) || status < 0 || status > 599) {
        throw badRequest('status 必须在 0..599 之间')
      }
    }

    const cursorText = url.searchParams.get('cursor')
    const cursor =
      cursorText === null || cursorText === ''
        ? undefined
        : parseIntegerParam(cursorText, 'cursor', 0, 1, Number.MAX_SAFE_INTEGER)
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 200) ?? 20

    return {
      range: range as UsageRange,
      from,
      to,
      query: {
        fromMs,
        toMs,
        ...(userId === undefined ? {} : { userId }),
        ...(apiKeyId === undefined ? {} : { apiKeyId }),
        ...(model === undefined ? {} : { model }),
        ...(status === undefined ? {} : { status }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      },
    }
  }

  /**
   * 同一次请求内复用的 userId → name 解析器。用户服务不可用或用户已删除时记 null，
   * 不让一行缺失把整个列表打成 500。
   */
  private userNameResolver(): (userId: number) => Promise<string | null> {
    const cache = new Map<number, string | null>()
    return async (userId: number) => {
      if (cache.has(userId)) return cache.get(userId) ?? null
      let name: string | null = null
      try {
        const user = await this.runtime.user.get(userId)
        name = user === undefined ? null : user.name
      } catch {
        name = null
      }
      cache.set(userId, name)
      return name
    }
  }

  /**
   * 用户面：`GET /api/topup/options`、`GET/POST /api/topup/orders`、
   * `GET /api/topup/orders/<orderNo>`、`POST /api/topup/orders/<orderNo>/cancel`。
   *
   * 订单金额只接受「元」的十进制字符串（服务层换整数微元）；响应里金额一律十进制字符串。
   * 本批没有在线支付：订单创建后返回 `instructions`（人工确认说明），不会自动到账。
   */
  private async routeTopup(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    const view = await this.requireSession(req)
    const topup = this.requireTopup()

    if (parts.length === 2 && parts[1] === 'options') {
      if (!this.allowRead(req, res)) return
      this.sendJson(req, res, 200, topupOptionsOf(topup.options()))
      return
    }

    if (parts.length === 2 && parts[1] === 'orders') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 100)
        const page = topup.listMine(view.userId, limit)
        this.sendJson(req, res, 200, {
          items: page.items.map(topupOrderOf),
          total: page.total,
        })
        return
      }
      if (req.method === 'POST') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['amountYuan', 'provider', 'note'])
        const amountYuan = requiredString(body, 'amountYuan')
        const provider = optionalString(body, 'provider')
        const note = Object.hasOwn(body, 'note') ? nullableString(body, 'note') : undefined
        const created = await topup.createOrder({
          userId: view.userId,
          amountYuan,
          ...(provider === undefined ? {} : { provider }),
          ...(note === undefined ? {} : { note }),
        })
        this.sendJson(req, res, 200, {
          order: topupOrderOf(created.order),
          instructions: created.order.instructions,
        })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
      return
    }

    if (parts.length === 3 && parts[1] === 'orders') {
      if (!this.allowRead(req, res)) return
      this.sendJson(req, res, 200, topupOrderOf(topup.getMine(view.userId, parts[2] as string)))
      return
    }

    if (parts.length === 4 && parts[1] === 'orders' && parts[3] === 'cancel') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const canceled = topup.cancelMine(view.userId, parts[2] as string)
      this.sendJson(req, res, 200, topupOrderOf(canceled))
      return
    }

    throw notFound('没有这个充值接口')
  }

  /**
   * 管理面：`GET /api/admin/topup-orders`（列表 + 筛选）、`.../stats`、
   * `POST .../<orderNo>/confirm`（人工确认到账）、`POST .../<orderNo>/cancel`。
   *
   * 确认到账会**真的加余额**（走 user.adjustBalance，幂等）：重复确认只回 `credited: false`，
   * 不会重复加钱。本批没有支付回调路由——没有验签的回调一律不挂。
   */
  private async routeAdminTopupOrders(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
    const topup = this.requireTopup()

    if (parts.length === 2) {
      if (!this.allowRead(req, res)) return
      const query: {
        status?: string
        userId?: number
        fromMs?: number
        toMs?: number
        limit?: number
        offset?: number
      } = {}
      const status = queryStringOf(url, 'status')
      if (status !== undefined) query.status = status
      const userId = parseIntegerParam(url.searchParams.get('userId'), 'userId', 0, 0, Number.MAX_SAFE_INTEGER)
      if (userId !== undefined && userId > 0) query.userId = userId
      const fromMs = parseIntegerParam(url.searchParams.get('from'), 'from', 0, 0, Number.MAX_SAFE_INTEGER)
      if (fromMs !== undefined && fromMs > 0) query.fromMs = fromMs
      const toMs = parseIntegerParam(url.searchParams.get('to'), 'to', 0, 0, Number.MAX_SAFE_INTEGER)
      if (toMs !== undefined && toMs > 0) query.toMs = toMs
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
      const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
      if (limit !== undefined) query.limit = limit
      if (offset !== undefined) query.offset = offset
      const page = await topup.list(API_ACTOR, query)
      this.sendJson(req, res, 200, {
        items: page.items.map(topupOrderOf),
        total: page.total,
      })
      return
    }

    if (parts.length === 3 && parts[2] === 'stats') {
      if (!this.allowRead(req, res)) return
      this.sendJson(req, res, 200, topupStatsOf(await topup.stats(API_ACTOR)))
      return
    }

    if (parts.length === 4) {
      const orderNo = parts[2] as string
      if (parts[3] === 'confirm') {
        if (!this.allowMethod(req, res, ['POST'])) return
        const result = await audited(
          this.runtime,
          identity,
          {
            action: 'topup.order.confirm',
            targetType: 'topup-order',
            targetId: orderNo,
            // 确认到账会**真的加余额**：失败也记（加余额失败要能查到是哪一次）。
            summary: `确认充值订单 ${orderNo} 到账`,
            metadataOf: (out) => ({
              credited: out.credited,
              userId: out.order.userId,
              amountMicros: out.order.amountMicro.toString(),
            }),
          },
          () => topup.confirmPaid(API_ACTOR, orderNo),
        )
        this.sendJson(req, res, 200, {
          order: topupOrderOf(result.order),
          credited: result.credited,
        })
        return
      }
      if (parts[3] === 'cancel') {
        if (!this.allowMethod(req, res, ['POST'])) return
        const canceled = await audited<TopupOrderLike>(
          this.runtime,
          identity,
          {
            action: 'topup.order.cancel',
            targetType: 'topup-order',
            targetId: orderNo,
            summary: `取消充值订单 ${orderNo}`,
            metadataOf: (order) => ({ userId: order.userId, status: order.status }),
          },
          async () => topup.cancel(API_ACTOR, orderNo),
        )
        this.sendJson(req, res, 200, topupOrderOf(canceled))
        return
      }
    }

    throw notFound('没有这个充值订单接口')
  }

  // ───────────────────────────────── 兑换码 ─────────────────────────────────

  /**
   * 用户面：`POST /api/redeem` 兑换，`GET /api/redeem` 我的兑换记录。
   *
   * 兑换失败一律走稳定 code（未知 / 已用 / 停用 / 过期 / 兑换中），消息里不含码本身；
   * 成功只回金额、余额与批次名。
   */
  private async routeRedeem(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    const view = await this.requireSession(req)
    if (parts.length !== 1) throw notFound('没有这个兑换接口')
    const redeem = this.requireRedeem()

    if (req.method === 'GET' || req.method === 'HEAD') {
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 100)
      const items = await redeem.listMyRedemptions(view.userId, limit)
      this.sendJson(req, res, 200, { items: items.map(redemptionOf) })
      return
    }
    if (req.method === 'POST') {
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, ['code'])
      const code = requiredString(body, 'code')
      const result = await redeem.redeemCode({ userId: view.userId, code })
      this.sendJson(req, res, 200, redeemResultOf(result))
      return
    }
    this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
  }

  /**
   * 管理面：兑换码列表 / 生成批次 / 单码启停 / 人工核查 / 批量删除。
   *
   * 生成是唯一会返回明文的接口，而且**只在这一次响应里**；列表永远只有掩码。
   */
  private async routeAdminRedeemCodes(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
    const redeem = this.requireRedeem()

    if (parts.length === 2) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
        const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
        const query: {
          batchId?: string
          status?: string
          keyword?: string
          limit?: number
          offset?: number
        } = {}
        const batchId = queryStringOf(url, 'batch')
        if (batchId !== undefined) query.batchId = batchId
        const status = queryStringOf(url, 'status')
        if (status !== undefined) query.status = status
        const keyword = queryStringOf(url, 'keyword')
        if (keyword !== undefined) query.keyword = keyword
        if (limit !== undefined) query.limit = limit
        if (offset !== undefined) query.offset = offset

        const page = await redeem.listCodes(API_ACTOR, query)
        this.sendJson(req, res, 200, {
          items: page.items.map(redeemCodeOf),
          total: page.total,
        })
        return
      }
      if (req.method === 'POST') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['name', 'amountMicro', 'count', 'expiresAt', 'notes'])
        const name = requiredString(body, 'name')
        const amountMicro = requiredMicros(body, 'amountMicro')
        const count = optionalInteger(body, 'count', 1, 100)
        if (count === undefined) throw badRequest('count 必须是 1..100 的整数')
        const expiresAt =
          Object.hasOwn(body, 'expiresAt') ? nullableString(body, 'expiresAt') : undefined
        const notes = Object.hasOwn(body, 'notes') ? optionalString(body, 'notes') : undefined
        const created = await audited(
          this.runtime,
          identity,
          {
            action: 'redeem.batch.generate',
            targetType: 'redeem-batch',
            summary: `生成兑换码批次「${name}」（${count} 张）`,
            // 明文码只在响应里出现一次，**绝不进审计**；只记批次与额度。
            metadata: { count, amountMicros: amountMicro.toString(), expiresAt: expiresAt ?? null },
            metadataOf: (result) => ({ batchId: result.batch.id }),
          },
          () =>
            redeem.createBatch(API_ACTOR, {
              name,
              amountMicro,
              count,
              ...(expiresAt === undefined ? {} : { expiresAt }),
              ...(notes === undefined ? {} : { notes }),
            }),
        )
        this.sendJson(req, res, 200, {
          batch: redeemBatchOf(created.batch),
          codes: created.codes,
        })
        return
      }
      if (req.method === 'DELETE') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['ids'])
        const ids = readStringArray(body.ids, 'ids')
        const result = await audited(
          this.runtime,
          identity,
          {
            action: 'redeem.code.delete',
            targetType: 'redeem-code',
            summary: `批量删除 ${ids.length} 张兑换码`,
            metadata: { ids, count: ids.length },
            metadataOf: (out) => ({ deleted: out.deleted, rejected: out.rejected.length }),
          },
          () => redeem.deleteCodes(API_ACTOR, ids),
        )
        this.sendJson(req, res, 200, {
          deleted: result.deleted,
          rejected: result.rejected.map((item) => ({ id: item.id, reason: item.reason })),
        })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST', 'DELETE'])
      return
    }

    if (parts.length === 3 && parts[2] === 'status') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, ['id', 'status'])
      const id = requiredString(body, 'id')
      const status = requiredString(body, 'status')
      if (status !== 'enabled' && status !== 'disabled') {
        throw badRequest('status 只能是 enabled / disabled')
      }
      this.sendJson(
        req,
        res,
        200,
        redeemCodeOf(
          await audited(
            this.runtime,
            identity,
            {
              action: 'redeem.code.status',
              targetType: 'redeem-code',
              targetId: id,
              summary: `把兑换码 ${id} 改为 ${status}`,
              metadata: { status },
            },
            () => redeem.setCodeStatus(API_ACTOR, id, status),
          ),
        ),
      )
      return
    }

    if (parts.length === 3 && parts[2] === 'resolve') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, ['id', 'outcome'])
      const id = requiredString(body, 'id')
      const outcome = requiredString(body, 'outcome')
      if (outcome !== 'used' && outcome !== 'enabled') {
        throw badRequest('outcome 只能是 used / enabled')
      }
      this.sendJson(
        req,
        res,
        200,
        redeemCodeOf(
          await audited(
            this.runtime,
            identity,
            {
              action: 'redeem.code.resolve',
              targetType: 'redeem-code',
              targetId: id,
              // 人工核查影响「这张码还能不能再加钱」，属于高危：失败也记。
              summary: `人工核查兑换码 ${id}：${outcome === 'used' ? '标记为已用' : '退回可用'}`,
              metadata: { outcome },
            },
            () => redeem.resolveRedeeming(API_ACTOR, id, outcome),
          ),
        ),
      )
      return
    }

    throw notFound('没有这个兑换码接口')
  }

  /** 管理面：批次列表与单个批次。 */
  private async routeAdminRedeemBatches(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    await this.requireAdmin(req)
    if (!this.allowRead(req, res)) return
    const redeem = this.requireRedeem()

    if (parts.length === 2) {
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
      const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
      const batches = await redeem.listBatches(API_ACTOR, {
        ...(limit === undefined ? {} : { limit }),
        ...(offset === undefined ? {} : { offset }),
      })
      this.sendJson(req, res, 200, { items: batches.map(redeemBatchOf) })
      return
    }
    if (parts.length === 3) {
      const id = parts[2] as string
      this.sendJson(req, res, 200, redeemBatchOf(await redeem.getBatch(API_ACTOR, id)))
      return
    }
    throw notFound('没有这个批次接口')
  }

  /** 管理面：兑换码统计。 */
  private async routeAdminRedeemStats(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    await this.requireAdmin(req)
    if (!this.allowRead(req, res)) return
    const redeem = this.requireRedeem()
    this.sendJson(req, res, 200, redeemStatsOf(await redeem.stats(API_ACTOR)))
  }

  // ───────────────────────────────── 管理员：结算 ─────────────────────────────────

  /**
   * `GET /api/admin/billing`：结算记录 + 汇总（只读，真实扣费不在 HTTP 层发生）。
   *
   * 查询参数：`status`（结算状态或 `problem`）、`limit`、`offset`。
   * 金额一律写成十进制字符串（整数微元），浏览器用 BigInt 解析。
   */
  private async routeAdminBilling(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
    url: URL,
  ): Promise<void> {
    await this.requireAdmin(req)
    if (parts.length !== 2) throw notFound('没有这个结算接口')
    if (!this.allowRead(req, res)) return
    const billing = this.requireBilling()

    const status = queryStringOf(url, 'status')
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
    const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
    const page = await billing.list(API_ACTOR, {
      ...(status === undefined ? {} : { status }),
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    })
    const summary = await billing.summary(API_ACTOR)
    this.sendJson(req, res, 200, {
      totals: settleTotalsOf(summary.totals),
      daily: summary.daily.map(settleDailyOf),
      models: summary.models.map(settleModelOf),
      records: { items: page.items.map(settleRecordOf), total: page.total },
      generatedAt: this.runtime.now().toISOString(),
    })
  }

  // ───────────────────────────────── 管理员：审计 ─────────────────────────────────

  /**
   * `GET /api/admin/audit`：管理员操作审计（只读，时间倒序分页）。
   *
   * 查询参数：
   * - `actor` / `actorPlugin` / `action` / `targetType` / `targetId`：精确匹配；
   * - `from` / `to`：毫秒时间范围，左闭右开；
   * - `limit`（1..200，默认 50）/ `offset`（默认 0）；
   * - `stats=1`：附带汇总（总量 / 今天 / 24 小时 / 失败数 / Top 动作与操作者）。
   *
   * 读权限由审计服务判（`adminPlugins` 白名单，actor 是本插件）。审计服务缺席只让这条
   * 路由 503——**写操作照常成功**，审计是旁路（见 `audit.ts`）。
   */
  private async routeAdminAudit(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    await this.requireAdmin(req)
    if (!this.allowRead(req, res)) return
    const audit = this.runtime.audit()
    if (audit === undefined) {
      throw new ApiError('AUDIT_UNAVAILABLE', 503, '审计服务不在运行：暂时不能查询审计记录')
    }

    const query: {
      actor?: string
      actorPlugin?: string
      action?: string
      targetType?: string
      targetId?: string
      fromMs?: number
      toMs?: number
      limit?: number
      offset?: number
    } = {}
    for (const key of ['actor', 'actorPlugin', 'action', 'targetType', 'targetId'] as const) {
      const value = queryStringOf(url, key)
      if (value !== undefined) query[key] = value
    }
    const fromMs = parseIntegerParam(url.searchParams.get('from'), 'from', 0, 0, Number.MAX_SAFE_INTEGER)
    if (fromMs !== undefined && fromMs > 0) query.fromMs = fromMs
    const toMs = parseIntegerParam(url.searchParams.get('to'), 'to', 0, 0, Number.MAX_SAFE_INTEGER)
    if (toMs !== undefined && toMs > 0) query.toMs = toMs
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
    if (limit !== undefined) query.limit = limit
    const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
    if (offset !== undefined) query.offset = offset

    const page = audit.list(API_ACTOR, query as AuditQueryLike)
    const wantStats = url.searchParams.get('stats') === '1'
    this.sendJson(req, res, 200, {
      items: page.items,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      ...(wantStats ? { stats: audit.stats(API_ACTOR) } : {}),
    })
  }

  // ───────────────────────────────── 管理员：内容审核 ─────────────────────────────────

  /**
   * 管理面内容审核规则：`/api/admin/content-audit`。
   *
   * - `GET` → `{ items, status }`：规则列表 + 推送健康度 + Go 侧命中统计；
   * - `POST` → 新增规则（`pattern` 必填，`action` 默认 `block`）；
   * - `GET|PATCH|DELETE .../<id>` → 读一条 / 改一条 / 删一条（`enabled` 用来启停单条规则）；
   * - `POST .../push` → 立刻推一次（排障用），回 `{ revision }`。
   *
   * 三条纪律：
   * - **规则**的语义校验（长度 / 去重 / 上限 / 控制字符）全在插件里，这里只做形状校验，
   *   插件抛的稳定码由 `toApiError` 映射状态码；
   * - **审计在调用点记**：插件对 `audit` 零依赖，actor 只有这里知道。审计元数据里
   *   **不放 pattern**（关键词是管理面数据，没必要扩散到审计表），只放 id / action / 启停；
   * - 列表与状态是**只读**的，`allowRead` 照旧挡非 GET；`status` 里 Go 侧读不到就是 `null`。
   */
  private async routeAdminContentAudit(
    req: IncomingMessage,
    res: ServerResponse,
    parts: readonly string[],
  ): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
    const contentAudit = this.requireContentAudit()

    if (parts.length === 2) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!this.allowRead(req, res)) return
        const rules = contentAudit.list(API_ACTOR)
        this.sendJson(req, res, 200, {
          items: rules.map(contentAuditRuleOf),
          status: contentAuditStatusOf(await contentAudit.status()),
        })
        return
      }
      if (req.method === 'POST') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['pattern', 'action', 'category', 'enabled', 'note'])
        const input = contentAuditInputOf(body)
        const rule = await audited<ContentAuditRuleLike>(
          this.runtime,
          identity,
          {
            action: 'content_audit.rule.create',
            targetType: 'content-audit-rule',
            summary: `新增内容审核规则（${input.action === 'log' ? 'log' : 'block'}）`,
            metadataOf: (created) => contentAuditRuleMetadata(created),
          },
          () => contentAudit.create(API_ACTOR, input),
        )
        this.sendJson(req, res, 200, { rule: contentAuditRuleOf(rule) })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
      return
    }

    // `push` 是固定子路径；规则 id 一律是 `car_` 前缀，不会撞车。
    if (parts.length === 3 && parts[2] === 'push') {
      if (!this.allowMethod(req, res, ['POST'])) return
      this.sendJson(req, res, 200, { revision: await contentAudit.pushNow() })
      return
    }

    if (parts.length === 3) {
      const id = parts[2] as string
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!this.allowRead(req, res)) return
        const rule = contentAudit.get(API_ACTOR, id)
        if (rule === null) throw notFound('没有这条内容审核规则')
        this.sendJson(req, res, 200, { rule: contentAuditRuleOf(rule) })
        return
      }
      if (req.method === 'PATCH') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['pattern', 'action', 'category', 'enabled', 'note'])
        const patch = contentAuditPatchOf(body)
        const rule = await audited<ContentAuditRuleLike>(
          this.runtime,
          identity,
          {
            action: 'content_audit.rule.update',
            targetType: 'content-audit-rule',
            targetId: id,
            summary: '修改内容审核规则',
            metadata: { fields: Object.keys(patch) },
            metadataOf: (updated) => contentAuditRuleMetadata(updated),
          },
          () => contentAudit.update(API_ACTOR, id, patch),
        )
        this.sendJson(req, res, 200, { rule: contentAuditRuleOf(rule) })
        return
      }
      if (req.method === 'DELETE') {
        const removed = await audited<boolean>(
          this.runtime,
          identity,
          {
            action: 'content_audit.rule.delete',
            targetType: 'content-audit-rule',
            targetId: id,
            summary: '删除内容审核规则',
          },
          () => contentAudit.remove(API_ACTOR, id),
        )
        this.sendJson(req, res, 200, { removed })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
      return
    }

    throw notFound('没有这个内容审核接口')
  }

  // ───────────────────────────────── 管理员：运维总览 ─────────────────────────────────

  /**
   * `GET /api/admin/observability`：运维总览（只读聚合）。
   *
   * 返回 `observability` 插件现算的报告：六块事实 + 每块的**数据源健康度**
   * （`ok` / `degraded` / `unavailable` + 人话原因）+ 异常摘要 `warnings`。
   *
   * 两条纪律：
   * - **单块数据源缺失不是 HTTP 错误**：报告里标 `degraded`，接口照常 200；
   *   只有聚合插件本身不在运行时才 503（`OBSERVABILITY_UNAVAILABLE`）。
   * - 金额一律十进制字符串（整数微元），报告里没有 bigint；账号 id / label / baseUrl
   *   与任何秘密都不出现。
   */
  private async routeAdminObservability(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    await this.requireAdmin(req)
    if (!this.allowRead(req, res)) return
    const observability = this.runtime.observability()
    if (observability === undefined) {
      throw new ApiError(
        'OBSERVABILITY_UNAVAILABLE',
        503,
        '运维总览服务不在运行：暂时看不到聚合状态',
      )
    }
    this.sendJson(req, res, 200, await observability.observe())
  }

  // ───────────────────────────────── 管理员：用户 ─────────────────────────────────

  private async routeUsers(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    const actor = auditActorOf(adminView)

    if (parts.length === 1) {
      if (!this.allowRead(req, res)) return
      const query: { status?: UserStatusLike; offset?: number; limit?: number } = {}
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const status = url.searchParams.get('status')
      if (status !== null && status !== '') {
        if (status !== 'enabled' && status !== 'banned') throw badRequest('status 只能是 enabled / banned')
        query.status = status
      }
      const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 1_000_000)
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 100, 1, 1_000)
      if (offset !== undefined) query.offset = offset
      if (limit !== undefined) query.limit = limit
      const users = await this.runtime.user.list(query)
      this.sendJson(req, res, 200, { items: users.map(adminUserOf) })
      return
    }

    const id = parseUserId(parts[1])
    if (parts.length === 2) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const user = await this.runtime.user.get(id)
        if (user === undefined) throw notFound('没有这个用户')
        this.sendJson(req, res, 200, adminUserOf(user))
        return
      }
      if (req.method === 'PATCH') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['name', 'role', 'status', 'balanceEnabled'])
        const hasName = Object.hasOwn(body, 'name')
        const hasRole = Object.hasOwn(body, 'role')
        const hasStatus = Object.hasOwn(body, 'status')
        const hasBalanceEnabled = Object.hasOwn(body, 'balanceEnabled')
        if (!hasName && !hasRole && !hasStatus && !hasBalanceEnabled) throw badRequest('没有可修改的字段')

        const identity = { actor, actorPlugin: API_ACTOR }
        if (hasName) {
          await audited(
            this.runtime,
            identity,
            {
              action: 'user.rename',
              targetType: 'user',
              targetId: String(id),
              summary: `改名用户 #${id}`,
              metadata: { name: requiredString(body, 'name') },
            },
            () => this.runtime.user.rename(API_ACTOR, id, requiredString(body, 'name')),
          )
        }
        if (hasStatus) {
          const status = requiredString(body, 'status')
          if (status !== 'enabled' && status !== 'banned') throw badRequest('status 只能是 enabled / banned')
          await audited(
            this.runtime,
            identity,
            {
              action: 'user.status.set',
              targetType: 'user',
              targetId: String(id),
              summary: `把用户 #${id} 的状态改为 ${status}`,
              metadata: { status },
            },
            () => this.runtime.user.setStatus(API_ACTOR, id, status),
          )
        }
        if (hasRole) {
          const role = requiredString(body, 'role')
          if (role !== 'admin' && role !== 'user') throw badRequest('role 只能是 admin / user')
          const setRole = this.runtime.user.setRole
          if (typeof setRole !== 'function') {
            throw new ApiError(
              'API_USER_ROLE_UNAVAILABLE',
              503,
              '用户插件没有提供 setRole 接口',
            )
          }
          await audited(
            this.runtime,
            identity,
            {
              action: 'user.role.set',
              targetType: 'user',
              targetId: String(id),
              summary: `把用户 #${id} 的角色改为 ${role}`,
              metadata: { role },
            },
            () => setRole.call(this.runtime.user, API_ACTOR, id, role),
          )
        }
        if (hasBalanceEnabled) {
          const enabled = requiredBoolean(body, 'balanceEnabled')
          const setBalanceEnabled = this.runtime.user.setBalanceEnabled
          if (typeof setBalanceEnabled !== 'function') {
            throw new ApiError(
              'API_USER_BALANCE_ENABLED_UNAVAILABLE',
              503,
              '用户插件没有提供 setBalanceEnabled 接口',
            )
          }
          await audited(
            this.runtime,
            identity,
            {
              action: 'user.balance_enabled.set',
              targetType: 'user',
              targetId: String(id),
              summary: `${enabled ? '打开' : '关闭'}用户 #${id} 的余额展示`,
              metadata: { balanceEnabled: enabled },
            },
            () => setBalanceEnabled.call(this.runtime.user, API_ACTOR, id, enabled),
          )
        }

        const user = await this.runtime.user.get(id)
        if (user === undefined) throw notFound('没有这个用户')
        this.sendJson(req, res, 200, adminUserOf(user))
        return
      }
      if (req.method === 'DELETE') {
        await audited(
          this.runtime,
          { actor, actorPlugin: API_ACTOR },
          {
            action: 'user.remove',
            targetType: 'user',
            targetId: String(id),
            summary: `删除用户 #${id}`,
          },
          () => this.runtime.user.remove(API_ACTOR, id),
        )
        this.sendJson(req, res, 200, { removed: true })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
      return
    }

    if (parts.length === 3 && parts[2] === 'balance') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, ['delta', 'reason'])
      const deltaText = requiredString(body, 'delta')
      if (!/^-?\d+$/.test(deltaText)) throw badRequest('delta 必须是十进制整数字符串（最小单位）')
      const reason = requiredString(body, 'reason')
      const balance = await audited(
        this.runtime,
        { actor, actorPlugin: API_ACTOR },
        {
          action: 'user.balance.adjust',
          targetType: 'user',
          targetId: String(id),
          summary: `调整用户 #${id} 的余额（${deltaText} 微元）：${reason}`,
          // 金额一律十进制字符串：变化量走整数最小单位，不经浮点。
          metadata: { deltaMicros: deltaText, reason },
          metadataOf: (after) => ({ balanceAfterMicros: after.toString() }),
        },
        () => this.runtime.user.adjustBalance(API_ACTOR, id, BigInt(deltaText), reason),
      )
      this.sendJson(req, res, 200, { balanceMinor: balance.toString() })
      return
    }

    throw notFound('没有这个用户接口')
  }

  // ───────────────────────────────── 管理员：上游账号 ─────────────────────────────────

  private async routeAccounts(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
    const accountAdmin = this.requireAccountAdmin()

    if (parts.length === 1) {
      if (req.method === 'POST') {
        const create = accountAdmin.create
        if (typeof create !== 'function') {
          throw new ApiError('API_ACCOUNT_CREATE_UNAVAILABLE', 503, '账号管理服务不支持新建账号')
        }
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, [
          'provider',
          'kind',
          'label',
          'email',
          'subject',
          'baseUrl',
          'protocol',
          'models',
          'modelMap',
          'priority',
          'enabled',
          'credential',
        ])
        const provider = requiredString(body, 'provider')
        const kind = requiredString(body, 'kind')
        const label = requiredString(body, 'label')
        const email = optionalString(body, 'email')
        const subject = optionalString(body, 'subject')
        const baseUrl = optionalString(body, 'baseUrl')
        const protocol = optionalString(body, 'protocol')
        const models = optionalStringArray(body, 'models')
        const modelMap = optionalStringMap(body, 'modelMap')
        const priority = optionalInteger(body, 'priority', 0, 1000)
        const enabled = body.enabled === undefined ? undefined : requiredBoolean(body, 'enabled')
        const credential = accountCredentialOf(body.credential)
        const input = {
          provider,
          kind,
          label,
          ...(email === undefined ? {} : { email }),
          ...(subject === undefined ? {} : { subject }),
          ...(baseUrl === undefined ? {} : { baseUrl }),
          ...(protocol === undefined ? {} : { protocol }),
          ...(models === undefined ? {} : { models }),
          ...(modelMap === undefined ? {} : { modelMap }),
          ...(priority === undefined ? {} : { priority }),
          ...(enabled === undefined ? {} : { enabled }),
          ...(credential === undefined ? {} : { credential }),
        }
        this.sendJson(
          req,
          res,
          200,
          accountOf(
            await audited(
              this.runtime,
              identity,
              {
                action: 'account.create',
                targetType: 'account',
                summary: `新建上游账号 ${label}`,
                metadata: { provider, kind },
                metadataOf: (account) => ({ accountId: accountOf(account).id }),
              },
              () => create.call(accountAdmin, API_ACTOR, input),
            ),
          ),
        )
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
        return
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const provider = url.searchParams.get('provider') ?? undefined
      const status = url.searchParams.get('status') ?? undefined
      const cursor = parseIntegerParam(url.searchParams.get('cursor'), 'cursor', 0, 0, 1_000_000)
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
      const all = await accountAdmin.list({
        ...(provider === undefined || provider === '' ? {} : { provider }),
        ...(status === undefined || status === '' ? {} : { status }),
      })
      const offset = cursor ?? 0
      const size = limit ?? 50
      const page = all.slice(offset, offset + size)
      this.sendJson(req, res, 200, {
        items: page.map(accountOf),
        nextCursor: offset + size < all.length ? String(offset + size) : null,
      })
      return
    }

    if (parts.length === 2 && parts[1] === 'import') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const body = await this.jsonBody(req)
      // body 里有 `source` 时按 new-api / sub2api / 纯 key 的来源格式导入；否则沿用逐项格式。
      if (Object.hasOwn(body, 'source')) {
        const importSource = accountAdmin.importSource
        if (typeof importSource !== 'function') {
          throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持按来源导入')
        }
        assertOnlyKeys(body, ['source', 'payload', 'defaults'])
        const source = requiredString(body, 'source')
        const payload = requiredString(body, 'payload')
        const defaults = Object.hasOwn(body, 'defaults') ? body.defaults : undefined
        const input = { source, payload, ...(defaults === undefined ? {} : { defaults }) }
        this.sendJson(
          req,
          res,
          200,
          normalizeBulkImport(
            await audited(
              this.runtime,
              identity,
              {
                action: 'account.import',
                targetType: 'account',
                summary: `按来源批量导入上游账号（${source}）`,
                // 只记来源格式与选项，**绝不记 payload**（里面是 key / 凭据）。
                metadata: { source, hasDefaults: defaults !== undefined },
              },
              () => importSource.call(accountAdmin, API_ACTOR, input),
            ),
          ),
        )
        return
      }
      const bulk = accountAdmin.importAccounts
      if (typeof bulk !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持批量导入')
      }
      this.sendJson(
        req,
        res,
        200,
        normalizeBulkImport(
          await audited(
            this.runtime,
            identity,
            {
              action: 'account.import',
              targetType: 'account',
              summary: '批量导入上游账号（逐项格式）',
            },
            () => bulk.call(accountAdmin, API_ACTOR, body),
          ),
        ),
      )
      return
    }

    if (parts.length === 3 && parts[1] === 'import' && parts[2] === 'preview') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const body = await this.jsonBody(req)
      if (Object.hasOwn(body, 'source')) {
        const previewSource = accountAdmin.previewImportSource
        if (typeof previewSource !== 'function') {
          throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持按来源导入')
        }
        assertOnlyKeys(body, ['source', 'payload', 'defaults'])
        const source = requiredString(body, 'source')
        const payload = requiredString(body, 'payload')
        const defaults = Object.hasOwn(body, 'defaults') ? body.defaults : undefined
        const input = { source, payload, ...(defaults === undefined ? {} : { defaults }) }
        this.sendJson(req, res, 200, previewSource.call(accountAdmin, input))
        return
      }
      const preview = accountAdmin.previewImport
      if (typeof preview !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持导入预检')
      }
      this.sendJson(req, res, 200, preview.call(accountAdmin, body))
      return
    }

    const id = parts[1] as string
    if (parts.length === 2) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        this.sendJson(req, res, 200, accountOf(await accountAdmin.get(id)))
        return
      }
      if (req.method === 'PATCH') {
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, [
          'label',
          'email',
          'subject',
          'baseUrl',
          'protocol',
          'models',
          'modelMap',
          'priority',
          'enabled',
        ])
        const hasMeta =
          Object.hasOwn(body, 'label') ||
          Object.hasOwn(body, 'email') ||
          Object.hasOwn(body, 'subject') ||
          Object.hasOwn(body, 'baseUrl') ||
          Object.hasOwn(body, 'protocol') ||
          Object.hasOwn(body, 'models') ||
          Object.hasOwn(body, 'modelMap') ||
          Object.hasOwn(body, 'priority')
        const hasEnabled = Object.hasOwn(body, 'enabled')
        if (!hasMeta && !hasEnabled) throw badRequest('没有可修改的字段')

        if (hasMeta) {
          const patch: {
            label?: string
            email?: string | null
            subject?: string | null
            baseUrl?: string | null
            protocol?: string | null
            models?: string[] | null
            modelMap?: Record<string, string> | null
            priority?: number
          } = {}
          if (Object.hasOwn(body, 'label')) patch.label = requiredString(body, 'label')
          if (Object.hasOwn(body, 'email')) patch.email = nullableString(body, 'email')
          if (Object.hasOwn(body, 'subject')) patch.subject = nullableString(body, 'subject')
          if (Object.hasOwn(body, 'baseUrl')) patch.baseUrl = nullableString(body, 'baseUrl')
          if (Object.hasOwn(body, 'protocol')) patch.protocol = nullableString(body, 'protocol')
          if (Object.hasOwn(body, 'models')) patch.models = nullableStringArray(body, 'models')
          if (Object.hasOwn(body, 'modelMap')) patch.modelMap = nullableStringMap(body, 'modelMap')
          if (Object.hasOwn(body, 'priority')) patch.priority = optionalInteger(body, 'priority', 0, 1000)
          await audited(
            this.runtime,
            identity,
            {
              action: 'account.update',
              targetType: 'account',
              targetId: id,
              summary: `修改上游账号 ${id} 的字段：${Object.keys(patch).join(' / ')}`,
              metadata: { fields: Object.keys(patch) },
            },
            () => accountAdmin.update(API_ACTOR, id, patch),
          )
        }
        if (hasEnabled) {
          const enabled = requiredBoolean(body, 'enabled')
          await audited(
            this.runtime,
            identity,
            {
              action: enabled ? 'account.enable' : 'account.disable',
              targetType: 'account',
              targetId: id,
              summary: `${enabled ? '启用' : '停用'}上游账号 ${id}`,
              metadata: { enabled },
            },
            () => (enabled ? accountAdmin.enable(API_ACTOR, id) : accountAdmin.disable(API_ACTOR, id)),
          )
        }
        this.sendJson(req, res, 200, accountOf(await accountAdmin.get(id)))
        return
      }
      if (req.method === 'DELETE') {
        await audited(
          this.runtime,
          identity,
          {
            action: 'account.remove',
            targetType: 'account',
            targetId: id,
            summary: `删除上游账号 ${id}`,
          },
          () => accountAdmin.remove(API_ACTOR, id),
        )
        this.sendJson(req, res, 200, { removed: true })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
      return
    }

    if (parts.length === 3 && parts[2] === 'test') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const testConnection = accountAdmin.testConnection
      if (typeof testConnection !== 'function') {
        throw new ApiError('API_ACCOUNT_TEST_UNAVAILABLE', 503, '账号管理服务不支持连通性测试')
      }
      const body = await this.jsonBody(req)
      assertOnlyKeys(body, ['model', 'protocol'])
      const model = optionalString(body, 'model')
      const protocol = optionalString(body, 'protocol')
      const input = {
        ...(model === undefined ? {} : { model }),
        ...(protocol === undefined ? {} : { protocol }),
      }
      this.sendJson(req, res, 200, await testConnection.call(accountAdmin, id, input))
      return
    }

    if (parts.length === 3 && parts[2] === 'credentials') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const importCredentials = accountAdmin.importCredentials
      if (typeof importCredentials !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持导入凭据')
      }
      const body = await this.jsonBody(req)
      const payload = body.payload
      if (typeof payload !== 'string' && !isPlainObject(payload)) {
        throw badRequest('payload 必须是字符串或 JSON 对象')
      }
      const format = optionalString(body, 'format')
      const input = { payload, ...(format === undefined ? {} : { format }) }
      this.sendJson(
        req,
        res,
        200,
        accountOf(
          await audited(
            this.runtime,
            identity,
            {
              action: 'account.import_credentials',
              targetType: 'account',
              targetId: id,
              summary: `为上游账号 ${id} 导入凭据`,
              // 只记格式；**payload 里是凭据，绝不进审计**。
              metadata: { format: format ?? 'auto' },
            },
            () => importCredentials.call(accountAdmin, API_ACTOR, id, input),
          ),
        ),
      )
      return
    }

    throw notFound('没有这个账号接口')
  }

  // ───────────────────────────────── 管理员：目录与设置 ─────────────────────────────────

  private async catalogModules(
    catalog: CatalogPort,
  ): Promise<{ generatedAt: string; modules: readonly CatalogModuleView[] }> {
    // 禁用模块也要列出来（便于排障）；它们是 disabled，不会被当成 available。
    const result = await catalog.query({ includeUnavailable: true })
    let pages: readonly FrontendPageLike[] = []
    try {
      pages = this.runtime.frontend()?.pages() ?? []
    } catch {
      pages = []
    }
    const modules = result.plugins.map((plugin) => {
      const manifest = plugin.manifest as { description?: unknown } | undefined
      const capabilities = Array.isArray(plugin.capabilities) ? plugin.capabilities : []
      return {
        id: plugin.id,
        package: plugin.package,
        kind: plugin.kind,
        state: catalogState(plugin.disabled ? 'disabled' : plugin.state),
        version: null,
        description: typeof manifest?.description === 'string' ? manifest.description : null,
        provides: [...capabilities],
        pages: pages
          .filter((page) => page.owner === plugin.id || page.owner === plugin.package)
          .map((page) => page.path),
      }
    })
    return { generatedAt: result.generatedAt, modules }
  }

  private async routeSettings(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    const { view: adminView } = await this.requireAdmin(req)
    const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }

    if (parts.length === 1) {
      if (!this.allowRead(req, res)) return
      const settings = this.requireSettings()
      const described = await settings.describe()
      // 新 settings 直接返回 `{ namespaces }`；旧实现返回数组。两种都接住。
      const namespaces = Array.isArray(described)
        ? described
        : isPlainObject(described) && Array.isArray(described.namespaces)
          ? described.namespaces
          : null
      if (namespaces === null) {
        throw new ApiError('API_RESPONSE_INVALID', 502, '设置服务返回了无法识别的描述')
      }
      this.sendJson(req, res, 200, { namespaces })
      return
    }

    const ns = parts[1] as string
    if (parts.length === 2) {
      if (req.method === 'POST') {
        const settings = this.requireSettings()
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['patch', 'expectedRevision'])
        if (!isPlainObject(body.patch)) throw badRequest('patch 必须是对象')
        const expectedRevision = optionalString(body, 'expectedRevision')
        const patch = body.patch as Record<string, unknown>
        const updated = await audited(
          this.runtime,
          identity,
          {
            action: 'settings.write',
            targetType: 'settings',
            targetId: ns,
            summary: `修改设置 ${ns}：${Object.keys(patch).join(' / ')}`,
            // 只记字段名：设置里可能有 pass / 授权码之类，值不进审计。
            metadata: { fields: Object.keys(patch), expectedRevision: expectedRevision ?? null },
          },
          () => settings.update(API_ACTOR, ns, patch, expectedRevision),
        )
        this.sendJson(req, res, 200, updated)
        return
      }
      if (req.method === 'DELETE') {
        const settings = this.requireSettings()
        const reset = await audited(
          this.runtime,
          identity,
          {
            action: 'settings.reset',
            targetType: 'settings',
            targetId: ns,
            summary: `把设置 ${ns} 重置为 app.yml 的基线`,
          },
          () => settings.reset(API_ACTOR, ns),
        )
        this.sendJson(req, res, 200, reset)
        return
      }
      this.sendMethodNotAllowed(req, res, ['POST', 'DELETE'])
      return
    }

    throw notFound('没有这个设置接口')
  }

  // ───────────────────────────────── 会话 ─────────────────────────────────

  private sessionToken(req: IncomingMessage): string {
    const token = readCookie(req, this.config.sessionCookieName)
    if (token === undefined || token === '') throw unauthorized('会话 cookie 不存在，请重新登录')
    return token
  }

  /**
   * 会话校验。auth 的原始错误细节不往外带：只保留稳定 code，消息统一成通用文案。
   * banned 是 403，其余会话问题统一 401。
   */
  private async requireSession(req: IncomingMessage): Promise<SessionViewLike> {
    const token = this.sessionToken(req)
    try {
      return await this.runtime.auth.verifySession(token)
    } catch (error) {
      if (isApiError(error)) throw error
      const code = errorCodeOf(error)
      if (code === 'AUTH_USER_BANNED') {
        throw new ApiError(code, 403, '当前账号不可用')
      }
      if (
        code === 'AUTH_SESSION_INVALID' ||
        code === 'AUTH_SESSION_EXPIRED' ||
        code === 'AUTH_USER_MISSING'
      ) {
        throw new ApiError(code, 401, '需要登录后才能访问')
      }
      throw error
    }
  }

  private async requireAdmin(req: IncomingMessage): Promise<{ view: SessionViewLike; role: SessionRole }> {
    const view = await this.requireSession(req)
    const role = roleOf(view.user)
    if (role !== 'admin') throw forbidden()
    return { view, role }
  }

  private async sessionResponse(view: SessionViewLike): Promise<unknown> {
    // 新 auth 会直接在会话视图里给 email；旧 auth 没有这个字段时退回 getEmail。
    const viewEmail = typeof view.email === 'string' && view.email !== '' ? view.email : null
    return {
      user: sessionUserOf(view.user),
      email: viewEmail ?? (await this.emailOf(view.userId)),
      session: sessionInfoOf(view),
      permissions: { admin: roleOf(view.user) === 'admin' },
    }
  }

  private loginResponse(result: LoginResultLike): unknown {
    const now = this.runtime.now().toISOString()
    return {
      user: sessionUserOf(result.user),
      session: {
        id: result.sessionId,
        createdAt: now,
        expiresAt: result.expiresAt,
        lastSeenAt: now,
      } satisfies SessionInfoView,
    }
  }

  private async emailOf(userId: number): Promise<string | null> {
    const getEmail = this.runtime.auth.getEmail
    if (typeof getEmail !== 'function') return null
    try {
      const email = await getEmail.call(this.runtime.auth, userId)
      return typeof email === 'string' && email !== '' ? email : null
    } catch {
      return null
    }
  }

  private setSessionCookie(
    req: IncomingMessage,
    res: ServerResponse,
    token: string,
    expiresAt: string,
  ): void {
    const expires = Date.parse(expiresAt)
    const maxAge = Number.isFinite(expires)
      ? Math.max(1, Math.floor((expires - this.runtime.now().getTime()) / 1_000))
      : 60 * 60
    res.setHeader(
      'Set-Cookie',
      `${this.config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.secureCookie(req)}`,
    )
  }

  private clearSessionCookie(req: IncomingMessage, res: ServerResponse): void {
    res.setHeader(
      'Set-Cookie',
      `${this.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookie(req)}`,
    )
  }

  /**
   * 反向代理终止 TLS 时，`req.socket.encrypted` 在 Node 侧是 false，但 Caddy 会带
   * `X-Forwarded-Proto: https`。只有确认请求是 HTTPS 才加 `Secure`，这样本机
   * `http://127.0.0.1` 的开发预览仍然能收到 cookie。
   */
  private secureCookie(req: IncomingMessage): string {
    const socket = req.socket as { encrypted?: boolean }
    const forwarded = req.headers['x-forwarded-proto']
    const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
    return socket.encrypted === true || proto === 'https' ? '; Secure' : ''
  }

  // ───────────────────────────────── 健康 ─────────────────────────────────

  private async health(): Promise<GatewayHealthView> {
    const components: GatewayComponentHealth[] = [
      { name: 'api', state: 'ok', detail: `listen 127.0.0.1:${this.port}` },
      { name: 'auth', state: 'ok' },
    ]

    try {
      await this.runtime.user.list({ limit: 1 })
      components.push({ name: 'user', state: 'ok' })
    } catch {
      components.push({ name: 'user', state: 'down', detail: '读取用户表失败' })
    }

    const frontend = this.runtime.frontend()
    if (frontend === undefined) {
      // 只有确认「新前端 web 在跑」时，旧 SPA 未启用才算正常；否则仍是缺失。
      const web = this.runtime.web()
      components.push(web === undefined
        ? { name: 'frontend', state: 'degraded', detail: '服务不在运行' }
        : { name: 'frontend', state: 'ok', detail: '旧 SPA 未启用（由 web 接管）' })
    } else {
      try {
        const current = await frontend.current()
        components.push({
          name: 'frontend',
          state: current === null ? 'degraded' : 'ok',
          ...(current === null ? { detail: '没有安装前端资源' } : { detail: `asset ${current.version}` }),
        })
      } catch {
        components.push({ name: 'frontend', state: 'down', detail: '前端宿主不可用' })
      }
    }

    const catalog = this.runtime.catalog()
    if (catalog === undefined) {
      components.push({ name: 'catalog', state: 'degraded', detail: '服务不在运行' })
    } else {
      try {
        const snapshot = await catalog.query({ includeUnavailable: false })
        components.push({ name: 'catalog', state: 'ok', detail: `${snapshot.plugins.length} 个活动插件` })
      } catch {
        components.push({ name: 'catalog', state: 'down', detail: '能力目录不可用' })
      }
    }

    components.push(
      this.runtime.accountAdmin() === undefined
        ? { name: 'account-admin', state: 'degraded', detail: '服务不在运行' }
        : { name: 'account-admin', state: 'ok' },
    )

    let bridge: GatewayHealthView['bridge'] = { connected: false, transport: null, address: null }
    const priority = this.runtime.accountPriority()
    if (priority === undefined) {
      components.push({ name: 'account-priority', state: 'degraded', detail: '服务不在运行' })
    } else {
      try {
        const status = await priority.status()
        bridge = {
          connected: status.bridgeConnected === true,
          transport: status.transport ?? null,
          address: status.address ?? null,
        }
        components.push({
          name: 'account-priority',
          state: priorityState(status.state),
          detail: `state=${status.state} revision=${status.revision ?? '—'} accounts=${status.accounts}`,
        })
      } catch {
        components.push({ name: 'account-priority', state: 'down', detail: '状态查询失败' })
      }
    }

    const state: GatewayHealthState = components.some((component) => component.state === 'down')
      ? 'down'
      : components.some((component) => component.state === 'degraded')
        ? 'degraded'
        : 'ok'

    return {
      state,
      at: this.runtime.now().toISOString(),
      version: API_VERSION,
      uptimeSec: this.runtime.uptimeSec(),
      descriptorRevision: null,
      bridge,
      components,
    }
  }

  // ───────────────────────────────── 内部工具 ─────────────────────────────────

  private requireFrontend(): FrontendPort {
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

  private requireAccountAdmin(): AccountAdminPort {
    const accountAdmin = this.runtime.accountAdmin()
    if (accountAdmin === undefined) {
      throw new ApiError('ACCOUNT_ADMIN_UNAVAILABLE', 503, '账号管理门面不在运行')
    }
    return accountAdmin
  }

  private requireApiKey(): ApiKeyPort {
    const apiKey = this.runtime.apiKey()
    if (apiKey === undefined) {
      throw new ApiError('API_KEY_UNAVAILABLE', 503, 'API key 服务不在运行')
    }
    return apiKey
  }

  private requireUsage(): UsagePort {
    const usage = this.runtime.usage()
    if (usage === undefined) {
      throw new ApiError('API_ADMIN_USAGE_UNAVAILABLE', 503, '用量插件不在运行')
    }
    return usage
  }

  private requireSettings(): SettingsPort {
    const settings = this.runtime.settings()
    if (settings === undefined) {
      throw new ApiError('API_SETTINGS_UNAVAILABLE', 503, '设置插件不在运行')
    }
    return settings
  }

  private requireRedeem(): RedeemPort {
    const redeem = this.runtime.redeem()
    if (redeem === undefined) {
      throw new ApiError('REDEEM_UNAVAILABLE', 503, '兑换码服务不在运行')
    }
    return redeem
  }

  private requireBilling(): BillingPort {
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

  private requireTopup(): TopupPort {
    const topup = this.runtime.topup()
    if (topup === undefined) {
      throw new ApiError('TOPUP_UNAVAILABLE', 503, '充值订单服务不在运行：暂时不能下单或确认到账')
    }
    return topup
  }

  private requireContentAudit(): ContentAuditPort {
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

  private allowRead(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method === 'GET' || req.method === 'HEAD') return true
    this.sendMethodNotAllowed(req, res, ['GET', 'HEAD'])
    return false
  }

  private allowMethod(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean {
    if (req.method !== undefined && allowed.includes(req.method)) return true
    this.sendMethodNotAllowed(req, res, allowed)
    return false
  }

  private async jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const body = await readBody(req, this.config.bodyLimitBytes)
    if (body.length === 0) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      throw new ApiError('API_INVALID_JSON', 400, '请求体不是合法 JSON')
    }
    if (!isPlainObject(parsed)) throw badRequest('请求体必须是 JSON 对象')
    return parsed
  }

  private sendJson(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    value: unknown,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    const body = Buffer.from(safeJson(value), 'utf8')
    this.sendBody(req, res, status, 'application/json; charset=utf-8', body, {
      'Cache-Control': NO_STORE,
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    })
  }

  private sendBody(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    contentType: string,
    body: Buffer,
    headers: Readonly<Record<string, string>> = {},
  ): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
      ...headers,
    })
    if (req.method === 'HEAD') res.end()
    else res.end(body)
  }

  private sendMethodNotAllowed(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): void {
    res.setHeader('Allow', allowed.join(', '))
    this.sendJson(req, res, 405, {
      error: {
        code: 'API_METHOD_NOT_ALLOWED',
        message: `不支持 ${req.method ?? '未知方法'}；允许：${allowed.join(', ')}`,
        requestId: requestIdOf(res),
      },
    })
  }

  private respondError(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    const apiError = toApiError(error)
    if (!isApiError(error)) {
      const message = error instanceof Error ? error.message : String(error)
      // 领域错误（4xx）是正常拒绝，别记成内部错误；只有 5xx 才是真的需要排障。
      if (apiError.status >= 500) {
        this.runtime.log('error', `产品 HTTP 入口内部错误：${message}`)
      } else {
        this.runtime.log('warn', `产品 HTTP 入口拒绝请求：${apiError.code} ${message}`)
      }
    }
    try {
      this.sendJson(req, res, apiError.status, {
        error: {
          code: apiError.code,
          message: apiError.message,
          requestId: requestIdOf(res),
        },
      })
    } catch {
      if (!res.headersSent) res.writeHead(apiError.status)
      res.end()
    }
  }
}

// ───────────────────────────────── 纯函数 ─────────────────────────────────

function isSpaPath(pathname: string): boolean {
  return (
    pathname === '/console' ||
    pathname.startsWith('/console/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  )
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw badRequest('路径含有非法百分号编码')
  }
}

function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

function requestIdOf(res: ServerResponse): string | null {
  const value = res.getHeader('X-Request-Id')
  return typeof value === 'string' ? value : null
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) {
    throw new ApiError('API_BODY_TOO_LARGE', 413, `请求体超过上限 ${limit} 字节`)
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.length
    if (total > limit) throw new ApiError('API_BODY_TOO_LARGE', 413, `请求体超过上限 ${limit} 字节`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    const value = part.slice(index + 1).trim()
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return undefined
}

function deviceMeta(req: IncomingMessage): { userAgent?: string; ip?: string } {
  const userAgent = req.headers['user-agent']
  const ip = req.socket.remoteAddress
  return {
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(typeof ip === 'string' ? { ip } : {}),
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} 必须是非空字符串`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} 必须是非空字符串`)
  return value
}

function nullableString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} 必须是非空字符串或 null`)
  return value
}

/** 只做形状校验：数组且元素都是字符串。语义（trim / 去重 / 上限）由 identity 归一化。 */
function readStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw badRequest(`${key} 必须是字符串数组`)
  for (const item of value) {
    if (typeof item !== 'string') throw badRequest(`${key} 的元素必须是字符串`)
  }
  return value as string[]
}

/** 只做形状校验：对象且值都是字符串。 */
function readStringMap(value: unknown, key: string): Record<string, string> {
  if (!isPlainObject(value)) throw badRequest(`${key} 必须是 JSON 对象`)
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') throw badRequest(`${key}.${entryKey} 必须是字符串`)
  }
  return value as Record<string, string>
}

/** 没给（或给了 null）→ `undefined`（新建时等同未声明）。 */
function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  return readStringArray(value, key)
}

function optionalStringMap(body: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  return readStringMap(value, key)
}

/** PATCH 里区分「没给」与「给了 null」：`null` 表示清空为未声明。 */
function nullableStringArray(body: Record<string, unknown>, key: string): string[] | null {
  const value = body[key]
  if (value === null) return null
  return readStringArray(value, key)
}

function nullableStringMap(body: Record<string, unknown>, key: string): Record<string, string> | null {
  const value = body[key]
  if (value === null) return null
  return readStringMap(value, key)
}

/**
 * 新建账号时的可选凭据。只做形状校验；格式识别与秘密落库由 account-admin /
 * identity 负责，HTTP 层不解析、不回显 payload。
 */
function accountCredentialOf(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw badRequest('credential 必须是对象')
  assertOnlyKeys(value, ['payload', 'format', 'provider', 'kind'])
  const payload = value.payload
  if (typeof payload !== 'string' && !isPlainObject(payload)) {
    throw badRequest('credential.payload 必须是字符串或 JSON 对象')
  }
  if (typeof payload === 'string' && payload.trim() === '') {
    throw badRequest('credential.payload 不能为空')
  }
  const format = optionalString(value, 'format')
  const provider = optionalString(value, 'provider')
  const kind = optionalString(value, 'kind')
  return {
    payload,
    ...(format === undefined ? {} : { format }),
    ...(provider === undefined ? {} : { provider }),
    ...(kind === undefined ? {} : { kind }),
  }
}

function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw badRequest(`${key} 必须是布尔值`)
  return value
}

function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} 必须是 ${min}..${max} 的整数`)
  }
  return value
}

/**
 * 金额入参：只接受十进制整数微元（字符串或安全整数），**绝不经过浮点解析**。
 * 1 元 = 1_000_000 微元；传 `"5"` 表示 5 微元，不是 5 元。
 */
function requiredMicros(body: Record<string, unknown>, key: string): bigint {
  const value = body[key]
  let text: string
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    text = value.trim()
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    text = String(value)
  } else {
    throw badRequest(`${key} 必须是正整数微元的十进制字符串（1 元 = 1000000 微元）`)
  }
  return BigInt(text)
}

const AVATAR_MAX_BYTES = 256 * 1024
const AVATAR_URL_MAX_LENGTH = 2048
const AVATAR_DATA_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i

/**
 * 头像与 user 插件的约定对齐：
 * - `http(s)://` URL，长度 ≤ 2048；
 * - `image/png|jpeg|webp|gif` 的 base64 data URL，**解码后** ≤ 256 KiB；
 * - 其他 scheme / MIME 一律拒绝。
 *
 * 注意：CSP 只放行 `https:` 外链；`http:` 头像能存进用户表，但浏览器会按 CSP 拦下。
 */
function optionalAvatar(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value === '') {
    throw badRequest('avatar 必须是 data URL、http(s) URL 或 null')
  }

  if (value.startsWith('data:')) {
    const match = AVATAR_DATA_RE.exec(value)
    if (match === null) {
      throw badRequest('avatar 必须是 png / jpeg / webp / gif 的 base64 data URL')
    }
    const decoded = Buffer.from(match[2] as string, 'base64')
    if (decoded.length > AVATAR_MAX_BYTES) {
      throw new ApiError('API_BODY_TOO_LARGE', 413, '头像解码后不能超过 256 KiB')
    }
    return value
  }

  if (value.length > AVATAR_URL_MAX_LENGTH) {
    throw badRequest(`avatar URL 最长 ${AVATAR_URL_MAX_LENGTH} 个字符`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw badRequest('avatar 必须是合法的 http(s) URL 或 data URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('avatar 只支持 http / https / data URL')
  }
  return value
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest(`不支持字段：${key}`)
  }
}

function parseIntegerParam(
  value: string | null,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === null || value === '') return fallback
  if (!/^\d+$/.test(value)) throw badRequest(`${name} 必须是非负整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} 必须在 ${min}..${max} 之间`)
  }
  return parsed
}

function parseUserId(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value)) throw badRequest('用户 ID 必须是正整数')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('用户 ID 必须是正整数')
  return id
}

function roleOf(user: UserLike): SessionRole {
  return user.role === 'admin' ? 'admin' : 'user'
}

function sessionUserOf(user: UserLike): SessionUserView {
  const role = roleOf(user)
  const balanceEnabled = user.balanceEnabled === true
  return {
    id: user.id,
    name: user.name,
    status: user.status,
    role,
    balanceEnabled,
    balanceCents: role === 'admin' || balanceEnabled ? centsOf(user.balance) : null,
    avatar: typeof user.avatar === 'string' && user.avatar !== '' ? user.avatar : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function adminUserOf(user: UserLike): AdminUserView {
  return {
    id: user.id,
    name: user.name,
    status: user.status,
    role: roleOf(user),
    balanceEnabled: user.balanceEnabled === true,
    balanceMinor: user.balance.toString(),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function sessionInfoOf(view: SessionViewLike): SessionInfoView {
  return {
    id: view.sessionId,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    lastSeenAt: view.lastSeenAt,
  }
}

/** 最小单位 → 整数分。1 分 = 10_000 个最小单位；超出安全整数时夹到边界。 */
function centsOf(balance: bigint): number {
  const cents = balance / BALANCE_MINOR_UNITS_PER_CENT
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  if (cents < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER
  return Number(cents)
}

function dateOf(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * 整数微元 → 整数分（1 分 = 10_000 微元）。先做 BigInt 除法再转 number，
 * 避免 `Number(costMicros) / 10_000` 丢精度；解析失败按 0。
 */
function costCentsOf(costMicros: string): number {
  try {
    return Number(BigInt(costMicros) / 10_000n)
  } catch {
    return 0
  }
}

/**
 * 服务口径 → 页面口径。
 *
 * `tokens` 是四个桶之和（input / output / cacheRead / cacheWrite）；`costCents`
 * 是给图表的粗口径，`costMicros` 才是精确值。
 */
function usageTotalsOf(totals: UsageTotalsLike): {
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costCents: number
  costMicros: string
} {
  return {
    requests: totals.requests,
    tokens:
      totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costCents: costCentsOf(totals.costMicros),
    costMicros: totals.costMicros,
  }
}

function usageDailyOf(point: UsageDailyPointLike) {
  return { date: point.date, ...usageTotalsOf(point) }
}

function usageModelOf(item: UsageModelBreakdownLike) {
  return { model: item.model, ...usageTotalsOf(item) }
}

function usageUserOf(item: UsageUserBreakdownLike, name: string | null) {
  return { userId: item.userId, name, ...usageTotalsOf(item) }
}

/** 隔离区一行：原始载荷 + 原因 + 失败次数 + 状态（稳定英文字符串）。 */
function rejectedRowOf(row: UsageRejectedRowLike) {
  return {
    reqId: row.reqId,
    epoch: row.epoch,
    seq: row.seq,
    payload: row.payload,
    error: row.error,
    failures: row.failures,
    status: row.status,
    firstFailedAt: row.firstFailedAt,
    updatedAt: row.updatedAt,
  }
}

/** 管理员明细行：用户侧字段 + userName / accountId / attempts。 */
function adminUsageRowOf(row: UsageRowLike, userName: string | null) {
  return {
    id: row.id,
    reqId: row.reqId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName,
    model: row.model,
    upstreamModel: row.upstreamModel ?? null,
    protocol: row.protocol,
    upstreamProtocol: row.upstreamProtocol ?? null,
    stream: row.stream,
    status: row.status,
    errorCode: row.errorCode ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    clientIp: row.clientIp ?? null,
    startedAt: row.startedAt,
    costMicros: row.costMicros,
    userName,
    accountId: row.accountId,
    attempts: row.attempts,
  }
}

/** 用户页永远拿不到账号 / profile / attempts 等管理面字段。 */
function usageRowOf(row: UsageRowLike): {
  id: number
  reqId: string
  userId: number
  apiKeyId: string
  apiKeyName: string
  model: string
  upstreamModel: string | null
  protocol: string
  upstreamProtocol: string | null
  stream: boolean
  status: number
  errorCode: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  durationMs: number
  clientIp: string | null
  startedAt: string
  costMicros: string
} {
  return {
    id: row.id,
    reqId: row.reqId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName,
    model: row.model,
    upstreamModel: row.upstreamModel,
    protocol: row.protocol,
    upstreamProtocol: row.upstreamProtocol,
    stream: row.stream,
    status: row.status,
    errorCode: row.errorCode,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    clientIp: row.clientIp,
    startedAt: row.startedAt,
    costMicros: row.costMicros,
  }
}

type AdminUsageCsvRow = UsageRowLike & { readonly userName: string | null }

const USAGE_CSV_HEADER = [
  'time',
  'api_key',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'cost_micros',
  'status',
  'duration_ms',
  'client_ip',
] as const

/**
 * 管理员 CSV：列与用户侧一致，另加 `user` / `account`。
 * 带 UTF-8 BOM（Excel 直接识别中文），单元格按 CSV 规则转义并防公式注入。
 */
function adminUsageCsv(rows: readonly AdminUsageCsvRow[]): string {
  const header =
    'time,user,api_key,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,status,duration_ms,client_ip,account'
  const lines = rows.map((row) =>
    [
      row.startedAt,
      row.userName ?? '',
      row.apiKeyName,
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.totalTokens,
      row.costMicros,
      row.status,
      row.durationMs,
      row.clientIp ?? '',
      row.accountId,
    ]
      .map(csvField)
      .join(','),
  )
  return `﻿${header}\n${lines.length === 0 ? '' : `${lines.join('\n')}\n`}`
}

/** 用户侧 CSV：BOM + 表头 + 行；单元格按 CSV 规则转义并防公式注入。 */
function usageCsv(rows: readonly UsageRowLike[]): string {
  const lines = [USAGE_CSV_HEADER.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.startedAt,
        row.apiKeyName === '' ? row.apiKeyId : row.apiKeyName,
        row.model,
        String(row.inputTokens),
        String(row.outputTokens),
        String(row.cacheReadTokens),
        String(row.cacheWriteTokens),
        String(row.totalTokens),
        row.costMicros,
        String(row.status),
        String(row.durationMs),
        row.clientIp ?? '',
      ]
        .map(csvField)
        .join(','),
    )
  }
  return `﻿${lines.join('\r\n')}`
}

/** CSV 单元格：`= + - @` 开头加前导 `'` 防公式注入，再按 RFC 4180 转义。 */
function csvField(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`
  return text
}

/** `listAll()` 的形状兼容：数组或 `{ items }`；只保留 `enabled` 判定需要的信息。 */
function keyPortResult(value: unknown): { enabled: boolean }[] {
  const items = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.items)
      ? value.items
      : []
  return items.filter(isPlainObject).map((item) => ({ enabled: item.enabled !== false }))
}

function queryStringOf(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? undefined : value
}

function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw badRequest(`${name} 必须是正整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest(`${name} 必须是正整数`)
  return parsed
}
function catalogState(state: string): CatalogModuleView['state'] {
  switch (state) {
    case 'active':
      return 'active'
    case 'pending':
    case 'loading':
      return 'pending'
    case 'disabled':
      return 'disabled'
    case 'failed':
      return 'failed'
    default:
      return 'unloaded'
  }
}

function priorityState(state: string): GatewayHealthState {
  if (state === 'ready') return 'ok'
  if (state === 'dropped' || state === 'failed' || state === 'stopped') return 'down'
  return 'degraded'
}

// ───────────────────────────────── 兑换码响应归一化 ─────────────────────────────────

/** 金额一律写成十进制字符串（浏览器用 BigInt 解析），JSON 里不出现 bigint。 */
function redeemResultOf(result: RedeemResultLike): {
  readonly amountMinor: string
  readonly balanceMinor: string
  readonly batchName: string
} {
  return {
    amountMinor: result.amount.toString(),
    balanceMinor: result.balance.toString(),
    batchName: result.batchName,
  }
}

function redemptionOf(item: RedemptionLike): {
  readonly codeId: string
  readonly codeMask: string
  readonly amountMinor: string
  readonly batchName: string | null
  readonly redeemedAt: string | null
} {
  return {
    codeId: item.codeId,
    codeMask: item.codeMask,
    amountMinor: item.amountMicro.toString(),
    batchName: item.batchName,
    redeemedAt: item.redeemedAt,
  }
}

function redeemBatchOf(batch: RedeemBatchLike): Record<string, unknown> {
  return {
    id: batch.id,
    name: batch.name,
    kind: batch.kind,
    amountMinor: batch.amountMicro.toString(),
    total: batch.total,
    notes: batch.notes,
    createdBy: batch.createdBy,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
    codeCount: batch.codeCount,
    usedCount: batch.usedCount,
  }
}

function redeemCodeOf(code: RedeemCodeLike): Record<string, unknown> {
  return {
    id: code.id,
    batchId: code.batchId,
    batchName: code.batchName,
    codeMask: code.codeMask,
    kind: code.kind,
    amountMinor: code.amountMicro.toString(),
    status: code.status,
    createdAt: code.createdAt,
    expiresAt: code.expiresAt,
    reservedAt: code.reservedAt,
    reservedBy: code.reservedBy,
    redeemedAt: code.redeemedAt,
    redeemedBy: code.redeemedBy,
    disabledBy: code.disabledBy,
    disabledAt: code.disabledAt,
  }
}

function redeemStatsOf(stats: RedeemStatsLike): Record<string, unknown> {
  return {
    batches: stats.batches,
    codes: stats.codes,
    enabled: stats.enabled,
    disabled: stats.disabled,
    redeeming: stats.redeeming,
    used: stats.used,
    expired: stats.expired,
    redeemedAmountMicro: stats.redeemedAmountMicro.toString(),
  }
}

// ───────────────────────────────── 模型广场 ─────────────────────────────────

function modelCatalogOf(catalog: ModelCatalogLike): Record<string, unknown> {
  return {
    available: catalog.available.map(modelEntryOf),
    unavailable: catalog.unavailable.map((entry) => ({
      model: entry.model,
      reason: entry.reason,
      detail: entry.detail,
      accountCount: entry.accountCount,
      priced: entry.priced,
      price: entry.price === null ? null : modelPriceViewOf(entry.price),
    })),
    summary: {
      total: catalog.summary.total,
      availableCount: catalog.summary.availableCount,
      unavailableCount: catalog.summary.unavailableCount,
      pricedCount: catalog.summary.pricedCount,
      accountCount: catalog.summary.accountCount,
    },
  }
}

function modelEntryOf(entry: ModelEntryLike): Record<string, unknown> {
  return {
    model: entry.model,
    priced: entry.priced,
    price: entry.price === null ? null : modelPriceViewOf(entry.price),
    accountCount: entry.accountCount,
    healthyAccountCount: entry.healthyAccountCount,
    protocols: entry.protocols,
    upstreamModels: entry.upstreamModels,
    mapped: entry.mapped,
  }
}

function modelPriceViewOf(price: ModelPriceLike): Record<string, unknown> {
  return {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion,
    cacheWritePerMillion: price.cacheWritePerMillion,
    currency: price.currency,
    updatedAt: price.updatedAt,
  }
}

// ───────────────────────────────── 充值订单 ─────────────────────────────────

function topupOrderOf(order: TopupOrderLike): Record<string, unknown> {
  return {
    orderNo: order.orderNo,
    userId: order.userId,
    amountMicro: order.amountMicro.toString(),
    status: order.status,
    provider: order.provider,
    providerLabel: order.providerLabel,
    providerOrderId: order.providerOrderId,
    instructions: order.instructions,
    note: order.note,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    canceledAt: order.canceledAt,
  }
}

function topupOptionsOf(options: TopupOptionsLike): Record<string, unknown> {
  return {
    currency: options.currency,
    providerId: options.providerId,
    providerLabel: options.providerLabel,
    online: options.online,
    minAmountMicros: options.minAmountMicros.toString(),
    maxAmountMicros: options.maxAmountMicros.toString(),
    expiresMinutes: options.expiresMinutes,
    notice: options.notice,
  }
}

function topupStatsOf(stats: TopupStatsLike): Record<string, unknown> {
  return {
    todayPaidCount: stats.todayPaidCount,
    todayPaidMicros: stats.todayPaidMicros.toString(),
    totalPaidCount: stats.totalPaidCount,
    totalPaidMicros: stats.totalPaidMicros.toString(),
    pendingCount: stats.pendingCount,
    expiredCount: stats.expiredCount,
  }
}

// ───────────────────────────────── 内容审核 ─────────────────────────────────

function contentAuditRuleOf(rule: ContentAuditRuleLike): Record<string, unknown> {
  return {
    id: rule.id,
    pattern: rule.pattern,
    action: rule.action,
    category: rule.category ?? null,
    enabled: rule.enabled,
    note: rule.note ?? null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  }
}

/**
 * 审计元数据：只放「哪条规则、什么动作、是否启用」。
 *
 * **不放 `pattern`**：关键词是管理面的审核数据，审计表没必要复制一份（也少一处扩散面）。
 */
function contentAuditRuleMetadata(rule: ContentAuditRuleLike): Record<string, unknown> {
  return {
    ruleId: rule.id,
    action: rule.action,
    category: rule.category ?? null,
    enabled: rule.enabled,
  }
}

/** 状态：显式列白名单键，避免插件以后加字段时悄悄漏到 HTTP 面上。 */
function contentAuditStatusOf(status: ContentAuditStatusLike): Record<string, unknown> {
  return {
    enabled: status.enabled,
    pushIntervalMs: status.pushIntervalMs,
    ruleCount: status.ruleCount,
    revision: status.revision,
    generation: status.generation,
    ageMs: status.ageMs,
    ttlMs: status.ttlMs,
    stale: status.stale,
    goReady: status.goReady,
    lastPushAt: status.lastPushAt,
    lastError: status.lastError,
    pushes: status.pushes,
    heartbeats: status.heartbeats,
    failureStreak: status.failureStreak,
    goTtlMs: status.goTtlMs,
    heartbeatTooSlow: status.heartbeatTooSlow,
    hits: status.hits === null ? null : { ...status.hits, byRule: { ...status.hits.byRule } },
  }
}

function contentAuditActionOf(value: unknown): 'block' | 'log' {
  if (value === 'block' || value === 'log') return value
  throw badRequest('action 只能是 block / log')
}

function contentAuditEnabledOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  throw badRequest('enabled 必须是布尔值')
}

/** 新建时的可选文本：`undefined` / `null` / 空串都当作「没给」。 */
function contentAuditOptionalText(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw badRequest(`${key} 必须是字符串`)
  const text = value.trim()
  return text === '' ? undefined : text
}

/** 修改时的可清空文本：`null` 或空串表示清空。 */
function contentAuditClearableText(value: unknown, key: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw badRequest(`${key} 必须是字符串或 null`)
  const text = value.trim()
  return text === '' ? null : text
}

/** 新建规则：只做形状校验，长度 / 去重 / 上限交给插件（它的码才是稳定的）。 */
function contentAuditInputOf(body: Record<string, unknown>): ContentAuditRuleInputLike {
  const pattern = requiredString(body, 'pattern')
  const action = body.action === undefined ? undefined : contentAuditActionOf(body.action)
  const category = contentAuditOptionalText(body.category, 'category')
  const note = contentAuditOptionalText(body.note, 'note')
  const enabled = body.enabled === undefined ? undefined : contentAuditEnabledOf(body.enabled)
  return {
    pattern,
    ...(action === undefined ? {} : { action }),
    ...(category === undefined ? {} : { category }),
    ...(note === undefined ? {} : { note }),
    ...(enabled === undefined ? {} : { enabled }),
  }
}

/** 修改规则：`Object.hasOwn` 区分「没给」与「给了 null」。 */
function contentAuditPatchOf(body: Record<string, unknown>): ContentAuditRulePatchLike {
  const patch: {
    pattern?: string
    action?: 'block' | 'log'
    category?: string | null
    enabled?: boolean
    note?: string | null
  } = {}
  if (Object.hasOwn(body, 'pattern')) patch.pattern = requiredString(body, 'pattern')
  if (Object.hasOwn(body, 'action')) patch.action = contentAuditActionOf(body.action)
  if (Object.hasOwn(body, 'category')) patch.category = contentAuditClearableText(body.category, 'category')
  if (Object.hasOwn(body, 'note')) patch.note = contentAuditClearableText(body.note, 'note')
  if (Object.hasOwn(body, 'enabled')) patch.enabled = contentAuditEnabledOf(body.enabled)
  if (Object.keys(patch).length === 0) throw badRequest('没有可修改的字段')
  return patch
}

// ───────────────────────────────── 结算（只读） ─────────────────────────────────

function settleRecordOf(record: SettleRecordLike): Record<string, unknown> {
  return {
    reqId: record.reqId,
    userId: record.userId,
    accountId: record.accountId,
    model: record.model,
    day: record.day,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    costMicro: record.costMicro.toString(),
    overdrawn: record.overdrawn,
    balanceAfter: record.balanceAfter === null ? null : record.balanceAfter.toString(),
    status: record.status,
    note: record.note,
    attempts: record.attempts,
    startedAt: record.startedAt,
    claimedAt: record.claimedAt,
    settledAt: record.settledAt,
    updatedAt: record.updatedAt,
  }
}

function settleTotalsOf(totals: SettleTotalsLike): Record<string, unknown> {
  return {
    records: totals.records,
    settled: totals.settled,
    noPrice: totals.noPrice,
    noUser: totals.noUser,
    failed: totals.failed,
    review: totals.review,
    settling: totals.settling,
    overdrawn: totals.overdrawn,
    chargedMicros: totals.chargedMicros.toString(),
    todayChargedMicros: totals.todayChargedMicros.toString(),
  }
}

function settleDailyOf(point: SettleDailyLike): Record<string, unknown> {
  return {
    date: point.date,
    records: point.records,
    settled: point.settled,
    chargedMicros: point.chargedMicros.toString(),
  }
}

function settleModelOf(model: SettleModelLike): Record<string, unknown> {
  return {
    model: model.model,
    records: model.records,
    chargedMicros: model.chargedMicros.toString(),
  }
}

// ───────────────────────────────── 响应归一化 ─────────────────────────────────

function normalizeKeyList(value: unknown): ApiKeySummaryView[] {
  const items = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.items)
      ? value.items
      : null
  if (items === null) {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务返回了无法识别的列表')
  }
  return items.map(normalizeKeySummary)
}

function normalizeKeySummary(value: unknown): ApiKeySummaryView {
  const record = asRecord(value)
  if (record === null) {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务返回了无法识别的条目')
  }
  const id = typeof record.id === 'string' ? record.id : null
  if (id === null) throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 条目缺少 id')
  return {
    id,
    name: typeof record.name === 'string' ? record.name : '',
    trackingId: typeof record.trackingId === 'string' ? record.trackingId : '',
    secret: typeof record.secret === 'string' ? record.secret : null,
    maskedKey: typeof record.maskedKey === 'string' ? record.maskedKey : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : null,
    appManaged: record.appManaged === true,
    enabled: record.enabled !== false,
  }
}

/**
 * create / rotate 的真实形状是 `{ key: ApiKeyView, secret }`。这里展开成前端契约的
 * 扁平 `CreatedApiKey`；同时兼容旧实现直接返回 `{ ...summary, secret }`。
 */
function normalizeCreatedKey(value: unknown): ApiKeySummaryView & { secret: string } {
  const record = asRecord(value)
  if (record === null) {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务返回了无法识别的创建结果')
  }
  const summary = normalizeKeySummary(isPlainObject(record.key) ? record.key : record)
  const secret = record.secret
  if (typeof secret !== 'string' || secret === '') {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务没有返回一次性 secret')
  }
  return { ...summary, secret }
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}

/** 账号响应只挑前端契约里的字段；`credentialRef` / 令牌永远不会出现在响应里。 */
function accountOf(value: unknown): AccountViewLike {
  const record = asRecord(value)
  if (record === null || typeof record.id !== 'string') {
    throw new ApiError('API_RESPONSE_INVALID', 502, '账号管理服务返回了无法识别的账号')
  }
  return {
    id: record.id,
    provider: typeof record.provider === 'string' ? record.provider : 'custom',
    kind: typeof record.kind === 'string' ? record.kind : 'api_key',
    label: typeof record.label === 'string' ? record.label : '',
    enabled: record.enabled === true,
    status: typeof record.status === 'string' ? record.status : 'active',
    email: typeof record.email === 'string' ? record.email : null,
    subject: typeof record.subject === 'string' ? record.subject : null,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : null,
    protocol: typeof record.protocol === 'string' ? record.protocol : null,
    models: stringArrayOf(record.models),
    modelMap: stringMapOf(record.modelMap),
    priority: typeof record.priority === 'number' ? record.priority : 0,
    accessExpiresAt: typeof record.accessExpiresAt === 'string' ? record.accessExpiresAt : null,
    refreshDueAt: typeof record.refreshDueAt === 'string' ? record.refreshDueAt : null,
    lastRefreshAt: typeof record.lastRefreshAt === 'string' ? record.lastRefreshAt : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    failureCount: typeof record.failureCount === 'number' ? record.failureCount : 0,
    backoffUntil: typeof record.backoffUntil === 'string' ? record.backoffUntil : null,
    lastTestAt: typeof record.lastTestAt === 'string' ? record.lastTestAt : null,
    lastTestOk: typeof record.lastTestOk === 'boolean' ? record.lastTestOk : null,
    lastTestError: typeof record.lastTestError === 'string' ? record.lastTestError : null,
    lastTestLatencyMs: typeof record.lastTestLatencyMs === 'number' ? record.lastTestLatencyMs : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}

/** 响应侧的形状归一：非数组 / 含非字符串一律退回 null，不把脏数据透给前端。 */
function stringArrayOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    if (typeof item === 'string') items.push(item)
  }
  return items
}

function stringMapOf(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null
  const map: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') map[key] = item
  }
  return map
}

function normalizeBulkImport(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  const items = Array.isArray(value.items) ? value.items : []
  return {
    ...value,
    items: items.map((item) => {
      if (!isPlainObject(item)) return item
      return {
        ...item,
        account: item.account === null || item.account === undefined ? null : accountOf(item.account),
      }
    }),
  }
}
