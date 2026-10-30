/**
 * 服务端渲染的产品前端（cordis 服务名 `web`）。
 *
 * 路由 → 页面模块（`pages/*.ts`，一页一文件）→ 页面用 `pageTemplate` 渲染。
 * 所有数据走进程内服务，不经 JSON HTTP；写操作是表单 POST + 303（PRG）。
 */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Service, type Context } from 'cordis'
import { THEME_CSS_PATH, VENDOR_ASSET_PREFIX, type PageTemplateService } from '@dizzyapi/plugin-page-template'
import { APP_CSS_BODY, APP_JS_BODY } from './asset-version.ts'
import { validateWebConfig, type ResolvedWebConfig, type WebConfig } from './config.ts'
import { apiDocsResource } from './content/api_docs.ts'
import { assertSameOrigin, describeError, readForm, wantsNoRedirect, WebError } from './forms.ts'
import { fragmentResponse } from './hx.ts'
import { readPreferences, themeCssFrom } from './preferences.ts'
import { clearSessionCookie, isSecureRequest, placeholderSession, readCookie, sessionCookie } from './session.ts'
import { documentAssets, readNotice, type ActionContext, type PageContext, type PageModule } from './layout.ts'
import type {
  AccountAdminLike,
  ApiKeyLike,
  AuditLike,
  AuthLike,
  BillingLike,
  CatalogLike,
  ContentAuditLike,
  FontLike,
  ModelHubLike,
  ObservabilityLike,
  PricingLike,
  RedeemLike,
  SessionView,
  SettingsLike,
  TopupLike,
  UsageLike,
  UserLike,
  WebRuntime,
} from './runtime.ts'
import { PAGES } from './pages/index.ts'
import { usageExportResource, USAGE_EXPORT_PATH } from './usage-export.ts'

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  'X-Frame-Options': 'DENY',
}

/**
 * **内容寻址**资源的缓存语义：一年、不重新验证。
 *
 * 成立的前提是 **URL 随内容变**（`?v=<sha256 前 8 位>`）。全站符合这一条的只有四类：
 * `/assets/app.css`（哈希吃 `APP_CSS_BODY + fontCss`）、`/assets/app.js`、
 * `/assets/vendor/*`、`/assets/fonts/*`。没有版本串的路径**不许**用这个值——
 * 那等于「改了内容、回访浏览器一年不变」。
 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'

/** 页面 HTML 与会话相关正文：必须每次回源（内容按会话变，且可能带一次性信息）。 */
const NO_STORE = 'no-store'

/** 一次性 secret：只给创建后的第一次渲染。 */
interface SecretEntry {
  readonly value: string
  readonly expiresAt: number
}

export class WebService extends Service {
  static inject = ['pageTemplate']
  static catalog = { capabilities: ['web'], events: [], bridge: [] } as const

  private readonly config: ResolvedWebConfig
  private readonly template: PageTemplateService
  private readonly secrets = new Map<string, SecretEntry>()
  private server: Server | undefined
  private port = 0
  private ready = false

  constructor(ctx: Context, config: WebConfig = {}) {
    super(ctx, 'web')
    const resolved = validateWebConfig(config)
    if (Array.isArray(resolved)) throw new Error(`web 配置非法：${resolved.join('；')}`)
    this.config = resolved as ResolvedWebConfig
    this.template = ctx.pageTemplate

    if (!this.config.enabled) return
    ctx.effect(() => {
      void this.start().catch((error) => {
        this.ctx.logger('web').error(`web 启动失败：${error instanceof Error ? error.message : String(error)}`)
      })
      return () => this.stop()
    }, 'web.http')
  }

  get address(): { readonly host: '127.0.0.1'; readonly port: number } | undefined {
    return this.ready ? { host: '127.0.0.1', port: this.port } : undefined
  }

  /** 测试与优雅关闭用；幂等。 */
  async close(): Promise<void> {
    await this.stop()
  }

  private async start(): Promise<void> {
    if (this.server !== undefined) return
    const server = createServer((req, res) => {
      void this.dispatch(req, res)
    })
    this.server = server
    await new Promise<void>((resolve, reject) => {
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
          reject(new Error('没有拿到 TCP 地址'))
          return
        }
        this.port = address.port
        this.ready = true
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.config.port, '127.0.0.1')
    })
    this.ctx.logger('web').info(`web 页面入口已启动：http://127.0.0.1:${this.port}`)
  }

  private async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    this.ready = false
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private runtime(): WebRuntime {
    const get = <T>(name: string): T | undefined => this.ctx.get(name, false) as T | undefined
    return {
      user: get<UserLike>('user'),
      auth: get<AuthLike>('auth'),
      apiKey: get<ApiKeyLike>('apiKey'),
      usage: get<UsageLike>('usage'),
      pricing: get<PricingLike>('pricing'),
      modelhub: get<ModelHubLike>('modelhub'),
      settings: get<SettingsLike>('settings'),
      catalog: get<CatalogLike>('catalog'),
      accountAdmin: get<AccountAdminLike>('accountAdmin'),
      redeem: get<RedeemLike>('redeem'),
      billing: get<BillingLike>('billing'),
      topup: get<TopupLike>('topup'),
      audit: get<AuditLike>('audit'),
      observability: get<ObservabilityLike>('observability'),
      contentAudit: get<ContentAuditLike>('contentAudit'),
      fontSmiley: get<FontLike>('fontSmiley'),
      gateFeed: get<import('./gate-types.ts').GateFeedLike>('gateFeed'),
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.assertHost(req)
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
        this.send(res, 405, 'text/plain; charset=utf-8', '只支持 GET / POST')
        return
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      const path = url.pathname

      if (path === '/assets/app.css') {
        const font = this.runtime().fontSmiley
        const fontCss = font === undefined ? '' : font.css()
        // **发 `immutable` 是安全的**：`appCssHref(fontCss)` 的哈希吃的是
        // `APP_CSS_BODY + fontCss`——**含运行时追加的字体块**，与这里发出去的正文
        // 逐字节对应（`web.test.ts` 有一条端到端复算用例钉着）。所以「内容寻址 + URL
        // 带哈希 + immutable」三件事同时成立：改样式或改字体 scope，URL 就变。
        this.send(res, 200, 'text/css; charset=utf-8', `${APP_CSS_BODY}${fontCss}`, IMMUTABLE_CACHE)
        return
      }
      if (path === THEME_CSS_PATH) {
        // 用户偏好表：**按用户生成**，所以缓存语义是 `private, no-store`。
        // 地址照样带内容哈希（`themeCssHref`），同一份偏好稳定、改档位立刻变。
        const css = await this.themeCssOf(await this.sessionOf(req))
        if (!res.headersSent) {
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/css; charset=utf-8',
            'Cache-Control': 'private, no-store',
          })
          res.end(css)
        }
        return
      }
      if (path.startsWith(VENDOR_ASSET_PREFIX)) {
        // 白名单查表：名字不在表里就是 404，不做路径拼接，天然没有穿越问题。
        const name = path.slice(VENDOR_ASSET_PREFIX.length)
        const file = this.template.vendorFile(name)
        if (file !== undefined) {
          res.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': file.contentType,
            // 第三方库按版本 vendor，内容不会变。
            'Cache-Control': 'public, max-age=31536000, immutable',
          })
          res.end(file.body)
          return
        }
      }
      if (path.startsWith('/assets/fonts/')) {
        const font = this.runtime().fontSmiley
        if (font !== undefined) {
          const file = font.file()
          if (path === `/assets/fonts/${file.name}`) {
            // **只有带对 `?v=` 的请求才发 immutable**：字体 URL 的版本串由
            // `font-smiley` 自己算（`css()` 里拼 `?v=<字体字节 sha256 前 8 位>`）。
            // 不带版本串的裸路径不能发长缓存——路径不随内容变，改了字体字节回访
            // 浏览器一年内还是旧字体。裸路径照样回字节（有人手敲它也不该 404），
            // 只是明确了「不可缓存」。
            const versioned = url.searchParams.get('v') === font.version()
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'Content-Type': file.contentType,
              'Cache-Control': versioned ? IMMUTABLE_CACHE : NO_STORE,
            })
            res.end(file.body)
            return
          }
        }
      }
      if (path === '/assets/app.js') {
        // 正文是常量 `APP_JS_BODY`，`?v=` 就是它的 sha256 前 8 位 → immutable 成立。
        this.send(res, 200, 'text/javascript; charset=utf-8', APP_JS_BODY, IMMUTABLE_CACHE)
        return
      }
      if (path === '/favicon.ico') {
        res.writeHead(204, SECURITY_HEADERS)
        res.end()
        return
      }
      // 机器友好副本：`/llms.txt` 与 `/console/api-docs.md`（agent 直接抓）。
      // 判定逻辑在 `content/api_docs.ts`，这里只负责发字节。
      // **必须由 web 发**：生产 nginx 只把 `/api/*` 反代 api 的 7791，其余全打 web 的 7792。
      // **不要求登录**：这两条就是给 agent 抓的（owner 明确要「方便投喂 agent」），
      // 内容里没有秘密；页面本体 `/console/api-docs` 仍然要登录。
      const docResource = apiDocsResource(path, url.searchParams.get('base'))
      if (docResource !== null) {
        this.send(res, docResource.status, docResource.contentType, docResource.body)
        return
      }
      if (path === '/') {
        this.redirect(res, '/console/usage')
        return
      }
      if (path === '/logout') {
        const token = readCookie(req, this.config.sessionCookieName)
        if (token !== undefined) await this.runtime().auth?.logout(token).catch(() => undefined)
        res.writeHead(303, {
          ...SECURITY_HEADERS,
          Location: '/login',
          'Set-Cookie': clearSessionCookie(this.config.sessionCookieName, isSecureRequest(req)),
        })
        res.end()
        return
      }

      // 用量 CSV 导出：`web` 自己发 `text/csv`（理由见 `usage-export.ts` 顶部）。
      // 放在页面查找之前（它不是页面，走不到 `PAGES`）；**先判路径再取会话**——
      // 否则每个普通页面请求都要多跑一次 `sessionOf`（一次会话校验的查库）。
      if (path === USAGE_EXPORT_PATH) {
        const session = (await this.sessionOf(req))?.session ?? null
        const resource = usageExportResource(url.searchParams, session, this.runtime().usage)
        res.writeHead(resource.status, { ...SECURITY_HEADERS, ...resource.headers })
        res.end(resource.body)
        return
      }
      const page = PAGES.find((item) => item.path === path)
      if (page === undefined) {
        this.send(res, 404, 'text/html; charset=utf-8', this.renderNotFound())
        return
      }

      const auth = this.runtime().auth
      const session = page.auth ? await this.sessionOf(req) : null
      if (page.auth && session === null) {
        this.redirect(res, '/login?err=' + encodeURIComponent('请先登录'))
        return
      }
      if (page.admin === true && session !== null && session.session.user.role !== 'admin') {
        this.send(res, 403, 'text/plain; charset=utf-8', '需要管理员权限')
        return
      }

      if (req.method === 'POST') {
        await this.handleAction(req, res, page, url, session, auth)
        return
      }

      const context = await this.contextFor(page, url, session)
      const html = await page.render(context)
      // ── htmx 局部刷新（第 4 批）────────────────────────────────────────
      // 片段是**整页渲染结果里 `<main>` 那一截**切出来的（`fragmentResponse`），
      // 所以它与整页逐字相同——不存在「两个函数各拼一遍」的漂移面。
      // 顺序纪律：Host → 会话 → 鉴权 → **最后**才看 `HX-Request`（上面的 302 / 403
      // 都在这之前返回，未登录的 HX 请求照样 302）。
      const fragment = fragmentResponse(req, html)
      if (fragment !== undefined) {
        this.send(res, 200, 'text/html; charset=utf-8', fragment, NO_STORE)
        return
      }
      this.send(res, 200, 'text/html; charset=utf-8', html, NO_STORE)
    } catch (error) {
      this.fail(req, res, error)
    }
  }

  private async handleAction(
    req: IncomingMessage,
    res: ServerResponse,
    page: PageModule,
    url: URL,
    session: { session: SessionView; token: string } | null,
    auth: AuthLike | undefined,
  ): Promise<void> {
    assertSameOrigin(req)
    const action = url.searchParams.get('action')
    const handler = action === null ? undefined : page.actions?.[action]
    if (handler === undefined) {
      this.send(res, 400, 'text/plain; charset=utf-8', '没有这个操作')
      return
    }
    const form = await readForm(req)
    const cookies: string[] = []
    const context: ActionContext = {
      ...await this.contextFor(page, url, session),
      form,
      cookieName: this.config.sessionCookieName,
      secure: isSecureRequest(req),
      token: session?.token ?? '',
      setCookie: (cookie) => cookies.push(cookie),
      stashSecret: (value) => this.stashSecret(value),
    }
    try {
      const target = await handler(context)
      // `fetch` 提交的动作（目前只有侧栏拖动排序）：回 204，别让 fetch 跟着 303
      // 把整页 HTML 再拉一遍——它只要知道成没成。
      if (wantsNoRedirect(req)) {
        res.writeHead(204, { ...SECURITY_HEADERS, ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }) })
        res.end()
        return
      }
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        Location: target,
        ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }),
      })
      res.end()
    } catch (error) {
      const message = describeError(error)
      this.ctx.logger('web').warn(`web 动作失败：${message}`)
      if (wantsNoRedirect(req)) {
        this.send(res, 400, 'text/plain; charset=utf-8', message, NO_STORE)
        return
      }
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        Location: `${page.path}?err=${encodeURIComponent(message)}`,
        ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }),
      })
      res.end()
    }
  }

  private async contextFor(
    page: PageModule,
    url: URL,
    session: { session: SessionView; token: string } | null,
  ): Promise<PageContext> {
    const user = session?.session ?? placeholderSession()
    const preferences = await readPreferences(this.runtime().user, session)
    return {
      path: page.path,
      title: page.title,
      query: url.searchParams,
      user,
      t: this.template,
      services: this.runtime(),
      notice: readNotice(url.searchParams),
      themeCss: themeCssFrom(preferences),
      navOrder: preferences.navOrder,
      takeSecret: () => this.takeSecret(url.searchParams.get('new')),
    }
  }

  /** `/assets/theme.css` 的正文（按当前用户）。 */
  private async themeCssOf(session: { session: SessionView; token: string } | null): Promise<string> {
    return themeCssFrom(await readPreferences(this.runtime().user, session))
  }

  private async sessionOf(req: IncomingMessage): Promise<{ session: SessionView; token: string } | null> {
    const token = readCookie(req, this.config.sessionCookieName)
    if (token === undefined) return null
    const auth = this.runtime().auth
    if (auth === undefined) return null
    try {
      return { session: await auth.verifySession(token), token }
    } catch {
      return null
    }
  }

  private stashSecret(value: string): string {
    this.pruneSecrets()
    const id = randomUUID()
    this.secrets.set(id, { value, expiresAt: Date.now() + 5 * 60_000 })
    return id
  }

  private takeSecret(id: string | null): string | undefined {
    if (id === null) return undefined
    this.pruneSecrets()
    const entry = this.secrets.get(id)
    if (entry === undefined) return undefined
    this.secrets.delete(id)
    return entry.value
  }

  private pruneSecrets(): void {
    const now = Date.now()
    for (const [id, entry] of this.secrets) {
      if (entry.expiresAt <= now) this.secrets.delete(id)
    }
  }

  private assertHost(req: IncomingMessage): void {
    const host = req.headers.host
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    if (typeof host !== 'string' || !allowed.includes(host)) {
      throw new WebError('WEB_HOST', `Host 必须是 ${allowed.join(' 或 ')}`)
    }
  }

  private redirect(res: ServerResponse, location: string): void {
    res.writeHead(302, { ...SECURITY_HEADERS, Location: location })
    res.end()
  }

  /**
   * 发一段文本。
   *
   * @param cacheControl `Cache-Control` 的值。**内容寻址的资源**（URL 带内容哈希）传
   *        `IMMUTABLE_CACHE`；其余（页面 HTML、动作错误）一律 `NO_STORE`——它们要么按会话
   *        变，要么带一次性信息，缓存下来就是串号。
   */
  private send(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    cacheControl?: string,
  ): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      ...(cacheControl === undefined ? {} : { 'Cache-Control': cacheControl }),
    })
    res.end(body)
  }

  private fail(req: IncomingMessage, res: ServerResponse, error: unknown): void {
    const message = error instanceof WebError ? error.message : '页面渲染失败'
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    this.ctx.logger('web').warn(`web 请求失败：${message}\n${detail}`)
    if (req.method === 'POST') {
      // POST 的失败已经由 handleAction 处理；这里兜底成纯文本。
      if (!res.headersSent) this.send(res, 500, 'text/plain; charset=utf-8', message)
      return
    }
    this.send(res, 500, 'text/html; charset=utf-8', this.renderNotFound(message))
  }

  private renderNotFound(message = '没有这个页面'): string {
    return this.template.renderDocument({
      title: '404 · DizzyAPI',
      assets: documentAssets(this.runtime().fontSmiley?.css() ?? ''),
      body: `<div class="auth-wrap"><div class="auth-card"><h1 class="auth-title">404</h1><p class="auth-sub">${this.template.escapeText(message)}</p><a class="btn" href="/console/usage">返回控制台</a></div></div>`,
    })
  }
}

