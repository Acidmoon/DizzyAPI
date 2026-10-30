/**
 * 用量端点（用户侧）。
 *
 * 分页是 **keyset**：`records.nextCursor` 就是要传的 `cursor`（整数），
 * 不是 offset。下一页的请求带 `cursor=<nextCursor>` 即可。
 *
 * 时间窗口由 `range` 决定（`7d` / `30d` / `90d`），服务端按**本地时区的当天
 * 00:00** 算起止，返回 `from` / `to`（`YYYY-MM-DD`）。
 */
import type { ApiClient } from '../client.ts'
import type { UsageDetailView, UsageExportView, UsageView } from '../types.ts'

/** 用量的筛选条件。 */
export interface UsageFilters {
  /** 时间维度：`7d` / `30d` / `90d`（默认 `30d`）。 */
  readonly range?: '7d' | '30d' | '90d'
  /** 按 API key 过滤。 */
  readonly apiKeyId?: string
  /** 按模型过滤。 */
  readonly model?: string
  /** keyset 游标（上一页的 `nextCursor`）。 */
  readonly cursor?: number
  /** 每页条数（服务端上限 200，默认 20）。 */
  readonly limit?: number
}

/** `GET /api/usage`：概览 + 明细第一页。 */
export function fetchUsage(client: ApiClient, filters: UsageFilters = {}): Promise<UsageView> {
  return client.request<UsageView>('/api/usage', { query: { ...filters } })
}

/**
 * `GET /api/usage/:reqId`：单条用量详情（详情弹窗用）。
 *
 * **查不到与「不是自己的」返回同一个 404**——前端不要据此猜「记录是否存在」。
 */
export function fetchUsageDetail(client: ApiClient, reqId: string): Promise<UsageDetailView> {
  return client.request<UsageDetailView>(`/api/usage/${encodeURIComponent(reqId)}`)
}

/**
 * `GET /api/usage/export`：导出 CSV。
 *
 * 服务端回 JSON `{ filename, content }`（不是文件流），浏览器自己拼 Blob 下载。
 * 这样 HTTP 层不必区分「下载 / 错误信封」，CSV 也不会被当 JSON 解析。
 */
export function exportUsage(client: ApiClient, filters: UsageFilters = {}): Promise<UsageExportView> {
  return client.request<UsageExportView>('/api/usage/export', { query: { ...filters } })
}
