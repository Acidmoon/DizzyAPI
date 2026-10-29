/**
 * /api/admin_usage_rejected 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import { assertOnlyKeys, parseIntegerParam, requiredString } from '../params.ts'
import { rejectedRowOf } from '../views/usage.ts'
import { audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { badRequest, notFound } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import type { UsagePort, UsageRejectedQueryLike } from '../types.ts'
import { allowMethod, allowRead, jsonBody, sendJson } from '../http_respond.ts'

/**
 * `/api/admin/usage/rejected`：坏记录隔离区（只读列表 + 两个管理动作）。
 *
 * - `GET` → `{ items, total, pending, limit, offset }`（`status` 可筛 pending / ignored / replayed）
 * - `POST .../ignore` `{reqId}` → 标记 ignored（幂等）
 * - `POST .../replay` `{reqId}` → 按 req_id 重放，成功则 pending → replayed（幂等，不重复插入）
 *
 * 这些记录**没有**进用量明细，也不会被结算；管理面必须能看见，否则就是静默免单。
 */
export async function routeAdminUsageRejected(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
actor: string,
): Promise<void> {
  const usage = host.requireUsage()
  if (parts.length === 3) {
    if (!allowRead(host, req, res)) return
    sendJson(host, req, res, 200, adminRejectedView(host, usage, url))
    return
  }
  if (parts.length !== 4) throw notFound('没有这个管理员用量接口')
  const action = parts[3]
  if (action !== 'ignore' && action !== 'replay') {
    throw notFound('没有这个隔离记录操作')
  }
  if (!allowMethod(host, req, res, ['POST'])) return
  const body = await jsonBody(host, req)
  assertOnlyKeys(body, ['reqId'])
  const reqId = requiredString(body, 'reqId')
  const identity = { actor, actorPlugin: API_ACTOR }

  if (action === 'ignore') {
    await audited(
      host.runtime,
      identity,
      {
        action: 'usage.rejected.ignore',
        targetType: 'usage-record',
        targetId: reqId,
        // 忽略 = 这笔用量永久不结算、不扣钱，等于放弃收入：属于高危动作。
        summary: `忽略一条被隔离的用量记录（永久不结算）`,
      },
      async () => usage.ignoreRejected(reqId),
    )
    sendJson(host, req, res, 200, { reqId, status: 'ignored' })
    return
  }

  const replayed = await audited(
    host.runtime,
    identity,
    {
      action: 'usage.rejected.replay',
      targetType: 'usage-record',
      targetId: reqId,
      // 重放会补结算（扣钱），失败也记：漏记一次就是账对不上。
      summary: '重放一条被隔离的用量记录（补结算）',
      metadataOf: (out) => ({ inserted: out.inserted, status: out.status }),
    },
    () => usage.replayRejected(reqId),
  )
  sendJson(host, req, res, 200, { reqId, ...replayed })
}

/** 隔离区列表视图：分页与状态筛选都在这里校验，非法值明确 400。 */
export function adminRejectedView(
host: ApiServer,
usage: UsagePort,
url: URL,
): {
items: ReturnType<typeof rejectedRowOf>[]
total: number
pending: number
limit: number
offset: number
} {
  const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 20, 1, 200) ?? 20
  const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000) ?? 0
  let status: string | undefined
  const raw = url.searchParams.get('status')
  if (raw !== null && raw !== '') {
    if (raw !== 'pending' && raw !== 'ignored' && raw !== 'replayed') {
      throw badRequest('status 只能是 pending / ignored / replayed')
    }
    status = raw
  }
  const query: UsageRejectedQueryLike = {
    limit,
    offset,
    ...(status === undefined ? {} : { status }),
  }
  const page = usage.listRejected(query)
  return {
    items: page.items.map(rejectedRowOf),
    total: page.total,
    pending: page.pending,
    limit,
    offset,
  }
}
