/**
 * **仅开发用的**前端预览服务器。
 *
 * 这不是产品运行时的一部分（D13）：生产由 Go httpapi 或反向代理直接发静态字节，
 * cordis 插件不监听端口。这里起一个只绑 127.0.0.1 的最小服务器，方便在没有 Go 的
 * 情况下看 SPA。它：
 *
 * - 强制 `mode: 'mock'`，所有数据来自浏览器内的 mock 适配器；
 * - 只服务 `assets/` 源码与 `/console`、`/admin` 的 history fallback；
 * - 不提供任何 `/api/*` 路由，不读凭据、不碰数据库；
 * - 仍然做 Host 校验与路径越界检查，避免变成本机任意文件服务器。
 */
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { normalizeAssetPath, contentTypeOf } from './assets.ts'
import { BUNDLED_ASSETS_DIR, configSource } from './bundle.ts'
import type { ResolvedFrontendConfig } from './config.ts'

export interface PreviewServerOptions {
  /** 默认 7790；`0` = 系统分配（测试用）。 */
  readonly port?: number
}

export interface PreviewServer {
  readonly port: number
  readonly url: string
  close(): Promise<void>
}

const PREVIEW_CONFIG: ResolvedFrontendConfig = {
  dataPath: '',
  publicBase: '/assets/frontend',
  apiBase: '/api',
  basePath: '',
  mode: 'mock',
  mockLatencyMs: 50,
  keepVersions: 2,
  autoInstall: true,
}

const ASSET_PREFIX = '/assets/frontend/'
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
} as const

export async function startPreviewServer(options: PreviewServerOptions = {}): Promise<PreviewServer> {
  const state = { port: 0 }
  const server = createServer((req, res) => {
    void dispatch(req, res, state.port)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 7790, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('预览服务器没有拿到 TCP 地址'))
        return
      }
      state.port = address.port
      server.on('error', (error) => console.error('[frontend:preview] 服务器错误：', error))
      resolve()
    })
  })

  return {
    get port() {
      return state.port
    },
    get url() {
      return `http://127.0.0.1:${state.port}`
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse, port: number): Promise<void> {
  try {
    assertHost(req, port)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'text/plain; charset=utf-8', '只支持 GET / HEAD')
      return
    }
    const pathname = new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname

    if (pathname === '/') {
      res.writeHead(303, { Location: '/console', ...SECURITY_HEADERS })
      res.end()
      return
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS)
      res.end()
      return
    }
    if (pathname.startsWith('/api/')) {
      send(res, 404, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'PREVIEW_NO_API' } }))
      return
    }
    if (pathname === '/console' || pathname.startsWith('/console/') || pathname === '/admin' || pathname.startsWith('/admin/')) {
      send(res, 200, 'text/html; charset=utf-8', await indexHtml())
      return
    }
    if (pathname === `${ASSET_PREFIX}config.js`) {
      send(res, 200, 'text/javascript; charset=utf-8', configSource(PREVIEW_CONFIG, 'preview', ASSET_PREFIX))
      return
    }
    if (pathname.startsWith(ASSET_PREFIX)) {
      const relative = pathname.slice(ASSET_PREFIX.length)
      let file: string
      try {
        // 预览时 index.html 也要替换占位符；其余文件按原样发。
        file = normalizeAssetPath(relative)
      } catch {
        send(res, 404, 'text/plain; charset=utf-8', '没有这个资源')
        return
      }
      if (file === 'index.html') {
        send(res, 200, 'text/html; charset=utf-8', await indexHtml())
        return
      }
      try {
        const body = await readFile(join(BUNDLED_ASSETS_DIR, ...file.split('/')))
        send(res, 200, contentTypeOf(file), body)
      } catch {
        send(res, 404, 'text/plain; charset=utf-8', '没有这个资源')
      }
      return
    }
    send(res, 404, 'text/plain; charset=utf-8', '没有这个路径')
  } catch (error) {
    send(res, 400, 'text/plain; charset=utf-8', error instanceof Error ? error.message : String(error))
  }
}

async function indexHtml(): Promise<string> {
  const template = await readFile(join(BUNDLED_ASSETS_DIR, 'index.html'), 'utf8')
  return template.replaceAll('__ASSET_BASE__', ASSET_PREFIX).replaceAll('__ASSET_VERSION__', 'preview')
}

function assertHost(req: IncomingMessage, port: number): void {
  const host = req.headers.host
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`]
  if (host === undefined || !allowed.includes(host)) {
    throw new Error(`Host 必须是 ${allowed.join(' 或 ')}`)
  }
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Uint8Array,
): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'Content-Type': contentType, ...SECURITY_HEADERS })
  res.end(body)
}
