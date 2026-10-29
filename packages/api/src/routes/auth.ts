/**
 * /api/auth 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { optionalString, requiredString } from '../params.ts'
import { deviceMeta, readCookie } from '../http_io.ts'
import { notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'

export async function routeAuth(host: ApiServer, req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
  const action = parts.slice(1).join('/')
  switch (action) {
    case 'register/request': {
      if (!host.allowMethod(req, res, ['POST'])) return
      const body = await host.jsonBody(req)
      const email = requiredString(body, 'email')
      const password = requiredString(body, 'password')
      const name = optionalString(body, 'name')
      const ticket = await host.runtime.auth.requestRegistration({
        email,
        password,
        ...(name === undefined ? {} : { name }),
      })
      host.sendJson(req, res, 200, ticket)
      return
    }
    case 'register/confirm': {
      if (!host.allowMethod(req, res, ['POST'])) return
      const body = await host.jsonBody(req)
      const email = requiredString(body, 'email')
      const code = requiredString(body, 'code')
      const result = await host.runtime.auth.confirmRegistration({ email, code })
      host.setSessionCookie(req, res, result.token, result.expiresAt)
      host.sendJson(req, res, 200, host.loginResponse(result))
      return
    }
    case 'login': {
      if (!host.allowMethod(req, res, ['POST'])) return
      const body = await host.jsonBody(req)
      const email = requiredString(body, 'email')
      const password = requiredString(body, 'password')
      const result = await host.runtime.auth.login({
        email,
        password,
        meta: deviceMeta(req),
      })
      host.setSessionCookie(req, res, result.token, result.expiresAt)
      host.sendJson(req, res, 200, host.loginResponse(result))
      return
    }
    case 'logout': {
      if (!host.allowMethod(req, res, ['POST'])) return
      const token = readCookie(req, host.config.sessionCookieName)
      if (token !== undefined) {
        try {
          await host.runtime.auth.logout(token)
        } catch {
          // 登出幂等：令牌无效 / 已过期都算成功。
        }
      }
      host.clearSessionCookie(req, res)
      host.sendJson(req, res, 200, { ok: true })
      return
    }
    case 'password/reset/request': {
      if (!host.allowMethod(req, res, ['POST'])) return
      const body = await host.jsonBody(req)
      const email = requiredString(body, 'email')
      host.sendJson(req, res, 200, await host.runtime.auth.requestPasswordReset(email))
      return
    }
    case 'password/reset/confirm': {
      if (!host.allowMethod(req, res, ['POST'])) return
      const body = await host.jsonBody(req)
      const email = requiredString(body, 'email')
      const code = requiredString(body, 'code')
      const password = requiredString(body, 'password')
      host.sendJson(req, res, 200, await host.runtime.auth.confirmPasswordReset({ email, code, password }))
      return
    }
    default:
      throw notFound('没有这个鉴权接口')
  }
}
