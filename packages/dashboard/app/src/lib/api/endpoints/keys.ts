/**
 * API key 端点（用户侧）。
 *
 * **一次性 secret 的纪律**：`create` / `rotate` 的响应里有完整 key，
 * 它**只在这一次响应里出现**——前端必须只展示一次（用户复制走），
 * **不许落 localStorage / sessionStorage / URL**，也不许写进日志。
 * 列表接口返回的是 `maskedKey`（掩码），不是完整 key。
 */
import type { ApiClient } from '../client.ts'
import type { ApiKeySummaryView, CreatedApiKeyView, KeyListView } from '../types.ts'

/** `GET /api/keys`：列出我的 key（掩码）。 */
export function listKeys(client: ApiClient): Promise<KeyListView> {
  return client.request<KeyListView>('/api/keys')
}

/**
 * `POST /api/keys`：新建 key。
 *
 * 返回里带 `secret`（完整 key）——**只此一次**，用完即弃。
 */
export function createKey(
  client: ApiClient,
  input: { readonly name: string },
): Promise<CreatedApiKeyView> {
  return client.request<CreatedApiKeyView>('/api/keys', { method: 'POST', body: input })
}

/**
 * `PATCH /api/keys/:id`：改名 / 启停 / 三个执行面上限。
 *
 * 上限语义：`expiresAt` = null 表示永不过期；`spendingLimitMicros` = null 表示不限；
 * `concurrencyLimit` = null 表示不限。**金额是十进制字符串**（微元），
 * 不能传 JSON number（会丢 >2^53 的精度）。
 */
export function updateKey(
  client: ApiClient,
  id: string,
  patch: {
    readonly name?: string
    readonly enabled?: boolean
    readonly expiresAt?: string | null
    readonly spendingLimitMicros?: string | null
    readonly concurrencyLimit?: number | null
  },
): Promise<ApiKeySummaryView> {
  return client.request<ApiKeySummaryView>(`/api/keys/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  })
}

/** `POST /api/keys/:id/rotate`：轮换密钥，返回新的完整 key（**只此一次**）。 */
export function rotateKey(client: ApiClient, id: string): Promise<CreatedApiKeyView> {
  return client.request<CreatedApiKeyView>(`/api/keys/${encodeURIComponent(id)}/rotate`, {
    method: 'POST',
  })
}

/** `DELETE /api/keys/:id`：删除。 */
export function deleteKey(client: ApiClient, id: string): Promise<{ readonly removed: boolean }> {
  return client.request<{ readonly removed: boolean }>(`/api/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
