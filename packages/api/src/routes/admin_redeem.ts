/**
 * /api/admin_redeem 前缀的路由处理（从 http.ts 的 ApiServer 方法搬出）。
 *
 * 纯搬移：方法体逐字未改，只把 this. 换成 host.、签名前面加 host: ApiServer。
 * 判定顺序与分发在 http.ts 的 routeApi，本文件不自行分发。
 */
import type { ApiServer } from '../http.ts'
import {
  assertOnlyKeys,
  nullableString,
  optionalInteger,
  optionalString,
  parseIntegerParam,
  queryStringOf,
  readStringArray,
  requiredMicros,
  requiredString,
} from '../params.ts'
import { redeemBatchOf, redeemCodeOf, redeemStatsOf } from '../views/commerce.ts'
import { auditActorOf, audited } from '../audit.ts'
import { API_ACTOR } from '../constants.ts'
import { badRequest, notFound } from '../errors.ts'
import { IncomingMessage, ServerResponse } from 'node:http'
import { requireAdmin } from '../http_session.ts'
import { allowMethod, allowRead, jsonBody, sendJson, sendMethodNotAllowed } from '../http_respond.ts'

/**
 * 管理面：兑换码列表 / 生成批次 / 单码启停 / 人工核查 / 批量删除。
 *
 * 生成是唯一会返回明文的接口，而且**只在这一次响应里**；列表永远只有掩码。
 */
export async function routeAdminRedeemCodes(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
  const redeem = host.requireRedeem()

  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
      const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
      const query: {
        batchId?: string
        status?: string
        keyword?: string
        limit?: number
        offset?: number
      } = {}
      const batchId = queryStringOf(url, 'batch')
      if (batchId !== undefined) query.batchId = batchId
      const status = queryStringOf(url, 'status')
      if (status !== undefined) query.status = status
      const keyword = queryStringOf(url, 'keyword')
      if (keyword !== undefined) query.keyword = keyword
      if (limit !== undefined) query.limit = limit
      if (offset !== undefined) query.offset = offset

      const page = await redeem.listCodes(API_ACTOR, query)
      sendJson(host, req, res, 200, {
        items: page.items.map(redeemCodeOf),
        total: page.total,
      })
      return
    }
    if (req.method === 'POST') {
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['name', 'amountMicro', 'count', 'expiresAt', 'notes'])
      const name = requiredString(body, 'name')
      const amountMicro = requiredMicros(body, 'amountMicro')
      const count = optionalInteger(body, 'count', 1, 100)
      if (count === undefined) throw badRequest('count 必须是 1..100 的整数')
      const expiresAt =
        Object.hasOwn(body, 'expiresAt') ? nullableString(body, 'expiresAt') : undefined
      const notes = Object.hasOwn(body, 'notes') ? optionalString(body, 'notes') : undefined
      const created = await audited(
        host.runtime,
        identity,
        {
          action: 'redeem.batch.generate',
          targetType: 'redeem-batch',
          summary: `生成兑换码批次「${name}」（${count} 张）`,
          // 明文码只在响应里出现一次，**绝不进审计**；只记批次与额度。
          metadata: { count, amountMicros: amountMicro.toString(), expiresAt: expiresAt ?? null },
          metadataOf: (result) => ({ batchId: result.batch.id }),
        },
        () =>
          redeem.createBatch(API_ACTOR, {
            name,
            amountMicro,
            count,
            ...(expiresAt === undefined ? {} : { expiresAt }),
            ...(notes === undefined ? {} : { notes }),
          }),
      )
      sendJson(host, req, res, 200, {
        batch: redeemBatchOf(created.batch),
        codes: created.codes,
      })
      return
    }
    if (req.method === 'DELETE') {
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['ids'])
      const ids = readStringArray(body.ids, 'ids')
      const result = await audited(
        host.runtime,
        identity,
        {
          action: 'redeem.code.delete',
          targetType: 'redeem-code',
          summary: `批量删除 ${ids.length} 张兑换码`,
          metadata: { ids, count: ids.length },
          metadataOf: (out) => ({ deleted: out.deleted, rejected: out.rejected.length }),
        },
        () => redeem.deleteCodes(API_ACTOR, ids),
      )
      sendJson(host, req, res, 200, {
        deleted: result.deleted,
        rejected: result.rejected.map((item) => ({ id: item.id, reason: item.reason })),
      })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'POST', 'DELETE'])
    return
  }

  if (parts.length === 3 && parts[2] === 'status') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const body = await jsonBody(host, req)
    assertOnlyKeys(body, ['id', 'status'])
    const id = requiredString(body, 'id')
    const status = requiredString(body, 'status')
    if (status !== 'enabled' && status !== 'disabled') {
      throw badRequest('status 只能是 enabled / disabled')
    }
    sendJson(host, 
      req,
      res,
      200,
      redeemCodeOf(
        await audited(
          host.runtime,
          identity,
          {
            action: 'redeem.code.status',
            targetType: 'redeem-code',
            targetId: id,
            summary: `把兑换码 ${id} 改为 ${status}`,
            metadata: { status },
          },
          () => redeem.setCodeStatus(API_ACTOR, id, status),
        ),
      ),
    )
    return
  }

  if (parts.length === 3 && parts[2] === 'resolve') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const body = await jsonBody(host, req)
    assertOnlyKeys(body, ['id', 'outcome'])
    const id = requiredString(body, 'id')
    const outcome = requiredString(body, 'outcome')
    if (outcome !== 'used' && outcome !== 'enabled') {
      throw badRequest('outcome 只能是 used / enabled')
    }
    sendJson(host, 
      req,
      res,
      200,
      redeemCodeOf(
        await audited(
          host.runtime,
          identity,
          {
            action: 'redeem.code.resolve',
            targetType: 'redeem-code',
            targetId: id,
            // 人工核查影响「这张码还能不能再加钱」，属于高危：失败也记。
            summary: `人工核查兑换码 ${id}：${outcome === 'used' ? '标记为已用' : '退回可用'}`,
            metadata: { outcome },
          },
          () => redeem.resolveRedeeming(API_ACTOR, id, outcome),
        ),
      ),
    )
    return
  }

  throw notFound('没有这个兑换码接口')
}

/** 管理面：批次列表与单个批次。 */
export async function routeAdminRedeemBatches(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
parts: readonly string[],
url: URL,
): Promise<void> {
  await requireAdmin(host, req)
  if (!allowRead(host, req, res)) return
  const redeem = host.requireRedeem()

  if (parts.length === 2) {
    const limit = parseIntegerParam(url.searchParams.get('limit'), 'limit', 50, 1, 200)
    const offset = parseIntegerParam(url.searchParams.get('offset'), 'offset', 0, 0, 10_000_000)
    const batches = await redeem.listBatches(API_ACTOR, {
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
    })
    sendJson(host, req, res, 200, { items: batches.map(redeemBatchOf) })
    return
  }
  if (parts.length === 3) {
    const id = parts[2] as string
    sendJson(host, req, res, 200, redeemBatchOf(await redeem.getBatch(API_ACTOR, id)))
    return
  }
  throw notFound('没有这个批次接口')
}

/** 管理面：兑换码统计。 */
export async function routeAdminRedeemStats(
host: ApiServer,
req: IncomingMessage,
res: ServerResponse,
): Promise<void> {
  await requireAdmin(host, req)
  if (!allowRead(host, req, res)) return
  const redeem = host.requireRedeem()
  sendJson(host, req, res, 200, redeemStatsOf(await redeem.stats(API_ACTOR)))
}
