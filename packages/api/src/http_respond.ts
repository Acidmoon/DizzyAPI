/**
 * http_respond.ts：从 http.ts 的 ApiServer 搬出来的 http_respond 相关成员（行为逐字未改）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer；
 * 导出的是 `(host, …)` 形式的自由函数，http.ts 与 routes/* 直接调用（没有委派层）。
 */
import type { ApiServer } from './http.ts'
import { isPlainObject, safeJson } from './params.ts'
import { readBody, requestIdOf } from './http_io.ts'
import { NO_STORE } from './constants.ts'
import { ApiError, badRequest, isApiError, toApiError } from './errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'

export function allowRead(host: ApiServer, req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  sendMethodNotAllowed(host, req, res, ['GET', 'HEAD'])
  return false
}

export function allowMethod(host: ApiServer, req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): boolean {
  if (req.method !== undefined && allowed.includes(req.method)) return true
  sendMethodNotAllowed(host, req, res, allowed)
  return false
}

export async function jsonBody(host: ApiServer, req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, host.config.bodyLimitBytes)
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

export function sendJson(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
status: number,
value: unknown,
headers: Readonly<Record<string, string>> = {},
): void {
  const body = Buffer.from(safeJson(value), 'utf8')
  sendBody(host, req, res, status, 'application/json; charset=utf-8', body, {
    'Cache-Control': NO_STORE,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
}

export function sendBody(
host: ApiServer,
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

export function sendMethodNotAllowed(host: ApiServer, req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): void {
  res.setHeader('Allow', allowed.join(', '))
  sendJson(host, req, res, 405, {
    error: {
      code: 'API_METHOD_NOT_ALLOWED',
      message: `不支持 ${req.method ?? '未知方法'}；允许：${allowed.join(', ')}`,
      requestId: requestIdOf(res),
    },
  })
}

export function respondError(host: ApiServer, req: IncomingMessage, res: ServerResponse, error: unknown): void {
  const apiError = toApiError(error)
  if (!isApiError(error)) {
    const message = error instanceof Error ? error.message : String(error)
    // 领域错误（4xx）是正常拒绝，别记成内部错误；只有 5xx 才是真的需要排障。
    if (apiError.status >= 500) {
      host.runtime.log('error', `产品 HTTP 入口内部错误：${message}`)
    } else {
      host.runtime.log('warn', `产品 HTTP 入口拒绝请求：${apiError.code} ${message}`)
    }
  }
  try {
    sendJson(host, req, res, apiError.status, {
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
