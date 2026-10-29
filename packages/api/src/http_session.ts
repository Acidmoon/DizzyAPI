/**
 * http_session.ts：从 http.ts 的 ApiServer 搬出来的 http_session 相关成员（行为逐字未改）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer；
 * http.ts 里留同名薄委派，所以类内部与 routes/* 的调用点一个都没动。
 */
import type { ApiServer } from './http.ts'
import { errorCodeOf } from './params.ts'
import { readCookie } from './http_io.ts'
import { roleOf, sessionInfoOf, sessionUserOf } from './views/session.ts'
import { ApiError, forbidden, isApiError, unauthorized } from './errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { LoginResultLike, SessionInfoView, SessionRole, SessionViewLike } from './types.ts'

// ───────────────────────────────── 会话 ─────────────────────────────────

export function sessionToken(host: ApiServer, req: IncomingMessage): string {
  const token = readCookie(req, host.config.sessionCookieName)
  if (token === undefined || token === '') throw unauthorized('会话 cookie 不存在，请重新登录')
  return token
}

/**
 * 会话校验。auth 的原始错误细节不往外带：只保留稳定 code，消息统一成通用文案。
 * banned 是 403，其余会话问题统一 401。
 */
export async function requireSession(host: ApiServer, req: IncomingMessage): Promise<SessionViewLike> {
  const token = host.sessionToken(req)
  try {
    return await host.runtime.auth.verifySession(token)
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

export async function requireAdmin(host: ApiServer, req: IncomingMessage): Promise<{ view: SessionViewLike; role: SessionRole }> {
  const view = await host.requireSession(req)
  const role = roleOf(view.user)
  if (role !== 'admin') throw forbidden()
  return { view, role }
}

export async function sessionResponse(host: ApiServer, view: SessionViewLike): Promise<unknown> {
  // 新 auth 会直接在会话视图里给 email；旧 auth 没有这个字段时退回 getEmail。
  const viewEmail = typeof view.email === 'string' && view.email !== '' ? view.email : null
  return {
    user: sessionUserOf(view.user),
    email: viewEmail ?? (await host.emailOf(view.userId)),
    session: sessionInfoOf(view),
    permissions: { admin: roleOf(view.user) === 'admin' },
  }
}

export function loginResponse(host: ApiServer, result: LoginResultLike): unknown {
  const now = host.runtime.now().toISOString()
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

export async function emailOf(host: ApiServer, userId: number): Promise<string | null> {
  const getEmail = host.runtime.auth.getEmail
  if (typeof getEmail !== 'function') return null
  try {
    const email = await getEmail.call(host.runtime.auth, userId)
    return typeof email === 'string' && email !== '' ? email : null
  } catch {
    return null
  }
}

export function setSessionCookie(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
token: string,
expiresAt: string,
): void {
  const expires = Date.parse(expiresAt)
  const maxAge = Number.isFinite(expires)
    ? Math.max(1, Math.floor((expires - host.runtime.now().getTime()) / 1_000))
    : 60 * 60
  res.setHeader(
    'Set-Cookie',
    `${host.config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${host.secureCookie(req)}`,
  )
}

export function clearSessionCookie(host: ApiServer, req: IncomingMessage, res: ServerResponse): void {
  res.setHeader(
    'Set-Cookie',
    `${host.config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${host.secureCookie(req)}`,
  )
}

/**
 * 反向代理终止 TLS 时，`req.socket.encrypted` 在 Node 侧是 false，但 Caddy 会带
 * `X-Forwarded-Proto: https`。只有确认请求是 HTTPS 才加 `Secure`，这样本机
 * `http://127.0.0.1` 的开发预览仍然能收到 cookie。
 */
export function secureCookie(host: ApiServer, req: IncomingMessage): string {
  const socket = req.socket as { encrypted?: boolean }
  const forwarded = req.headers['x-forwarded-proto']
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return socket.encrypted === true || proto === 'https' ? '; Secure' : ''
}
