/**
 * http_io.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { ApiError, badRequest } from './errors.ts'
import { CONTENT_TYPES } from './constants.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import { extname } from 'node:path'


// ───────────────────────────────── 纯函数 ─────────────────────────────────

export function isSpaPath(pathname: string): boolean {
  return (
    pathname === '/console' ||
    pathname.startsWith('/console/') ||
    pathname === '/admin' ||
    pathname.startsWith('/admin/')
  )
}


export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw badRequest('路径含有非法百分号编码')
  }
}


export function contentTypeOf(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
}


export function requestIdOf(res: ServerResponse): string | null {
  const value = res.getHeader('X-Request-Id')
  return typeof value === 'string' ? value : null
}


export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
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


export function readCookie(req: IncomingMessage, name: string): string | undefined {
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


export function deviceMeta(req: IncomingMessage): { userAgent?: string; ip?: string } {
  const userAgent = req.headers['user-agent']
  const ip = req.socket.remoteAddress
  return {
    ...(typeof userAgent === 'string' ? { userAgent } : {}),
    ...(typeof ip === 'string' ? { ip } : {}),
  }
}
