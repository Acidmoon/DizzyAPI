/**
 * 用户侧数据层（阶段 4 页面私有）。**只调 `/api/*`，不碰存储、不直连 SQLite / JSON。**
 *
 * 三条纪律：
 *
 * 1. 每个请求都带 `X-Requested-With: dizzyapi`。这是 `api` 插件独立与会话的一个开关
 *    （`packages/api/src/http.ts`），**漏了就是 403**，且它与登录态无关——登录页也得带。
 * 2. `credentials: 'include'`：同源 + `dizzyapi_session`（HttpOnly）才能被带上。
 * 3. 错误体是 `{ error: { code, message, requestId } }`（HTTP 状态码同时有效），
 *    统一解析成 `ApiError`，页面按 `code` 分支；**不把 message 直接当机密**，
 *    但这层不额外拼服务端原文之外的任何东西。
 *
 * TODO(契约): `交互` 的 `packages/dashboard/src/lib/api/client.ts` 合进来后，
 * 本文件的 `apiRequest` 应改成复用它（薄封装），页面调用点不用动。
 */

import type {
  ApiKeyPatch,
  ApiKeySummary,
  ApiKeyWithSecret,
  ModelPrice,
  PricingResponse,
  SessionResponse,
  UsageDetail,
  UsageQuery,
  UsageRange,
  UsageResponse,
} from './types'
import { LOGIN_PATH, keysPath, usageDetailPath, usageExportPath as buildUsageExportPath, usagePath } from './paths'

export { LOGIN_PATH }

/** `api` 插件的独立开关（与会话无关，GET 也要带）。 */
const REQUESTED_WITH = 'dizzyapi'

/** 单请求超时：用量列表在数据量大时会慢，15s 足够且不会把用户吊死。 */
const TIMEOUT_MS = 15_000


/** 请求失败的结构化错误：`code` 是稳定码，`status` 是 HTTP 状态。 */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly requestId: string | null

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.requestId = requestId
  }

  /** 未登录 / 会话过期：页面统一跳登录页，不自己弹「密码错误」之类。 */
  get unauthenticated(): boolean {
    return this.status === 401
  }

  /** 无权限（管理面接口）——用户侧页面不该出现，出现就是 bug。 */
  get forbidden(): boolean {
    return this.status === 403 && this.code === 'API_HOST_FORBIDDEN'
  }
}


/**
 * 一个 JSON 请求。`body` 存在时自动 `POST/PATCH` 之外还负责序列化；
 * 空响应（204）返回 `undefined`，页面不需要为它特判。
 */
export async function apiRequest<T>(
  path: string,
  init?: { readonly method?: string; readonly body?: unknown },
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const method = init?.method ?? (init?.body === undefined ? 'GET' : 'POST')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Requested-With': REQUESTED_WITH,
  }
  if (init?.body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const response = await fetch(path, {
      method,
      credentials: 'include',
      headers,
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    })
    const text = await response.text()
    const payload: unknown = text === '' ? undefined : safeJson(text)
    if (!response.ok) throw errorOf(response.status, payload)
    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError(0, 'CLIENT_TIMEOUT', '请求超时，请稍后重试')
    }
    throw new ApiError(0, 'CLIENT_NETWORK', '网络异常，请检查连接后重试')
  } finally {
    clearTimeout(timer)
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** 把 `{ error: { code, message, requestId } }` 解析成结构化错误；形状不对也给稳定兜底码。 */
function errorOf(status: number, payload: unknown): ApiError {
  const envelope = payload as { error?: { code?: unknown; message?: unknown; requestId?: unknown } } | undefined
  const details = envelope?.error
  const code = typeof details?.code === 'string' && details.code !== '' ? details.code : `HTTP_${status}`
  const message = typeof details?.message === 'string' && details.message !== '' ? details.message : `请求失败（${status}）`
  const requestId = typeof details?.requestId === 'string' ? details.requestId : null
  return new ApiError(status, code, message, requestId)
}

/** 未登录 / 会话过期 → 整页跳登录页（`replace` 不留返回历史）。 */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return
  window.location.replace(LOGIN_PATH)
}

/** 统一的人话错误文案：`ApiError` 用服务端 message，其余用兜底。 */
export function messageOfError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return '未知错误，请稍后重试'
}

// ───────────────────────────────── 会话 ─────────────────────────────────

export function fetchSession(): Promise<SessionResponse> {
  return apiRequest<SessionResponse>('/api/session')
}

// ───────────────────────────────── 用量 ─────────────────────────────────

/** `GET /api/usage`：普通用户恒为「自己」的口径（不带 userId，服务端按会话收敛）。 */
export function fetchUsage(query: UsageQuery): Promise<UsageResponse> {
  return apiRequest<UsageResponse>(usagePath(query))
}

/** `GET /api/usage/:reqId`：单条详情（查不到与「不是自己的」同一个 404）。 */
export async function fetchUsageDetail(reqId: string): Promise<UsageDetail> {
  const response = await apiRequest<{ record: UsageDetail }>(usageDetailPath(reqId))
  return response.record
}

/**
 * `GET /api/usage/export` 的地址（JSON `{filename, content}`）。
 *
 * 页面拿到后自己拼 `Blob` 触发下载；**不新开路由、不改 api 契约**（阶段 0 的口径）。
 * 查询串的拼装本身在 `paths.ts`（纯字符串、可被 node 测试逐字断言）。
 */
export const usageExportPath = buildUsageExportPath

export interface UsageCsv {
  readonly filename: string
  readonly content: string
}

/** 导出并下载（浏览器侧）：CSV 正文由 `usage` 插件出，前端只负责落地成文件。 */
export async function downloadUsageCsv(query: Omit<UsageQuery, 'cursor' | 'limit'>): Promise<void> {
  const result = await apiRequest<UsageCsv>(usageExportPath(query))
  const blob = new Blob([result.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // 立刻撤销会让部分浏览器取消下载，等一拍再回收。
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

// ───────────────────────────────── API key ─────────────────────────────────

export async function fetchKeys(): Promise<ApiKeySummary[]> {
  const response = await apiRequest<{ items: ApiKeySummary[] }>('/api/keys')
  return response.items
}

/** 新建：响应当次带一次性明文 `secret`，此后任何接口都不再返回它。 */
export function createKey(name: string): Promise<ApiKeyWithSecret> {
  return apiRequest<ApiKeyWithSecret>('/api/keys', { body: { name } })
}

export function updateKey(id: string, patch: ApiKeyPatch): Promise<ApiKeySummary> {
  return apiRequest<ApiKeySummary>(`/api/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
}

export function removeKey(id: string): Promise<{ removed: boolean }> {
  return apiRequest<{ removed: boolean }>(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 轮换：同样只此一次返回明文新 key。 */
export function rotateKey(id: string): Promise<ApiKeyWithSecret> {
  return apiRequest<ApiKeyWithSecret>(`/api/keys/${encodeURIComponent(id)}/rotate`, { method: 'POST', body: {} })
}

// ───────────────────────────────── 价格（只读） ─────────────────────────────────

export async function fetchPricing(): Promise<readonly ModelPrice[]> {
  const response = await apiRequest<PricingResponse>('/api/pricing')
  return response.items
}

/** 用量区间的人话标题（三档与 `USAGE_RANGE_DAYS` 一一对应）。 */
export const RANGE_LABELS: Readonly<Record<UsageRange, string>> = {
  '7d': '近 7 天',
  '30d': '近 30 天',
  '90d': '近 90 天',
}
