/**
 * 服务端渲染的产品前端（cordis 服务名 `web`）。
 *
 * 路由 → 页面模块（`pages/*.ts`，一页一文件）→ 页面用 `pageTemplate` 渲染。
 * 所有数据走进程内服务，不经 JSON HTTP；写操作是表单 POST + 303（PRG）。
 */
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Service, type Context } from 'cordis'
import { renderThemeCss, THEME_CSS_PATH, VENDOR_ASSET_PREFIX, type PageTemplateService } from '@dizzyapi/plugin-page-template'
import { APP_CSS_BODY, APP_JS_BODY } from './asset-version.ts'
import { validateWebConfig, type ResolvedWebConfig, type WebConfig } from './config.ts'
import { apiDocsResource } from './content/api_docs.ts'
import { assertSameOrigin, readForm, WebError } from './forms.ts'
import { clearSessionCookie, isSecureRequest, readCookie, sessionCookie } from './session.ts'
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

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
  'X-Frame-Options': 'DENY',
}

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
        // 正文由 `asset-version.ts` 装配：那份正文的哈希就是页面里 `<link>` 的 `?v=`
        // （逐字节同源的唯一办法——两边各拼一次迟早会漂）。
        // 字体 CSS 要运行时才有（font-smiley 可能没装载），所以不进哈希；它自己的
        // URL 版本问题见 AGENTS.md 的「静态资源缓存」。
        this.send(res, 200, 'text/css; charset=utf-8', `${APP_CSS_BODY}${fontCss}`, true)
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
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'Content-Type': file.contentType,
              'Cache-Control': 'public, max-age=31536000, immutable',
            })
            res.end(file.body)
            return
          }
        }
      }
      if (path === '/assets/app.js') {
        this.send(res, 200, 'text/javascript; charset=utf-8', APP_JS_BODY, true)
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
      this.send(res, 200, 'text/html; charset=utf-8', html, true)
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
      res.writeHead(303, {
        ...SECURITY_HEADERS,
        Location: target,
        ...(cookies.length === 0 ? {} : { 'Set-Cookie': cookies }),
      })
      res.end()
    } catch (error) {
      const message = describeError(error)
      this.ctx.logger('web').warn(`web 动作失败：${message}`)
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
    return {
      path: page.path,
      title: page.title,
      query: url.searchParams,
      user,
      t: this.template,
      services: this.runtime(),
      notice: readNotice(url.searchParams),
      themeCss: await this.themeCssOf(session),
      takeSecret: () => this.takeSecret(url.searchParams.get('new')),
    }
  }

  /**
   * 当前会话用户该用的界面偏好 CSS。
   *
   * 未登录 / 没有 `user` 服务 / 从来不设过偏好 → **空串**，页面就不引用主题表
   * （站默认值本来就是「标准字号 + 标准字距」，引一张空表只是多一个请求）。
   *
   * 读失败也只回落空串：字号不是页面能不能打开的前提，绝不因此 500。
   */
  private async themeCssOf(session: { session: SessionView; token: string } | null): Promise<string> {
    const userId = session?.session.user.id
    if (userId === undefined) return ''
    const user = this.runtime().user
    if (user === undefined) return ''
    try {
      const preferences = await user.getUiPreferences(userId)
      // 站默认值不生成表：与不加载主题完全等价，少一个请求。
      if (preferences.fontScale === 1 && preferences.letterSpacing === 'normal') return ''
      return renderThemeCss(preferences)
    } catch {
      return ''
    }
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

  private send(res: ServerResponse, status: number, contentType: string, body: string, noStore = false): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
      ...(noStore ? { 'Cache-Control': 'no-store' } : {}),
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

/** 业务错误带稳定 code 时显示其中文消息；其余统一兜底，不泄露内部细节。 */
function describeError(error: unknown): string {
  if (error instanceof WebError) return error.message
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (
      typeof code === 'string' &&
      /^[A-Z][A-Z0-9_]+$/.test(code) &&
      error.message.length > 0 &&
      error.message.length <= 160 &&
      !error.message.includes('\n')
    ) {
      return error.message
    }
  }
  return '操作失败，请稍后再试'
}

/** 未登录时占位：auth=false 的页面不解引用用户字段。 */function placeholderSession(): SessionView {
  return {
    sessionId: '',
    userId: 0,
    user: {
      id: 0,
      name: '',
      status: 'enabled',
      role: 'user',
      balance: 0n,
      balanceEnabled: false,
      avatar: null,
      createdAt: '',
      updatedAt: '',
    },
    expiresAt: '',
  }
}
