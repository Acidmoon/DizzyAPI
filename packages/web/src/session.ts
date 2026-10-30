/** 会话 cookie 的读写；只放 HttpOnly token，不放任何用户信息。 */
import type { IncomingMessage } from 'node:http'
import type { SessionView } from './runtime.ts'

export function readCookie(req: IncomingMessage, name: string): string | undefined {
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

export function sessionCookie(
  name: string,
  token: string,
  expiresAt: string,
  secure: boolean,
): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

export function clearSessionCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}

/** 是否是 HTTPS 请求（反代已把协议写在 X-Forwarded-Proto）。 */
export function isSecureRequest(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto']
  if (typeof proto === 'string') return proto.split(',')[0].trim() === 'https'
  return false
}

/**
 * 未登录时的占位会话：`auth: false` 的页面（登录 / 注册）不解引用用户字段。
 *
 * 从 `service.ts` 搬来这里：它不是一个 HTTP 概念，是「会话的形状」，
 * 放这儿也让 `service.ts` 净减（AGENTS.md §5.6：超限文件只许缩短）。
 */
export function placeholderSession(): SessionView {
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
      concurrencyLimit: null,
      avatar: null,
      createdAt: '',
      updatedAt: '',
    },
    expiresAt: '',
  }
}
