/**
 * `/api/*` 的路径与查询串拼装（**纯字符串，不碰 fetch / DOM**）。
 *
 * 单独成文件的两个理由：
 * 1. 路径与查询串是**契约**，要能被 node 测试逐字断言（`packages/dashboard/test/user-api-paths.test.ts`）；
 * 2. 根仓库的 `tsc` 只给 Node 的类型（没有 DOM lib），把 `fetch` / `Blob` 留在一个文件里，
 *    测试就不用把整个浏览器环境拖进类型检查。
 */

import type { UsageQuery } from './types'

/** 未登录时的落点（静态导出的登录页；`trailingSlash: true` 所以带尾斜杠）。 */
export const LOGIN_PATH = '/auth/v2/login/'

/** 空值（undefined / null / 空串）一律不写进查询串，避免后端把 `""` 当成有效筛选。 */
export function queryString(params: Readonly<Record<string, string | number | undefined | null>>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}

/** `GET /api/usage?range=…&apiKeyId=…&model=…&cursor=…&limit=…`。 */
export function usagePath(query: UsageQuery): string {
  return `/api/usage${queryString({
    range: query.range,
    apiKeyId: query.apiKeyId,
    model: query.model,
    cursor: query.cursor,
    limit: query.limit,
  })}`
}

/** `GET /api/usage/:reqId`（reqId 可能含 `+` / `/`，必须编码）。 */
export function usageDetailPath(reqId: string): string {
  return `/api/usage/${encodeURIComponent(reqId)}`
}

/** `GET /api/usage/export?format=csv&…`（分页参数不参与导出：导出是全量）。 */
export function usageExportPath(query: Omit<UsageQuery, 'cursor' | 'limit'>): string {
  return `/api/usage/export${queryString({
    format: 'csv',
    range: query.range,
    apiKeyId: query.apiKeyId,
    model: query.model,
  })}`
}

/** `/api/keys` 与 `/api/keys/<id>`（`rotate` 是 `/api/keys/<id>/rotate`）。 */
export function keysPath(id?: string, action?: 'rotate'): string {
  if (id === undefined) return '/api/keys'
  const base = `/api/keys/${encodeURIComponent(id)}`
  return action === undefined ? base : `${base}/${action}`
}
