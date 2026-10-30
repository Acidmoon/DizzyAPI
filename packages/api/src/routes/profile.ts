/**
 * /api/profile 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, optionalAvatar, requiredString } from '../params.ts'
import { sessionUserOf } from '../views/session.ts'
import { ApiError, badRequest, notFound, unauthorized } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import { allowMethod, jsonBody, sendJson } from '../http_respond.ts'
import { requireSession, sessionToken } from '../http_session.ts'

export async function routeProfile(host: ApiServer, req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
  if (parts.length === 1) {
    if (!allowMethod(host, req, res, ['PATCH'])) return
    const view = await requireSession(host, req)
    const body = await jsonBody(host, req)
    assertOnlyKeys(body, ['name', 'avatar'])
    const patch: { name?: string; avatar?: string | null } = {}
    if (Object.hasOwn(body, 'name')) patch.name = requiredString(body, 'name')
    if (Object.hasOwn(body, 'avatar')) {
      patch.avatar = optionalAvatar(body.avatar)
    }
    if (Object.keys(patch).length === 0) throw badRequest('没有可修改的字段')

    const update = host.runtime.user.updateProfile
    if (typeof update !== 'function') {
      throw new ApiError(
        'API_PROFILE_UNAVAILABLE',
        503,
        '用户插件没有提供 updateProfile 接口',
      )
    }
    await update.call(host.runtime.user, view.userId, patch)
    const user = await host.runtime.user.get(view.userId)
    if (user === undefined) throw unauthorized('账号已不存在，请重新登录')
    sendJson(host, req, res, 200, sessionUserOf(user))
    return
  }

  if (parts.length === 2 && parts[1] === 'password') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const view = await requireSession(host, req)
    const token = sessionToken(host, req)
    const body = await jsonBody(host, req)
    const currentPassword = requiredString(body, 'currentPassword')
    const newPassword = requiredString(body, 'newPassword')
    sendJson(host, req, res, 200, await host.runtime.auth.changePassword(token, currentPassword, newPassword))
    return
  }

  throw notFound('没有这个资料接口')
}
