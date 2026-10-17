/**
 * 面板的 HTTP 面。只用 `node:http`，没有任何第三方依赖——面板要能在最小安装里活。
 *
 * 访问控制的四道闸（见计划 §5）：
 *
 * 1. `Host` 必须是 `127.0.0.1:<实际端口>`。挡 DNS rebinding：攻击者能把域名解析到 127.0.0.1，
 *    但改不了浏览器发出的 `Host`。
 * 2. `/api/*` 要 cookie。cookie 只能由一次性 token 换取，token 在启动日志里只出现一次。
 * 3. `/api/*` 要 `X-Panel-Request: 1`。自定义头会让浏览器先发预检，而我们**不发任何 CORS 头**，
 *    所以第三方页面根本发不出这个请求；它同时挡住 `<form>` 这类不带头的跨站提交。
 * 4. `Origin` / `Sec-Fetch-Site` 收口。有 Origin 就必须等于自己的 origin。
 *
 * 第 3 条对 GET 也生效，所以前端读 SSE 不能用 `EventSource`（它发不了自定义头），
 * 必须 `fetch` + `ReadableStream`。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { AdminError, isAdminError, statusOfSettingsCode } from './errors.ts'
import type { AdminGraph } from './introspect.ts'

/** 服务侧要实现的动作。HTTP 层只管协议，业务都在这里。 */
export interface PanelHandlers {
  graph(): Promise<AdminGraph>
  overview(): Promise<unknown>
  restartPlugin(id: string): Promise<unknown>
  describeSettings(): Promise<unknown>
  updateSettings(ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<unknown>
  resetSettings(ns: string): Promise<unknown>
  /** 停监听、断 SSE、发 exit 事件。**不许**在这里 `process.exit`（见 `onExit`）。 */
  shutdown(): Promise<void>
}

export interface PanelOptions {
  readonly handlers: PanelHandlers
  readonly bodyLimitBytes: number
  readonly sseHeartbeatMs: number
  readonly maxSseClients: number
  /** 退出动作的落点。默认就是 `process.exit`；测试注入假的。 */
  readonly onExit?: (code: number) => void
}

const COOKIE_NAME = 'dizzyapi_admin'
const HTML_PATH = fileURLToPath(new URL('./ui/index.html', import.meta.url))

interface SseClient {
  readonly res: ServerResponse
}

export class PanelServer {
  private readonly handlers: PanelHandlers
  private readonly bodyLimitBytes: number
  private readonly sseHeartbeatMs: number
  private readonly maxSseClients: number
  private readonly onExit: (code: number) => void

  /** 一次性兑换用。换过就清空，之后同一串 token 一律无效。 */
  private bootstrapToken: string | null = randomBytes(24).toString('hex')
  /** cookie 的值。进程重启即失效，不落盘。 */
  private readonly sessionToken = randomBytes(24).toString('hex')

  private server: Server | undefined
  private port = 0
  private closing = false
  private html: string | undefined
  private readonly clients = new Set<SseClient>()
  private heartbeat: NodeJS.Timeout | undefined

  constructor(options: PanelOptions) {
    this.handlers = options.handlers
    this.bodyLimitBytes = options.bodyLimitBytes
    this.sseHeartbeatMs = options.sseHeartbeatMs
    this.maxSseClients = options.maxSseClients
    this.onExit = options.onExit ?? ((code) => process.exit(code))
  }

  get address(): { host: '127.0.0.1'; port: number } | undefined {
    return this.server === undefined ? undefined : { host: '127.0.0.1', port: this.port }
  }

  get origin(): string | undefined {
    return this.server === undefined ? undefined : `http://127.0.0.1:${this.port}`
  }

  get bootstrapUrl(): string | undefined {
    if (this.bootstrapToken === null) return undefined
    return `http://127.0.0.1:${this.port}/?t=${this.bootstrapToken}`
  }

  get listening(): boolean {
    return this.server !== undefined && !this.closing
  }

  get clientCount(): number {
    return this.clients.size
  }

  /** 绑 127.0.0.1。端口冲突直接失败（D7：不静默降级）。 */
  start(port: number): Promise<void> {
    if (this.server !== undefined) throw new AdminError('ADMIN_INTERNAL', '面板服务已经启动过了')
    const server = createServer((req, res) => {
      void this.dispatch(req, res)
    })
    this.server = server
    this.closing = false

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
          reject(new AdminError('ADMIN_INTERNAL', '面板没有拿到 TCP 地址'))
          return
        }
        this.port = address.port
        // 先把监听错误收进日志，别让 EADDRINUSE 变成未捕获异常。
        server.on('error', (error) => {
          if (!this.closing) console.error('[admin] 面板服务错误：', error)
        })
        this.startHeartbeat()
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  /** 关闭监听并断开所有连接。幂等。 */
  async stop(): Promise<void> {
    this.closing = true
    this.stopHeartbeat()
    for (const client of this.clients) client.res.end()
    this.clients.clear()

    const server = this.server
    this.server = undefined
    if (server === undefined) return

    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // keep-alive 与 SSE 会把 close 挂住。Node 18.2+ / 20+ 有 closeAllConnections。
      server.closeAllConnections?.()
    })
  }

  /** 往所有 SSE 客户端推一条事件。没有客户端时是空操作。 */
  broadcast(event: string, data: unknown): void {
    const frame = formatEvent(event, data)
    for (const client of this.clients) {
      try {
        client.res.write(frame)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  // ---------------------------------------------------------------- dispatch

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.assertHost(req)
      if (this.closing) throw new AdminError('ADMIN_SERVER_CLOSED', '面板正在关闭')

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (path === '/' || path === '/index.html') {
        this.assertMethod(method, ['GET'])
        return await this.handleIndex(req, res, url)
      }

      if (path === '/api/events') {
        this.assertMethod(method, ['GET'])
        await this.assertApiAccess(req)
        return this.handleEvents(req, res)
      }

      if (!path.startsWith('/api/')) throw new AdminError('ADMIN_ROUTE_NOT_FOUND', `没有这个路径：${path}`)
      await this.assertApiAccess(req)

      if (path === '/api/graph') {
        this.assertMethod(method, ['GET'])
        return sendJson(res, 200, await this.handlers.graph())
      }
      if (path === '/api/overview') {
        this.assertMethod(method, ['GET'])
        return sendJson(res, 200, await this.handlers.overview())
      }
      if (path === '/api/settings') {
        this.assertMethod(method, ['GET'])
        return sendJson(res, 200, await this.handlers.describeSettings())
      }
      if (path === '/api/settings/update') {
        this.assertMethod(method, ['POST'])
        const body = await this.readJson(req)
        const ns = readString(body, 'ns')
        const patch = body.patch
        if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new AdminError('ADMIN_BODY_INVALID', '`patch` 必须是对象')
        }
        const expected = body.expectedRevision
        if (expected !== undefined && typeof expected !== 'string') {
          throw new AdminError('ADMIN_BODY_INVALID', '`expectedRevision` 必须是字符串')
        }
        const result = await this.handlers.updateSettings(ns, patch as Record<string, unknown>, expected)
        return sendJson(res, 200, result)
      }
      if (path === '/api/settings/reset') {
        this.assertMethod(method, ['POST'])
        const body = await this.readJson(req)
        return sendJson(res, 200, await this.handlers.resetSettings(readString(body, 'ns')))
      }
      if (path === '/api/plugins/restart') {
        this.assertMethod(method, ['POST'])
        const body = await this.readJson(req)
        return sendJson(res, 200, await this.handlers.restartPlugin(readString(body, 'id')))
      }
      if (path === '/api/shutdown') {
        this.assertMethod(method, ['POST'])
        await this.readJson(req)
        return this.handleShutdown(req, res)
      }

      throw new AdminError('ADMIN_ROUTE_NOT_FOUND', `没有这个路径：${path}`)
    } catch (error) {
      sendError(res, error)
    }
  }

  private handleIndex(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> | void {
    const token = url.searchParams.get('t')
    if (token !== null) {
      // 已经拿到有效 cookie 的浏览器再点一次那条 URL 也应当进得去（比如刷新页面）。
      if (this.isAuthorized(req)) {
        redirect(res, '/')
        return
      }
      if (this.bootstrapToken === null || !safeEqual(token, this.bootstrapToken)) {
        throw new AdminError('ADMIN_BOOTSTRAP_TOKEN_INVALID', '启动令牌无效或已被使用')
      }
      this.bootstrapToken = null
      res.setHeader(
        'Set-Cookie',
        `${COOKIE_NAME}=${this.sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
      )
      redirect(res, '/')
      return
    }

    const html = this.html
    if (html !== undefined) {
      sendHtml(res, html)
      return
    }
    return readFile(HTML_PATH, 'utf8').then((text) => {
      this.html = text
      sendHtml(res, text)
    })
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse): void {
    if (this.clients.size >= this.maxSseClients) {
      throw new AdminError('ADMIN_TOO_MANY_SSE_CLIENTS', `SSE 连接已达上限（${this.maxSseClients}）`)
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      // 覆盖 SECURITY_HEADERS 里的 no-store：SSE 要的是一直不缓存，但也不能被变换。
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    res.write('retry: 3000\n\n')
    const client: SseClient = { res }
    this.clients.add(client)
    res.write(formatEvent('hello', { ok: true, at: new Date().toISOString() }))
    req.on('close', () => {
      this.clients.delete(client)
    })
  }

  private handleShutdown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 先把响应完整写出去，再动手关——否则浏览器看到的是连接重置，不是「已接受」。
    return new Promise<void>((resolve) => {
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
      res.end(JSON.stringify({ ok: true, message: '面板正在关闭' }), resolve)
    }).then(async () => {
      await this.handlers.shutdown()
      // 兜底：真有人挂住了事件循环，5 秒后强退。unref 让它不吊住进程。
      setTimeout(() => this.onExit(1), 5_000).unref()
      this.onExit(0)
    })
  }

  // ------------------------------------------------------------------- gates

  /**
   * 允许的 Host。`localhost` 与 `127.0.0.1` 都是回环名字，放进白名单不影响
   * 防 DNS rebinding——攻击者能把域名解析到 127.0.0.1，但改不了浏览器发出的 Host。
   * 允许两者纯粹是为了「在浏览器里手敲 localhost:7788 也能用」。
   */
  private get allowedHosts(): readonly string[] {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
  }

  private assertHost(req: IncomingMessage): void {
    const host = req.headers.host
    if (host === undefined || !this.allowedHosts.includes(host)) {
      throw new AdminError('ADMIN_HOST_INVALID', `Host 必须是 ${this.allowedHosts.join(' 或 ')}，收到 ${host ?? '（空）'}`)
    }
  }

  private async assertApiAccess(req: IncomingMessage): Promise<void> {
    if (!this.isAuthorized(req)) throw new AdminError('ADMIN_UNAUTHORIZED', '请用启动日志里的地址打开面板')

    const marker = req.headers['x-panel-request']
    if (marker !== '1') {
      throw new AdminError('ADMIN_REQUEST_HEADER_REQUIRED', '缺少 X-Panel-Request: 1')
    }

    const given = req.headers.origin
    const allowed = this.allowedHosts.map((host) => `http://${host}`)
    if (given !== undefined && !allowed.includes(given)) {
      throw new AdminError('ADMIN_ORIGIN_INVALID', `Origin 不被接受：${given}`)
    }

    const site = req.headers['sec-fetch-site']
    if (site === 'cross-site' || site === 'same-site') {
      throw new AdminError('ADMIN_ORIGIN_INVALID', `不接受 ${site} 请求`)
    }
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const cookie = readCookie(req.headers.cookie, COOKIE_NAME)
    return cookie !== undefined && safeEqual(cookie, this.sessionToken)
  }

  private assertMethod(method: string, allowed: readonly string[]): void {
    if (allowed.includes(method)) return
    throw new AdminError('ADMIN_METHOD_NOT_ALLOWED', `${method} 不被支持，只接受 ${allowed.join(' / ')}`)
  }

  private async readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const text = await readBody(req, this.bodyLimitBytes)
    if (text.trim() === '') return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new AdminError('ADMIN_BODY_INVALID', '请求体不是合法 JSON')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AdminError('ADMIN_BODY_INVALID', '请求体必须是 JSON 对象')
    }
    return parsed as Record<string, unknown>
  }

  // ------------------------------------------------------------------ timers

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const timer = setInterval(() => {
      for (const client of this.clients) {
        try {
          // 注释行：SSE 会忽略它，但 TCP 上的字节足以让反代与浏览器知道这条连接还活着。
          client.res.write(': ping\n\n')
        } catch {
          this.clients.delete(client)
        }
      }
    }, this.sseHeartbeatMs)
    timer.unref()
    this.heartbeat = timer
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
} as const

function formatEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // 单页应用不加载任何外部资源；把可能的注入面收到最小。
    'Content-Security-Policy':
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    ...SECURITY_HEADERS,
  })
  res.end(html)
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' })
  res.end()
}

function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const { status, code, message } = describeFailure(error)
  sendJson(res, status, { error: { code, message } })
}

function describeFailure(error: unknown): { status: number; code: string; message: string } {
  if (isAdminError(error)) return { status: error.status, code: error.code, message: error.message }
  if (error instanceof Error) {
    // 设置插件的错误码原样透传（`SETTINGS_*` 已经是那边对外的契约），只补状态码。
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.startsWith('SETTINGS_')) {
      return { status: statusOfSettingsCode(code), code, message: error.message }
    }
    if (code === 'EADDRINUSE') return { status: 503, code: 'ADMIN_INTERNAL', message: error.message }
  }
  return { status: 500, code: 'ADMIN_INTERNAL', message: error instanceof Error ? error.message : String(error) }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) throw new AdminError('ADMIN_BODY_TOO_LARGE', `请求体超过 ${limit} 字节`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function readString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value === '') {
    throw new AdminError('ADMIN_BODY_INVALID', `缺少字符串字段 \`${key}\``)
  }
  return value
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return undefined
}

/** 定长比较，长度不同直接判否（`timingSafeEqual` 长度不等会抛）。 */
function safeEqual(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
