/**
 * 管理员 · 客户端指纹档案（`/api/admin/client-masks`）。
 *
 * 数据在 `packages/client-mask`（唯一写者）；这里是管理面的读写端点。
 *
 * 三条口径：
 * - **档案里没有秘密**：只有头名与头值模板（`{{uuid}}` / `{{session}}` / `{{timestamp}}`），
 *   受保护头（鉴权 / Host / Accept / Content-Type / UA / Cookie）服务端一律拒；
 * - 写面要求管理员会话，服务端按 `adminPlugins` 白名单判 actor，页面不用管；
 * - 删除只对**自定义**档案可用：内置只能停用或改，`reset` 恢复出厂。
 */
import type { ApiClient } from '../client.ts'

/** 一个要贴到上游请求上的头。 */
export interface ClientHeaderView {
  readonly name: string
  readonly value: string
}

/** 一套客户端指纹档案。 */
export interface ClientProfileView {
  readonly id: string
  readonly label: string
  readonly description: string | null
  readonly enabled: boolean
  readonly userAgent: string | null
  readonly headers: readonly ClientHeaderView[]
  /** 内置预置：可改、可停用、可 `reset`，**不能删**。 */
  readonly builtin: boolean
}

/** 页面顶部那几个数字。 */
export interface ClientMaskStatusView {
  readonly enabled: boolean
  readonly profiles: number
  readonly enabledProfiles: number
  readonly builtin: number
  readonly custom: number
  readonly storage: string
}

/** 写面入参（新建 / 全量替换）。 */
export interface ClientProfileInputView {
  readonly id: string
  readonly label?: string
  readonly description?: string | null
  readonly enabled?: boolean
  readonly userAgent?: string | null
  readonly headers?: readonly ClientHeaderView[]
}

/** 写面入参（局部修改）：省略 = 不改，`null` = 清空。 */
export interface ClientProfilePatchView {
  readonly label?: string
  readonly description?: string | null
  readonly enabled?: boolean
  readonly userAgent?: string | null
  readonly headers?: readonly ClientHeaderView[]
}

/** `GET /api/admin/client-masks`：全部档案（含被禁用的）+ 排障数字。 */
export function listClientMasks(
  client: ApiClient,
): Promise<{ readonly items: readonly ClientProfileView[]; readonly status: ClientMaskStatusView }> {
  return client.request('/api/admin/client-masks')
}

/** `POST /api/admin/client-masks`：新建或全量替换一个档案。 */
export function createClientMask(
  client: ApiClient,
  input: ClientProfileInputView,
): Promise<{ readonly profile: ClientProfileView }> {
  return client.request('/api/admin/client-masks', { method: 'POST', body: input })
}

/** `PATCH /api/admin/client-masks/:id`：只改几个键。 */
export function updateClientMask(
  client: ApiClient,
  id: string,
  patch: ClientProfilePatchView,
): Promise<{ readonly profile: ClientProfileView }> {
  return client.request(`/api/admin/client-masks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  })
}

/** `DELETE /api/admin/client-masks/:id`：删自定义档案（内置会被服务端拒）。 */
export function deleteClientMask(
  client: ApiClient,
  id: string,
): Promise<{ readonly removed: boolean }> {
  return client.request(`/api/admin/client-masks/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** `POST /api/admin/client-masks/:id/reset`：内置预置恢复出厂。 */
export function resetClientMask(
  client: ApiClient,
  id: string,
): Promise<{ readonly profile: ClientProfileView }> {
  return client.request(`/api/admin/client-masks/${encodeURIComponent(id)}/reset`, {
    method: 'POST',
    body: {},
  })
}
