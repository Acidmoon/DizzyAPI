/**
 * 页面插件自己的 HTTP 面。
 *
 * 只用 `node:http`，无第三方依赖。四类请求：
 *
 * - `GET <basePath>`：返回渲染好的 HTML 页面。
 * - `GET <basePath>/assets/usage.css` / `usage.js`：页面自己的样式与脚本。
 * - `GET <basePath>/api/usage/export`：按当前筛选条件导出 CSV。
 *
 * 访问控制比照 `admin` 面板与 `api` 入口：
 *
 * 1. `Host` 必须是 `127.0.0.1:<port>` 或 `localhost:<port>`（挡 DNS rebinding）。
 * 2. `Origin` 有值时必须等于自己的 origin。
 * 3. 不发任何 CORS 头；页面资源都同源。
 * 4. 会话只走 HttpOnly cookie。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { PAGE_CSS, CLIENT_JS } from './client.ts'

/** 服务端要实现的动作。业务都在插件里，这里只管协议。 */
export interface UsagePageHandlers {
  /** 渲染页面。`query` 是本次请求的查询参数。 */
  render(req: IncomingMessage, query: URLSearchParams): Promise<string>
  /** 导出 CSV。 */
  exportCsv(req: IncomingMessage, query: URLSearchParams): Promise<{ readonly filename: string; readonly content: string }>
  /** 会话 cookie 名。 */
  readonly sessionCookieName: string
}

export interface UsagePageServerOptions {
  readonly handlers: UsagePageHandlers
  /** 页面挂载路径，例如 `/console/usage`。 */
  readonly basePath: string
}

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
} as const

/** 页面插件的 HTTP 服务。 */
export class UsagePageServer {
  private readonly handlers: UsagePageHandlers
  private readonly basePath: string
  private server: Server | undefined
  private port = 0

  constructor(options: UsagePageServerOptions) {
    this.handlers = options.handlers
    this.basePath = options.basePath
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

  /** 绑 127.0.0.1；端口冲突直接失败。 */
  start(port: number): Promise<void> {
    if (this.server !== undefined) throw new Error('页面服务已经启动过了')
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
          reject(new Error('页面服务没有拿到 TCP 地址'))
          return
        }
        this.port = address.port
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
  }

  /** 停止监听并断开连接。幂等。 */
  async stop(): Promise<void> {
    const server = this.server
    if (server === undefined) return
    this.server = undefined
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      this.assertHost(req)
      this.assertOrigin(req)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        this.send(res, 405, 'text/plain; charset=utf-8', '只支持 GET / HEAD')
        return
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      const pathname = url.pathname

      if (pathname === `${this.basePath}/assets/usage.css`) {
        this.send(res, 200, 'text/css; charset=utf-8', PAGE_CSS)
        return
      }
      if (pathname === `${this.basePath}/assets/usage.js`) {
        this.send(res, 200, 'text/javascript; charset=utf-8', CLIENT_JS)
        return
      }
      if (pathname === `${this.basePath}/api/usage/export`) {
        const csv = await this.handlers.exportCsv(req, url.searchParams)
        res.setHeader('Content-Disposition', `attachment; filename="${csv.filename}"`)
        this.send(res, 200, 'text/csv; charset=utf-8', csv.content)
        return
      }
      if (pathname === this.basePath || pathname === `${this.basePath}/` || pathname === '/') {
        this.send(res, 200, 'text/html; charset=utf-8', await this.handlers.render(req, url.searchParams))
        return
      }

      this.send(res, 404, 'text/plain; charset=utf-8', '没有这个页面')
    } catch (error) {
      this.send(res, 500, 'text/plain; charset=utf-8', error instanceof Error ? error.message : '页面渲染失败')
    }
  }

  private assertHost(req: IncomingMessage): void {
    const host = req.headers.host
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`]
    if (typeof host !== 'string' || !allowed.includes(host)) {
      throw new Error(`Host 必须是 ${allowed.join(' 或 ')}`)
    }
  }

  private assertOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin
    if (origin === undefined) return
    const allowed = `http://127.0.0.1:${this.port}`
    if (origin !== allowed) throw new Error('Origin 必须与页面同源')
  }

  private send(res: ServerResponse, status: number, contentType: string, body: string): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, { 'Content-Type': contentType, ...SECURITY_HEADERS })
    res.end(body)
  }
}

/** 读取请求里的会话 cookie 值。 */
export function readSessionCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    if (part.slice(0, index).trim() !== name) continue
    return decodeURIComponent(part.slice(index + 1).trim())
  }
  return undefined
}
