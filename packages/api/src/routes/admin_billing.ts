/**
 * /api/admin_billing 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { parseIntegerParam, queryStringOf } from '../params.ts'
import { settleDailyOf, settleModelOf, settleRecordOf, settleTotalsOf } from '../views/commerce.ts'
import { API_ACTOR } from '../constants.ts'
import { notFound } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'

// ───────────────────────────────── 管理员：结算 ─────────────────────────────────

/**
 * `GET /api/admin/billing`：结算记录 + 汇总（只读，真实扣费不在 HTTP 层发生）。
 *
 * 查询参数：`status`（结算状态或 `problem`）、`limit`、`offset`。
 * 金额一律写成十进制字符串（整数微元），浏览器用 BigInt 解析。
 */
export async function routeAdminBilling(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  await host.requireAdmin(req)
  if (parts.length !== 2) throw notFound('没有这个结算接口')
  if (!host.allowRead(req, res)) return
  const billing = host.requireBilling()

  const status = queryStringOf(url, 'status')
  const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
  const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
  const page = await billing.list(API_ACTOR, {
    ...(status === undefined ? {} : { status }),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
  })
  const summary = await billing.summary(API_ACTOR)
  host.sendJson(req, res, 200, {
    totals: settleTotalsOf(summary.totals),
    daily: summary.daily.map(settleDailyOf),
    models: summary.models.map(settleModelOf),
    records: { items: page.items.map(settleRecordOf), total: page.total },
    generatedAt: host.runtime.now().toISOString(),
  })
}
