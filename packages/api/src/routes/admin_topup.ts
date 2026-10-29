/**
 * /api/admin_topup 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { parseIntegerParam, queryStringOf } from '../params.ts'
import { topupOrderOf, topupStatsOf } from '../views/commerce.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { TopupOrderLike } from '../types.ts'
import { requireAdmin } from '../http_session.ts'
import { allowMethod, allowRead, sendJson } from '../http_respond.ts'

/**
 * 管理面：`GET /api/admin/topup-orders`（列表 + 筛选）、`.../stats`、
 * `POST .../<orderNo>/confirm`（人工确认到账）、`POST .../<orderNo>/cancel`。
 *
 * 确认到账会**真的加余额**（走 user.adjustBalance，幂等）：重复确认只回 `credited: false`，
 * 不会重复加钱。本批没有支付回调路由——没有验签的回调一律不挂。
 */
export async function routeAdminTopupOrders(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
  const topup = host.requireTopup()

  if (parts.length === 2) {
    if (!allowRead(host, req, res)) return
    const query: {
      status?: string
      userId?: number
      fromMs?: number
      toMs?: number
      limit?: number
      offset?: number
    } = {}
    const status = queryStringOf(url, 'status')
    if (status !== undefined) query.status = status
    const userId = parseIntegerParam(url.searchParams.get('userId'), 'userId', 0, 0, Number.MAX_SAFE_INTEGER)
    if (userId !== undefined && userId > 0) query.userId = userId
    const fromMs = parseIntegerParam(url.searchParams.get('from'), 'from', 0, 0, Number.MAX_SAFE_INTEGER)
    if (fromMs !== undefined && fromMs > 0) query.fromMs = fromMs
    const toMs = parseIntegerParam(url.searchParams.get('to'), 'to', 0, 0, Number.MAX_SAFE_INTEGER)
    if (toMs !== undefined && toMs > 0) query.toMs = toMs
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
    const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
    if (limit !== undefined) query.limit = limit
    if (offset !== undefined) query.offset = offset
    const page = await topup.list(API_ACTOR, query)
    sendJson(host, req, res, 200, {
      items: page.items.map(topupOrderOf),
      total: page.total,
    })
    return
  }

  if (parts.length === 3 && parts[2] === 'stats') {
    if (!allowRead(host, req, res)) return
    sendJson(host, req, res, 200, topupStatsOf(await topup.stats(API_ACTOR)))
    return
  }

  if (parts.length === 4) {
    const orderNo = parts[2] as string
    if (parts[3] === 'confirm') {
      if (!allowMethod(host, req, res, ['POST'])) return
      const result = await audited(
        host.runtime,
        identity,
        {
          action: 'topup.order.confirm',
          targetType: 'topup-order',
          targetId: orderNo,
          // 确认到账会**真的加余额**：失败也记（加余额失败要能查到是哪一次）。
          summary: `确认充值订单 ${orderNo} 到账`,
          metadataOf: (out) => ({
            credited: out.credited,
            userId: out.order.userId,
            amountMicros: out.order.amountMicro.toString(),
          }),
        },
        () => topup.confirmPaid(API_ACTOR, orderNo),
      )
      sendJson(host, req, res, 200, {
        order: topupOrderOf(result.order),
        credited: result.credited,
      })
      return
    }
    if (parts[3] === 'cancel') {
      if (!allowMethod(host, req, res, ['POST'])) return
      const canceled = await audited<TopupOrderLike>(
        host.runtime,
        identity,
        {
          action: 'topup.order.cancel',
          targetType: 'topup-order',
          targetId: orderNo,
          summary: `取消充值订单 ${orderNo}`,
          metadataOf: (order) => ({ userId: order.userId, status: order.status }),
        },
        async () => topup.cancel(API_ACTOR, orderNo),
      )
      sendJson(host, req, res, 200, topupOrderOf(canceled))
      return
    }
  }

  throw notFound('没有这个充值订单接口')
}
