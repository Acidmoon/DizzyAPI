/**
 * 控制台的 HTTP 面：**只做两件事** —— 发静态字节、给页面路由做回退。
 *
 * 它不渲染、不取数、不代理 `/api/*`：业务数据由 `api` 插件（7791）提供，
 * nginx 把 `/api/*` 直接反代到那边，本服务看不到这些请求。
 *
 * 路由判定顺序（改动前先读这一段，顺序是不变量）：
 *
 * 1. 方法只允许 `GET` / `HEAD`，其余 405。
 * 2. `Host` 必须是 `127.0.0.1:<port>` / `localhost:<port>`（挡 DNS rebinding，
 *    与 `web` / `api` 两个插件同一口径；另外可以在配置里加白名单）。
 * 3. 路径解码后做穿越检查：出现 `..` 段或跳出产物目录一律 400。
 * 4. 命中真实文件 → 按扩展名发 `Content-Type`，带缓存头。
 * 5. **静态资源（`/_next/**`、`/assets/**`、带扩展名的路径）找不到就是 404**，
 *    绝不回退成 `index.html`（回退会把「图片挂了」伪装成「页面正常」）。
 * 6. 其余路径按页面路由处理：`<dist>/<route>/index.html` 存在就发它；
 *    不存在则回退到 `<dist>/index.html`（SPA 兜底，客户端路由自己显示 404 页）。
 * 7. 回退用的 `index.html` 也不存在（产物没构建）→ 503 + 明确文案，不假装 404。
 *
 * HTML 一律过 `csp.ts`：每次响应一个新 nonce，内联 script 补 `nonce` 属性，
 * 响应头写对应的 `script-src`。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'

import { contentSecurityPolicy, injectScriptNonce, newNonce } from './csp.ts'
import { contentTypeOf, extensionOf, looksLikeFile } from './mime.ts'

/** 哪些路径算「静态资源」—— 它们找不到时必须 404，不许回退。 */
const ASSET_PREFIXES = ['/_next/', '/assets/'] as const

const HTML_CACHE = 'no-store'
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const DEFAULT_CACHE = 'no-store'

export interface StaticServerOptions {
  /** 静态产物根目录（`packages/dashboard/dist`）。 */
  readonly distDir: string
  /** 额外允许的 `Host` 头（生产反代若没改写 Host 时用）。 */
  readonly extraAllowedHosts?: readonly string[]
}

/** 产物根目录里一个已经解析好的响应。 */
interface Resolved {
  readonly path: string
  readonly cacheControl: string
  readonly found: boolean
}

export class StaticServer {
  private readonly distDir: string
  private readonly extraAllowedHosts: readonly string[]
  private server: Server | undefined
  private port = 0

  constructor(options: StaticServerOptions) {
    this.distDir = options.distDir
    this.extraAllowedHosts = options.extraAllowedHosts ?? []
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

  /** 绑定 `127.0.0.1`；端口冲突直接失败（不静默换端口）。 */
  start(port: number): Promise<void> {
    if (this.server !== undefined) throw new Error('控制台服务已经启动过了')
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
          reject(new Error('控制台服务没有拿到 TCP 地址'))
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

  // ───────────────────────────── 分发 ─────────────────────────────

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!this.hostAllowed(req)) {
        this.sendText(res, 421, `Host 不被接受：${String(req.headers.host)}`)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD')
        this.sendText(res, 405, '只支持 GET / HEAD')
        return
      }

      const url = new URL(req.url ?? '/', `http://127.0.0.1:${this.port}`)
      const segments = this.segmentsOf(url.pathname)
      if (segments === undefined) {
        this.sendText(res, 400, '路径不合法')
        return
      }

      const resolved = await this.resolveFile(url.pathname, segments)
      if (resolved.found) {
        await this.sendFile(req, res, resolved.path, resolved.cacheControl)
        return
      }

      if (this.isAssetPath(url.pathname)) {
        this.sendText(res, 404, '没有这个静态文件')
        return
      }

      // 页面路由：先找导出的预渲染页，再退到 SPA 兜底。
      const page = await this.firstFile(segments.length === 0 ? [] : [...segments, 'index.html'])
      if (page !== undefined) {
        await this.sendFile(req, res, page, HTML_CACHE)
        return
      }
      const shell = await this.firstFile(['index.html'])
      if (shell !== undefined) {
        await this.sendFile(req, res, shell, HTML_CACHE)
        return
      }

      this.sendText(res, 503, '静态产物不存在：先构建 packages/dashboard/dist')
    } catch (error) {
      this.sendText(res, 500, error instanceof Error ? error.message : '静态文件读取失败')
    }
  }

  /** 路径解码 + 穿越检查；不合法返回 `undefined`。 */
  private segmentsOf(pathname: string): string[] | undefined {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return undefined
    }
    if (decoded.includes('\0')) return undefined
    const segments = decoded.split('/').filter((part) => part !== '' && part !== '.')
    if (segments.some((part) => part === '..' || part.includes('\\'))) return undefined
    return segments
  }

  /** 是否「静态资源」：`/_next/**`、`/assets/**`、或带扩展名。 */
  private isAssetPath(pathname: string): boolean {
    if (ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return true
    return looksLikeFile(pathname)
  }

  private async resolveFile(pathname: string, segments: string[]): Promise<Resolved> {
    const missing = { path: '', cacheControl: DEFAULT_CACHE, found: false } as const
    if (segments.length === 0) {
      const shell = await this.firstFile(['index.html'])
      return shell === undefined ? missing : { path: shell, cacheControl: HTML_CACHE, found: true }
    }
    const candidate = await this.firstFile(segments)
    if (candidate === undefined) return missing
    return {
      path: candidate,
      cacheControl: this.cacheControlOf(pathname, candidate),
      found: true,
    }
  }

  /** 哈希资源一年 immutable，其余一律不缓存（HTML 由调用方指定）。 */
  private cacheControlOf(pathname: string, path: string): string {
    if (pathname.startsWith('/_next/static/')) return IMMUTABLE_CACHE
    if (extensionOf(pathname) === '.html') return HTML_CACHE
    if (path.endsWith(sep + 'index.html')) return HTML_CACHE
    return DEFAULT_CACHE
  }

  /** 依次尝试若干相对路径，返回第一个真实存在的文件绝对路径。 */
  private async firstFile(segments: readonly string[]): Promise<string | undefined> {
    const path = join(this.distDir, ...segments)
    if (!path.startsWith(this.distDir + sep) && path !== this.distDir) return undefined
    try {
      const info = await stat(path)
      if (!info.isFile()) return undefined
      return path
    } catch {
      return undefined
    }
  }

  private async sendFile(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    cacheControl: string,
  ): Promise<void> {
    const body = await readFile(path)
    const isHtml = path.toLowerCase().endsWith('.html')
    if (isHtml) {
      const nonce = newNonce()
      const html = injectScriptNonce(body.toString('utf8'), nonce)
      res.setHeader('Content-Security-Policy', contentSecurityPolicy(nonce))
      this.send(res, 200, 'text/html; charset=utf-8', Buffer.from(html, 'utf8'), cacheControl, req)
      return
    }
    this.send(res, 200, contentTypeOf(path), body, cacheControl, req)
  }

  private sendText(res: ServerResponse, status: number, message: string): void {
    this.send(res, status, 'text/plain; charset=utf-8', Buffer.from(message, 'utf8'), 'no-store')
  }

  private send(
    res: ServerResponse,
    status: number,
    contentType: string,
    body: Buffer,
    cacheControl: string,
    req?: IncomingMessage,
  ): void {
    if (res.headersSent) {
      res.end()
      return
    }
    res.writeHead(status, {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
    })
    if (req?.method === 'HEAD') {
      res.end()
      return
    }
    res.end(body)
  }

  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    const allowed = new Set([`127.0.0.1:${this.port}`, `localhost:${this.port}`])
    for (const extra of this.extraAllowedHosts) allowed.add(extra)
    return allowed.has(host)
  }
}
