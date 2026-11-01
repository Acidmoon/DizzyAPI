/**
 * 管理面 · 客户端指纹档案（`/api/admin/client-masks`）。
 *
 * owner 2026-11-01 的诉求是「上游请求要能伪装成指定客户端」，档案本身在
 * `packages/client-mask` 里（唯一写者），这里只做 HTTP 门面：
 *
 * - `GET` → `{ items, status }`：全部档案（含被禁用的）+ 排障数字；
 * - `POST` → 新建或全量替换（`id` 必填）；
 * - `PATCH .../<id>` → 只改几个键（`null` = 清空 description / userAgent）；
 * - `DELETE .../<id>` → 删**自定义**档案（内置只能停用或改，插件会拒）；
 * - `POST .../<id>/reset` → 内置预置恢复出厂。
 *
 * 三条纪律：
 * - **语义校验全在插件里**（受保护头 / 三个占位符 / 头值不许有控制符 / 不许像秘密），
 *   这里只做形状校验，插件抛的稳定码由 `toApiError` 映射；
 * - **审计只记 id 与字段名**：档案里是头模板，不是秘密，但也没必要把整份头抄进审计表；
 * - 读面照旧挡非 GET（`allowRead`）；写面走 `audited(...)`，actor 只有这里知道。
 */
import type { ApiServer } from '../http.ts'
import type { ClientMaskPort, ClientProfileLike } from '../types-client-mask.ts'
import { API_ACTOR } from '../constants.ts'
import { auditActorOf, audited } from '../audit.ts'
import { ApiError, badRequest, notFound } from '../errors.ts'
import { assertOnlyKeys } from '../params.ts'
import { requireAdmin } from '../http_session.ts'
import {
  allowMethod,
  allowRead,
  jsonBody,
  sendJson,
  sendMethodNotAllowed,
} from '../http_respond.ts'
import {
  clientMaskInputOf,
  clientMaskPatchOf,
  clientMaskStatusOf,
  clientProfileOf,
} from '../views/client-mask.ts'
import { IncomingMessage, ServerResponse } from 'node:http'

/** 写面支持的全部键（读面用不到，但两边共用一份免得漂移）。 */
const PROFILE_FIELDS = ['label', 'description', 'enabled', 'userAgent', 'headers'] as const

/** 服务缺席时明确 503（入口本身照常存活，账号页只是选不到档案）。 */
function requireClientMask(host: ApiServer): ClientMaskPort {
  const clientMask = host.runtime.clientMask()
  if (clientMask === undefined) {
    throw new ApiError('CLIENT_MASK_UNAVAILABLE', 503, '客户端指纹档案插件不在运行')
  }
  return clientMask
}

export async function routeAdminClientMasks(
  host: ApiServer,
  req: IncomingMessage,
  res: ServerResponse,
  parts: readonly string[],
): Promise<void> {
  const { view: adminView } = await requireAdmin(host, req)
  const identity = { actor: auditActorOf(adminView), actorPlugin: API_ACTOR }
  const clientMask = requireClientMask(host)

  if (parts.length === 2) {
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!allowRead(host, req, res)) return
      sendJson(host, req, res, 200, {
        items: clientMask.list().map(clientProfileOf),
        status: clientMaskStatusOf(clientMask.status()),
      })
      return
    }
    if (req.method === 'POST') {
      const upsert = clientMask.upsert
      if (typeof upsert !== 'function') {
        throw new ApiError('CLIENT_MASK_WRITE_UNAVAILABLE', 503, '客户端档案服务不支持写入')
      }
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, ['id', ...PROFILE_FIELDS])
      const input = clientMaskInputOf(body) as { id: unknown }
      const profile = await audited<ClientProfileLike>(
        host.runtime,
        identity,
        {
          action: 'client_mask.create',
          targetType: 'client-profile',
          targetId: typeof input.id === 'string' ? input.id : undefined,
          summary: `新建 / 覆盖客户端档案 ${String(input.id)}`,
          metadata: { fields: Object.keys(body).filter((key) => key !== 'id') },
        },
        async () => clientProfileOf(await upsert.call(clientMask, API_ACTOR, input)),
      )
      sendJson(host, req, res, 200, { profile })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'POST'])
    return
  }

  // `reset` 是固定子路径；档案 id 由页面/插件约束，不会与它撞车。
  if (parts.length === 4 && parts[3] === 'reset') {
    if (!allowMethod(host, req, res, ['POST'])) return
    const reset = clientMask.reset
    if (typeof reset !== 'function') {
      throw new ApiError('CLIENT_MASK_WRITE_UNAVAILABLE', 503, '客户端档案服务不支持恢复出厂')
    }
    const id = parts[2] as string
    const profile = await audited<ClientProfileLike>(
      host.runtime,
      identity,
      {
        action: 'client_mask.reset',
        targetType: 'client-profile',
        targetId: id,
        summary: `恢复客户端档案 ${id} 的出厂值`,
      },
      async () => clientProfileOf(await reset.call(clientMask, API_ACTOR, id)),
    )
    sendJson(host, req, res, 200, { profile })
    return
  }

  if (parts.length === 3) {
    const id = parts[2] as string
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!allowRead(host, req, res)) return
      const profile = clientMask.get(id)
      if (profile === undefined) throw notFound('没有这个客户端档案')
      sendJson(host, req, res, 200, { profile: clientProfileOf(profile) })
      return
    }
    if (req.method === 'PATCH') {
      const update = clientMask.update
      if (typeof update !== 'function') {
        throw new ApiError('CLIENT_MASK_WRITE_UNAVAILABLE', 503, '客户端档案服务不支持写入')
      }
      const body = await jsonBody(host, req)
      assertOnlyKeys(body, PROFILE_FIELDS)
      const patch = clientMaskPatchOf(body) as Record<string, unknown>
      const fields = Object.keys(patch)
      if (fields.length === 0) throw badRequest('没有可修改的字段')
      const profile = await audited<ClientProfileLike>(
        host.runtime,
        identity,
        {
          action: 'client_mask.update',
          targetType: 'client-profile',
          targetId: id,
          summary: `修改客户端档案 ${id} 的字段：${fields.join(' / ')}`,
          metadata: { fields },
        },
        async () => clientProfileOf(await update.call(clientMask, API_ACTOR, id, patch)),
      )
      sendJson(host, req, res, 200, { profile })
      return
    }
    if (req.method === 'DELETE') {
      const remove = clientMask.remove
      if (typeof remove !== 'function') {
        throw new ApiError('CLIENT_MASK_WRITE_UNAVAILABLE', 503, '客户端档案服务不支持删除')
      }
      await audited<unknown>(
        host.runtime,
        identity,
        {
          action: 'client_mask.remove',
          targetType: 'client-profile',
          targetId: id,
          summary: `删除客户端档案 ${id}`,
        },
        () => remove.call(clientMask, API_ACTOR, id),
      )
      sendJson(host, req, res, 200, { removed: true })
      return
    }
    sendMethodNotAllowed(host, req, res, ['GET', 'HEAD', 'PATCH', 'DELETE'])
    return
  }

  throw notFound('没有这个客户端档案接口')
}
