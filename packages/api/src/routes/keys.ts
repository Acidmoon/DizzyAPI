/**
 * /api/keys 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, requiredBoolean, requiredInteger, requiredString } from '../params.ts'
import { normalizeCreatedKey, normalizeKeyList, normalizeKeySummary } from '../views/account.ts'
import { badRequest, notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'

export async function routeKeys(host: ApiServer, req: IncomingMessage, res: ServerResponse, parts: readonly string[]): Promise<void> {
  const view = await host.requireSession(req)

  if (parts.length === 1) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const apiKey = host.requireApiKey()
      host.sendJson(req, res, 200, { items: normalizeKeyList(await apiKey.list(view.userId)) })
      return
    }
    if (req.method === 'POST') {
      const apiKey = host.requireApiKey()
      const body = await host.jsonBody(req)
      const name = requiredString(body, 'name')
      host.sendJson(req, res, 200, normalizeCreatedKey(await apiKey.create(view.userId, { name })))
      return
    }
    host.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
    return
  }

  if (parts.length === 2) {
    const id = parts[1] as string
    if (req.method === 'PATCH') {
      const apiKey = host.requireApiKey()
      const body = await host.jsonBody(req)
      assertOnlyKeys(body, [
        'name',
        'enabled',
        'expiresAt',
        'spendingLimitMicros',
        'concurrencyLimit',
      ])
      const patch: {
        name?: string
        enabled?: boolean
        expiresAt?: string | null
        spendingLimitMicros?: string | null
        concurrencyLimit?: number | null
      } = {}
      if (Object.hasOwn(body, 'name')) patch.name = requiredString(body, 'name')
      if (Object.hasOwn(body, 'enabled')) patch.enabled = requiredBoolean(body, 'enabled')
      // 三个执行面上限：null = 不限 / 永不过期。金额只收十进制字符串
      // （JSON number 会丢 >2^53 的精度），形状校验在 api-key 插件里做。
      if (Object.hasOwn(body, 'expiresAt')) {
        patch.expiresAt = body.expiresAt === null ? null : requiredString(body, 'expiresAt')
      }
      if (Object.hasOwn(body, 'spendingLimitMicros')) {
        patch.spendingLimitMicros =
          body.spendingLimitMicros === null ? null : requiredString(body, 'spendingLimitMicros')
      }
      if (Object.hasOwn(body, 'concurrencyLimit')) {
        patch.concurrencyLimit = body.concurrencyLimit === null ? null : requiredInteger(body, 'concurrencyLimit')
      }
      if (Object.keys(patch).length === 0) throw badRequest('没有可修改的字段')
      host.sendJson(req, res, 200, normalizeKeySummary(await apiKey.update(view.userId, id, patch)))
      return
    }
    if (req.method === 'DELETE') {
      const apiKey = host.requireApiKey()
      await apiKey.remove(view.userId, id)
      host.sendJson(req, res, 200, { removed: true })
      return
    }
    host.sendMethodNotAllowed(req, res, ['PATCH', 'DELETE'])
    return
  }

  if (parts.length === 3 && parts[2] === 'rotate') {
    if (!host.allowMethod(req, res, ['POST'])) return
    const apiKey = host.requireApiKey()
    host.sendJson(req, res, 200, normalizeCreatedKey(await apiKey.rotate(view.userId, parts[1] as string)))
    return
  }

  throw notFound('没有这个 API key 接口')
}
