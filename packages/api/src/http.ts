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
import { ApiError, badRequest, forbidden, isApiError, notFound, toApiError, unauthorized } from './errors.ts'
import type {
  AccountAdminPort,
  AccountPriorityPort,
  AccountViewLike,
  AdminUserView,
  ApiKeyPort,
  ApiKeySummaryView,
  ApiRuntime,
  CatalogModuleView,
  CatalogPort,
  FrontendPageLike,
  FrontendPort,
  GatewayComponentHealth,
  GatewayHealthState,
  GatewayHealthView,
  LoginResultLike,
  SessionInfoView,
  SessionRole,
  SessionUserView,
  SessionViewLike,
  SettingsPort,
  UserLike,
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

const TOPUP_OPTIONS = {
  currency: 'CNY',
  amountsCents: [1_000, 2_000, 5_000, 10_000, 30_000, 50_000],
  minCents: 100,
  maxCents: 1_000_000,
  methods: [
    { id: 'alipay', label: '支付宝', enabled: true, note: '支付模块尚未实现，本页只能预先查看选项。' },
    { id: 'wechat', label: '微信支付', enabled: true, note: '支付模块尚未实现，本页只能预先查看选项。' },
  ],
  notice: '支付模块尚未实现：这里只返回充值选项，创建订单会返回 501。前端不接触支付凭据。',
} as const

const USAGE_RANGE_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 }

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
    if (parts[0] === 'topup') {
      await this.routeTopup(req, res, parts)
      return
    }

    // 管理员面
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
    const range = url.searchParams.get('range') ?? '30d'
    const days = USAGE_RANGE_DAYS[range]
    if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)
    const apiKeyId = url.searchParams.get('apiKeyId')
    const user = await this.runtime.user.get(view.userId)
    if (user === undefined) throw unauthorized('账号已不存在，请重新登录')

    const now = this.runtime.now()
    const to = dateOf(now)
    const from = dateOf(new Date(now.getTime() - (days - 1) * 86_400_000))
    return {
      range,
      from,
      to,
      apiKeyId: apiKeyId === null || apiKeyId === '' ? null : apiKeyId,
      // 没有 usage-log：余额只按当前用户余额换算，历史消费不伪造。
      balances: {
        paidCents: centsOf(user.balance),
        grantedCents: 0,
        spentCents: 0,
      },
      totals: { costCents: 0, requests: 0, tokens: 0 },
      daily: [],
      models: [],
      generatedAt: now.toISOString(),
    }
  }

  private async routeTopup(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    await this.requireSession(req)
    if (parts.length === 2 && parts[1] === 'options') {
      if (!this.allowRead(req, res)) return
      this.sendJson(req, res, 200, TOPUP_OPTIONS)
      return
    }
    if (parts.length === 2 && parts[1] === 'orders') {
      if (!this.allowMethod(req, res, ['POST'])) return
      throw new ApiError('TOPUP_NOT_IMPLEMENTED', 501, '支付模块尚未实现，暂时不能创建充值订单')
    }
    throw notFound('没有这个充值接口')
  }

  // ───────────────────────────────── 管理员：用户 ─────────────────────────────────

  private async routeUsers(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    await this.requireAdmin(req)

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

        if (hasName) await this.runtime.user.rename(API_ACTOR, id, requiredString(body, 'name'))
        if (hasStatus) {
          const status = requiredString(body, 'status')
          if (status !== 'enabled' && status !== 'banned') throw badRequest('status 只能是 enabled / banned')
          await this.runtime.user.setStatus(API_ACTOR, id, status)
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
          await setRole.call(this.runtime.user, API_ACTOR, id, role)
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
          await setBalanceEnabled.call(this.runtime.user, API_ACTOR, id, enabled)
        }

        const user = await this.runtime.user.get(id)
        if (user === undefined) throw notFound('没有这个用户')
        this.sendJson(req, res, 200, adminUserOf(user))
        return
      }
      if (req.method === 'DELETE') {
        await this.runtime.user.remove(API_ACTOR, id)
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
      const balance = await this.runtime.user.adjustBalance(API_ACTOR, id, BigInt(deltaText), reason)
      this.sendJson(req, res, 200, { balanceMinor: balance.toString() })
      return
    }

    throw notFound('没有这个用户接口')
  }

  // ───────────────────────────────── 管理员：上游账号 ─────────────────────────────────

  private async routeAccounts(req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
    await this.requireAdmin(req)
    const accountAdmin = this.requireAccountAdmin()

    if (parts.length === 1) {
      if (req.method === 'POST') {
        const create = accountAdmin.create
        if (typeof create !== 'function') {
          throw new ApiError('API_ACCOUNT_CREATE_UNAVAILABLE', 503, '账号管理服务不支持新建账号')
        }
        const body = await this.jsonBody(req)
        assertOnlyKeys(body, ['provider', 'kind', 'label', 'email', 'subject', 'enabled', 'credential'])
        const provider = requiredString(body, 'provider')
        const kind = requiredString(body, 'kind')
        const label = requiredString(body, 'label')
        const email = optionalString(body, 'email')
        const subject = optionalString(body, 'subject')
        const enabled = body.enabled === undefined ? undefined : requiredBoolean(body, 'enabled')
        const credential = accountCredentialOf(body.credential)
        const input = {
          provider,
          kind,
          label,
          ...(email === undefined ? {} : { email }),
          ...(subject === undefined ? {} : { subject }),
          ...(enabled === undefined ? {} : { enabled }),
          ...(credential === undefined ? {} : { credential }),
        }
        this.sendJson(req, res, 200, accountOf(await create.call(accountAdmin, API_ACTOR, input)))
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
      const bulk = accountAdmin.importAccounts
      if (typeof bulk !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持批量导入')
      }
      const body = await this.jsonBody(req)
      this.sendJson(req, res, 200, normalizeBulkImport(await bulk.call(accountAdmin, API_ACTOR, body)))
      return
    }

    if (parts.length === 3 && parts[1] === 'import' && parts[2] === 'preview') {
      if (!this.allowMethod(req, res, ['POST'])) return
      const preview = accountAdmin.previewImport
      if (typeof preview !== 'function') {
        throw new ApiError('API_ACCOUNT_IMPORT_UNAVAILABLE', 503, '账号管理服务不支持导入预检')
      }
      const body = await this.jsonBody(req)
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
        assertOnlyKeys(body, ['label', 'email', 'subject', 'enabled'])
        const hasMeta = Object.hasOwn(body, 'label') || Object.hasOwn(body, 'email') || Object.hasOwn(body, 'subject')
        const hasEnabled = Object.hasOwn(body, 'enabled')
        if (!hasMeta && !hasEnabled) throw badRequest('没有可修改的字段')

        if (hasMeta) {
          const patch: { label?: string; email?: string | null; subject?: string | null } = {}
          if (Object.hasOwn(body, 'label')) patch.label = requiredString(body, 'label')
          if (Object.hasOwn(body, 'email')) patch.email = nullableString(body, 'email')
          if (Object.hasOwn(body, 'subject')) patch.subject = nullableString(body, 'subject')
          await accountAdmin.update(API_ACTOR, id, patch)
        }
        if (hasEnabled) {
          const enabled = requiredBoolean(body, 'enabled')
          if (enabled) await accountAdmin.enable(API_ACTOR, id)
          else await accountAdmin.disable(API_ACTOR, id)
        }
        this.sendJson(req, res, 200, accountOf(await accountAdmin.get(id)))
        return
      }
      if (req.method === 'DELETE') {
        await accountAdmin.remove(API_ACTOR, id)
        this.sendJson(req, res, 200, { removed: true })
        return
      }
      this.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
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
        accountOf(await importCredentials.call(accountAdmin, API_ACTOR, id, input)),
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
    await this.requireAdmin(req)

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
        this.sendJson(
          req,
          res,
          200,
          await settings.update(API_ACTOR, ns, body.patch, expectedRevision),
        )
        return
      }
      if (req.method === 'DELETE') {
        const settings = this.requireSettings()
        this.sendJson(req, res, 200, await settings.reset(API_ACTOR, ns))
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
      components.push({ name: 'frontend', state: 'degraded', detail: '服务不在运行' })
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

  private requireSettings(): SettingsPort {
    const settings = this.runtime.settings()
    if (settings === undefined) {
      throw new ApiError('API_SETTINGS_UNAVAILABLE', 503, '设置插件不在运行')
    }
    return settings
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
    accessExpiresAt: typeof record.accessExpiresAt === 'string' ? record.accessExpiresAt : null,
    refreshDueAt: typeof record.refreshDueAt === 'string' ? record.refreshDueAt : null,
    lastRefreshAt: typeof record.lastRefreshAt === 'string' ? record.lastRefreshAt : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    failureCount: typeof record.failureCount === 'number' ? record.failureCount : 0,
    backoffUntil: typeof record.backoffUntil === 'string' ? record.backoffUntil : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
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
