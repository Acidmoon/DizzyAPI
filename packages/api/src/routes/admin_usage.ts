/**
 * /api/admin_usage 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { parseIntegerParam, parsePositiveInteger, queryStringOf } from '../params.ts'
import { dateOf } from '../views/common.ts'
import {
  adminUsageCsv,
  adminUsageRowOf,
  rejectedRowOf,
  usageDailyOf,
  usageModelOf,
  usageTotalsOf,
} from '../views/usage.ts'
import { auditActorOf } from '../audit.ts'
import { ADMIN_USAGE_EXPORT_LIMIT, USAGE_RANGE_DAYS, UsageRange } from '../constants.ts'
import { badRequest, notFound } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { UsageQueryLike } from '../types.ts'
import { requireAdmin } from '../http_session.ts'
import { routeAdminUsageRejected } from './admin_usage_rejected.ts'
import { allowRead, sendJson } from '../http_respond.ts'

/**
 * `/api/admin/usage`：管理员口径的用量明细与导出。
 *
 * 查询窗口与用户侧 `/api/usage` 同口径：[from 当天 00:00 UTC, 明天 00:00 UTC)。
 * `records.items` 比用户侧多 `userName` / `accountId` / `attempts`；
 * `userName` 在同一次请求内按 userId 缓存，查不到就是 null。
 */
export async function routeAdminUsage(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  if (parts[2] === 'rejected') {
    await routeAdminUsageRejected(host, req, res, parts, url, auditActorOf(adminView))
    return
  }
  if (parts.length > 3 || (parts.length === 3 && parts[2] !== 'export')) {
    throw notFound('没有这个管理员用量接口')
  }
  if (!allowRead(host, req, res)) return

  const usage = host.requireUsage()
  const spec = adminUsageQuery(host, url)
  const nameOf = userNameResolver(host)

  if (parts.length === 3) {
    const rows = usage.exportRows(spec.query, ADMIN_USAGE_EXPORT_LIMIT)
    const decorated = await Promise.all(
      rows.map(async (row) => ({ ...row, userName: await nameOf(row.userId) })),
    )
    sendJson(host, req, res, 200, {
      filename: `admin-usage-${spec.from.replaceAll('-', '')}-${spec.to.replaceAll('-', '')}.csv`,
      content: adminUsageCsv(decorated),
    })
    return
  }

  const page = usage.list(spec.query)
  const summary = usage.summary(spec.query)
  const items = await Promise.all(
    page.items.map(async (row) => adminUsageRowOf(row, await nameOf(row.userId))),
  )
  // 隔离区：主接口给「第一页 + 计数」，完整分页在 `/api/admin/usage/rejected`。
  // 这些记录没有进明细、不会被结算；管理面必须能看见，否则就是静默免单。
  const rejected = usage.listRejected({ limit: 20 })
  sendJson(host, req, res, 200, {
    range: spec.range,
    from: spec.from,
    to: spec.to,
    totals: usageTotalsOf(summary.totals),
    daily: summary.daily.map(usageDailyOf),
    models: summary.models.map(usageModelOf),
    records: { items, nextCursor: page.nextCursor },
    rejected: {
      items: rejected.items.map(rejectedRowOf),
      total: rejected.total,
      pending: rejected.pending,
    },
    pricingAvailable: host.runtime.pricing() !== undefined,
    generatedAt: host.runtime.now().toISOString(),
  })
}

/**
 * 管理员用量的筛选与时间窗口。`range` 与用户侧一致；`status` 是精确匹配的 HTTP 状态码。
 */
export function adminUsageQuery(host: ApiServer, url: URL): {
readonly range: UsageRange
readonly from: string
readonly to: string
readonly query: UsageQueryLike
} {
  const range = url.searchParams.get('range') ?? '30d'
  const days = USAGE_RANGE_DAYS[range]
  if (days === undefined) throw badRequest(`range 只能是 ${Object.keys(USAGE_RANGE_DAYS).join(' / ')}`)

  const now = host.runtime.now()
  const to = dateOf(now)
  const from = dateOf(new Date(now.getTime() - (days - 1) * 86_400_000))
  const fromMs = Date.parse(`${from}T00:00:00.000Z`)
  const toMs = Date.parse(`${to}T00:00:00.000Z`) + 86_400_000

  const userIdText = url.searchParams.get('userId')
  const userId =
    userIdText === null || userIdText === '' ? undefined : parsePositiveInteger(userIdText, 'userId')

  const apiKeyId = queryStringOf(url, 'apiKeyId')
  const model = queryStringOf(url, 'model')

  const statusText = url.searchParams.get('status')
  let status: number | undefined
  if (statusText !== null && statusText !== '') {
    if (!/^\d+$/.test(statusText)) throw badRequest('status 必须是非负整数')
    status = Number(statusText)
    if (!Number.isSafeInteger(status) || status < 0 || status > 599) {
      throw badRequest('status 必须在 0..599 之间')
    }
  }

  const cursorText = url.searchParams.get('cursor')
  const cursor =
    cursorText === null || cursorText === ''
      ? undefined
      : parseIntegerParam(cursorText, 'cursor', 0, 1, Number.MAX_SAFE_INTEGER)
  const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 200) ?? 20

  return {
    range: range as UsageRange,
    from,
    to,
    query: {
      fromMs,
      toMs,
      ...(userId === undefined ? {} : { userId }),
      ...(apiKeyId === undefined ? {} : { apiKeyId }),
      ...(model === undefined ? {} : { model }),
      ...(status === undefined ? {} : { status }),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    },
  }
}

/**
 * 同一次请求内复用的 userId → name 解析器。用户服务不可用或用户已删除时记 null，
 * 不让一行缺失把整个列表打成 500。
 */
export function userNameResolver(host: ApiServer, ): (userId: number) => Promise<string | null> {
  const cache = new Map<number, string | null>()
  return async (userId: number) => {
    if (cache.has(userId)) return cache.get(userId) ?? null
    let name: string | null = null
    try {
      const user = await host.runtime.user.get(userId)
      name = user === undefined ? null : user.name
    } catch {
      name = null
    }
    cache.set(userId, name)
    return name
  }
}
