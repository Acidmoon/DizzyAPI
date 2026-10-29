/**
 * /api/usage 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { parseIntegerParam } from '../params.ts'
import { centsOf, dateOf } from '../views/common.ts'
import { usageCsv, usageDetailOf, usageRowOf, usageTotalsOf } from '../views/usage.ts'
import { parseUserId, roleOf } from '../views/session.ts'
import { USAGE_RANGE_DAYS } from '../constants.ts'
import { ApiError, badRequest, notFound, unauthorized } from '../errors.ts'
import { type IncomingMessage, type ServerResponse } from 'node:http'
import type { UsageQueryLike } from '../types.ts'

export async function usage(host: ApiServer, req: IncomingMessage, url: URL): Promise<unknown> {
  const view = await host.requireSession(req)
  const usage = host.runtime.usage()
  if (usage === undefined) {
    throw new ApiError('API_USAGE_UNAVAILABLE', 503, '用量插件不在运行，暂时无法查询用量')
  }

  const range = url.searchParams.get('range') ?? '30d'
  const days = USAGE_RANGE_DAYS[range]
  if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)

  const now = host.runtime.now()
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const fromMs = todayStart - (days - 1) * 86_400_000
  const toMs = todayStart + 86_400_000

  const user = await host.runtime.user.get(view.userId)
  if (user === undefined) throw unauthorized('账号已不存在，请重新登录')

  // 普通用户只能看自己的；管理员可以用 userId 指定别人（不传 = 全部）。
  const userIdParam = url.searchParams.get('userId')
  let userId: number | undefined
  if (roleOf(view.user) === 'admin') {
    if (userIdParam !== null && userIdParam !== '') userId = parseUserId(userIdParam)
  } else {
    userId = view.userId
  }

  const apiKeyParam = url.searchParams.get('apiKeyId')
  const apiKeyId = apiKeyParam === null || apiKeyParam === '' ? undefined : apiKeyParam
  const modelParam = url.searchParams.get('model')
  const model = modelParam === null || modelParam === '' ? undefined : modelParam
  const cursorParam = url.searchParams.get('cursor')
  const cursor =
    cursorParam === null || cursorParam === ''
      ? undefined
      : parseIntegerParam(cursorParam, 'cursor', 1, 1, Number.MAX_SAFE_INTEGER)
  const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 200) ?? 20

  const query: UsageQueryLike = {
    fromMs,
    toMs,
    ...(userId === undefined ? {} : { userId }),
    ...(apiKeyId === undefined ? {} : { apiKeyId }),
    ...(model === undefined ? {} : { model }),
  }
  const summary = usage.summary(query)
  const page = usage.list({ ...query, ...(cursor === undefined ? {} : { cursor }), limit })

  return {
    range,
    from: dateOf(new Date(fromMs)),
    to: dateOf(new Date(toMs - 86_400_000)),
    apiKeyId: apiKeyId ?? null,
    // 余额只按当前用户余额换算；历史消费由用量明细体现，不在这里伪造。
    balances: {
      paidCents: centsOf(user.balance),
      grantedCents: 0,
      spentCents: 0,
    },
    totals: usageTotalsOf(summary.totals),
    daily: summary.daily.map((point) => ({ date: point.date, ...usageTotalsOf(point) })),
    models: summary.models.map((item) => ({ model: item.model, ...usageTotalsOf(item) })),
    records: { items: page.items.map(usageRowOf), nextCursor: page.nextCursor },
    pricingAvailable: host.runtime.pricing() !== undefined,
    generatedAt: now.toISOString(),
  }
}

/**
 * `GET /api/usage/export`：把当前筛选条件下的明细导出成 CSV。
 *
 * 响应是 JSON `{ filename, content }`，由浏览器自己生成 Blob 下载；
 * 这样不用在 HTTP 层区分下载 / 错误信封，也不会把 CSV 当 JSON 解析。
 */

/**
 * `GET /api/usage/export`：把当前筛选条件下的明细导出成 CSV。
 *
 * 响应是 JSON `{ filename, content }`，由浏览器自己生成 Blob 下载；
 * 这样不用在 HTTP 层区分下载 / 错误信封，也不会把 CSV 当 JSON 解析。
 */
export async function usageExport(host: ApiServer, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const view = await host.requireSession(req)
  const usage = host.runtime.usage()
  if (usage === undefined) {
    throw new ApiError('API_USAGE_UNAVAILABLE', 503, '用量插件不在运行，暂时无法导出用量')
  }

  const format = url.searchParams.get('format') ?? 'csv'
  if (format !== 'csv') throw badRequest('format 只支持 csv')

  const range = url.searchParams.get('range') ?? '30d'
  const days = USAGE_RANGE_DAYS[range]
  if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)

  const now = host.runtime.now()
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const fromMs = todayStart - (days - 1) * 86_400_000
  const toMs = todayStart + 86_400_000

  const userIdParam = url.searchParams.get('userId')
  let userId: number | undefined
  if (roleOf(view.user) === 'admin') {
    if (userIdParam !== null && userIdParam !== '') userId = parseUserId(userIdParam)
  } else {
    userId = view.userId
  }

  const apiKeyParam = url.searchParams.get('apiKeyId')
  const apiKeyId = apiKeyParam === null || apiKeyParam === '' ? undefined : apiKeyParam
  const modelParam = url.searchParams.get('model')
  const model = modelParam === null || modelParam === '' ? undefined : modelParam

  const rows = usage.exportRows({
    fromMs,
    toMs,
    ...(userId === undefined ? {} : { userId }),
    ...(apiKeyId === undefined ? {} : { apiKeyId }),
    ...(model === undefined ? {} : { model }),
  })
  const from = dateOf(new Date(fromMs)).replaceAll('-', '')
  const to = dateOf(new Date(toMs - 86_400_000)).replaceAll('-', '')
  host.sendJson(req, res, 200, {
    filename: `usage-${from}-${to}.csv`,
    content: usageCsv(rows),
  })
}

/**
 * `GET /api/usage/:reqId`：单条用量详情。
 *
 * 权限与列表同口径：普通用户只能看自己的记录，管理员可以查全部。
 * **查不到与「不是自己的」返回同一个 404**——不向外泄露某个 reqId 是否存在
 * （与充值订单的「用户面不泄露存在性」同一条纪律）。
 *
 * 比列表多给四个字段：`reasoningTokens` / `usagePresent` / `usageComplete`
 * （库里一直有、列表接口没出）与 `ttftMs`（首字延迟，旧记录是 null）。
 */

/**
 * `GET /api/usage/:reqId`：单条用量详情。
 *
 * 权限与列表同口径：普通用户只能看自己的记录，管理员可以查全部。
 * **查不到与「不是自己的」返回同一个 404**——不向外泄露某个 reqId 是否存在
 * （与充值订单的「用户面不泄露存在性」同一条纪律）。
 *
 * 比列表多给四个字段：`reasoningTokens` / `usagePresent` / `usageComplete`
 * （库里一直有、列表接口没出）与 `ttftMs`（首字延迟，旧记录是 null）。
 */
export async function usageDetail(host: ApiServer, req: IncomingMessage, res: ServerResponse, reqId: string): Promise<void> {
  const view = await host.requireSession(req)
  const usage = host.runtime.usage()
  if (usage === undefined) {
    throw new ApiError('API_USAGE_UNAVAILABLE', 503, '用量插件不在运行，暂时无法查询用量')
  }
  if (reqId === '') throw notFound('没有这条用量记录')

  const row = usage.get(reqId)
  if (row === null || (roleOf(view.user) !== 'admin' && row.userId !== view.userId)) {
    throw new ApiError('USAGE_RECORD_NOT_FOUND', 404, '没有这条用量记录')
  }
  host.sendJson(req, res, 200, { record: usageDetailOf(row) })
}

/**
 * `/api/pricing`：读价格表（会话）与改价格（管理员）。
 *
 * - `GET /api/pricing` → `{ items }`；
 * - `GET /api/pricing/:model` → 单个价格，没有就 404；
 * - `PUT /api/pricing/:model` → 写入并返回新价格；
 * - `DELETE /api/pricing/:model` → `{ removed }`。
 *
 * 模型名可能含 `/`，由 `encodeURIComponent` 编成 `%2F` 留在同一路径段里。
 */
