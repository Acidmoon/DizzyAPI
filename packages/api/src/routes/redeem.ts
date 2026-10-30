/**
 * /api/redeem 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, parseIntegerParam, requiredString } from '../params.ts'
import { redeemResultOf, redemptionOf } from '../views/commerce.ts'
import { notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'

// ───────────────────────────────── 兑换码 ─────────────────────────────────

/**
 * 用户面：`POST /api/redeem` 兑换，`GET /api/redeem` 我的兑换记录。
 *
 * 兑换失败一律走稳定 code（未知 / 已用 / 停用 / 过期 / 兑换中），消息里不含码本身；
 * 成功只回金额、余额与批次名。
 */
export async function routeRedeem(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  const view = await host.requireSession(req)
  if (parts.length !== 1) throw notFound('没有这个兑换接口')
  const redeem = host.requireRedeem()

  if (req.method === 'GET' || req.method === 'HEAD') {
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 100)
    const items = await redeem.listMyRedemptions(view.userId, limit)
    host.sendJson(req, res, 200, { items: items.map(redemptionOf) })
    return
  }
  if (req.method === 'POST') {
    const body = await host.jsonBody(req)
    assertOnlyKeys(body, ['code'])
    const code = requiredString(body, 'code')
    const result = await redeem.redeemCode({ userId: view.userId, code })
    host.sendJson(req, res, 200, redeemResultOf(result))
    return
  }
  host.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
}
