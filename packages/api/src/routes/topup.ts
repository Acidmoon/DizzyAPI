/**
 * /api/topup 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, nullableString, optionalString, parseIntegerParam, requiredString } from '../params.ts'
import { topupOptionsOf, topupOrderOf } from '../views/commerce.ts'
import { notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'

/**
 * 用户面：`GET /api/topup/options`、`GET/POST /api/topup/orders`、
 * `GET /api/topup/orders/<orderNo>`、`POST /api/topup/orders/<orderNo>/cancel`。
 *
 * 订单金额只接受「元」的十进制字符串（服务层换整数微元）；响应里金额一律十进制字符串。
 * 本批没有在线支付：订单创建后返回 `instructions`（人工确认说明），不会自动到账。
 */
export async function routeTopup(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  const view = await host.requireSession(req)
  const topup = host.requireTopup()

  if (parts.length === 2 && parts[1] === 'options') {
    if (!host.allowRead(req, res)) return
    host.sendJson(req, res, 200, topupOptionsOf(topup.options()))
    return
  }

  if (parts.length === 2 && parts[1] === 'orders') {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 100)
      const page = topup.listMine(view.userId, limit)
      host.sendJson(req, res, 200, {
        items: page.items.map(topupOrderOf),
        total: page.total,
      })
      return
    }
    if (req.method === 'POST') {
      const body = await host.jsonBody(req)
      assertOnlyKeys(body, ['amountYuan', 'provider', 'note'])
      const amountYuan = requiredString(body, 'amountYuan')
      const provider = optionalString(body, 'provider')
      const note = Object.hasOwn(body, 'note') ? nullableString(body, 'note') : undefined
      const created = await topup.createOrder({
        userId: view.userId,
        amountYuan,
        ...(provider === undefined ? {} : { provider }),
        ...(note === undefined ? {} : { note }),
      })
      host.sendJson(req, res, 200, {
        order: topupOrderOf(created.order),
        instructions: created.order.instructions,
      })
      return
    }
    host.sendMethodNotAllowed(req, res, ['GET', 'HEAD', 'POST'])
    return
  }

  if (parts.length === 3 && parts[1] === 'orders') {
    if (!host.allowRead(req, res)) return
    host.sendJson(req, res, 200, topupOrderOf(topup.getMine(view.userId, parts[2] as string)))
    return
  }

  if (parts.length === 4 && parts[1] === 'orders' && parts[3] === 'cancel') {
    if (!host.allowMethod(req, res, ['POST'])) return
    const canceled = topup.cancelMine(view.userId, parts[2] as string)
    host.sendJson(req, res, 200, topupOrderOf(canceled))
    return
  }

  throw notFound('没有这个充值接口')
}
