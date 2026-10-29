/**
 * http_static.ts：从 http.ts 的 ApiServer 搬出来的 http_static 相关成员（行为逐字未改）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer；
 * http.ts 里留同名薄委派，所以类内部与 routes/* 的调用点一个都没动。
 */
import type { ApiServer } from './http.ts'
import { isPlainObject } from './params.ts'
import { contentTypeOf, decodeSegment } from './http_io.ts'
import { CONTENT_SECURITY_POLICY, IMMUTABLE, NO_STORE } from './constants.ts'
import { notFound } from './errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FrontendPort } from './types.ts'
import { sendBody } from './http_respond.ts'

// ───────────────────────────────── 静态 ─────────────────────────────────

export function assetPrefix(host: ApiServer, ): string {
  const configured = host.runtime.frontend()?.config?.publicBase
  const base = typeof configured === 'string' && configured !== '' ? configured : '/assets/frontend'
  return `${base.replace(/\/+$/, '')}/`
}

export function isAssetPath(host: ApiServer, pathname: string): boolean {
  try {
    return pathname.startsWith(assetPrefix(host))
  } catch {
    return false
  }
}

export async function serveAsset(host: ApiServer, req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const frontend = host.requireFrontend()
  if (!(await frontendEnabled(host, frontend))) throw notFound('前端资源已停用')

  const prefix = assetPrefix(host)
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

  sendBody(host, req, res, 200, contentTypeOf(relative), body, {
    'Cache-Control': IMMUTABLE,
    'X-Content-Type-Options': 'nosniff',
  })
}

export async function serveIndex(host: ApiServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const frontend = host.requireFrontend()
  if (!(await frontendEnabled(host, frontend))) throw notFound('前端资源已停用')

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

  sendBody(host, req, res, 200, 'text/html; charset=utf-8', body, {
    'Cache-Control': NO_STORE,
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
}

/** 前端插件卸载时会把 `state.json.enabled` 置 false；此时静态字节一律 404。 */
export async function frontendEnabled(host: ApiServer, frontend: FrontendPort): Promise<boolean> {
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
