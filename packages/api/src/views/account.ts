/**
 * views/account.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { asRecord, isPlainObject } from '../params.ts'
import { ApiError } from '../errors.ts'
import type { AccountViewLike, ApiKeySummaryView } from '../types.ts'


/** `listAll()` 的形状兼容：数组或 `{ items }`；只保留 `enabled` 判定需要的信息。 */
export function keyPortResult(value: unknown): { enabled: boolean }[] {
  const items = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.items)
      ? value.items
      : []
  return items.filter(isPlainObject).map((item) => ({ enabled: item.enabled !== false }))
}


// ───────────────────────────────── 响应归一化 ─────────────────────────────────

export function normalizeKeyList(value: unknown): ApiKeySummaryView[] {
  const items = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.items)
      ? value.items
      : null
  if (items === null) {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务返回了无法识别的列表')
  }
  return items.map(normalizeKeySummary)
}


export function normalizeKeySummary(value: unknown): ApiKeySummaryView {
  const record = asRecord(value)
  if (record === null) {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务返回了无法识别的条目')
  }
  const id = typeof record.id === 'string' ? record.id : null
  if (id === null) throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 条目缺少 id')
  return {
    id,
    name: typeof record.name === 'string' ? record.name : '',
    trackingId: typeof record.trackingId === 'string' ? record.trackingId : '',
    secret: typeof record.secret === 'string' ? record.secret : null,
    maskedKey: typeof record.maskedKey === 'string' ? record.maskedKey : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    lastUsedAt: typeof record.lastUsedAt === 'string' ? record.lastUsedAt : null,
    appManaged: record.appManaged === true,
    enabled: record.enabled !== false,
    // 三个执行面上限：缺省 = 不限（旧实现不返回它们）。
    expiresAt: typeof record.expiresAt === 'string' ? record.expiresAt : null,
    spendingLimitMicros: typeof record.spendingLimitMicros === 'string' ? record.spendingLimitMicros : null,
    concurrencyLimit:
      typeof record.concurrencyLimit === 'number' && record.concurrencyLimit > 0
        ? record.concurrencyLimit
        : null,
  }
}


/**
 * create / rotate 的真实形状是 `{ key: ApiKeyView, secret }`。这里展开成前端契约的
 * 扁平 `CreatedApiKey`；同时兼容旧实现直接返回 `{ ...summary, secret }`。
 */
export function normalizeCreatedKey(value: unknown): ApiKeySummaryView & { secret: string } {
  const record = asRecord(value)
  if (record === null) {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务返回了无法识别的创建结果')
  }
  const summary = normalizeKeySummary(isPlainObject(record.key) ? record.key : record)
  const secret = record.secret
  if (typeof secret !== 'string' || secret === '') {
    throw new ApiError('API_RESPONSE_INVALID', 502, 'API key 服务没有返回一次性 secret')
  }
  return { ...summary, secret }
}


/** 账号响应只挑前端契约里的字段；`credentialRef` / 令牌永远不会出现在响应里。 */
export function accountOf(value: unknown): AccountViewLike {
  const record = asRecord(value)
  if (record === null || typeof record.id !== 'string') {
    throw new ApiError('API_RESPONSE_INVALID', 502, '账号管理服务返回了无法识别的账号')
  }
  return {
    id: record.id,
    provider: typeof record.provider === 'string' ? record.provider : 'custom',
    kind: typeof record.kind === 'string' ? record.kind : 'api_key',
    label: typeof record.label === 'string' ? record.label : '',
    enabled: record.enabled === true,
    status: typeof record.status === 'string' ? record.status : 'active',
    email: typeof record.email === 'string' ? record.email : null,
    subject: typeof record.subject === 'string' ? record.subject : null,
    baseUrl: typeof record.baseUrl === 'string' ? record.baseUrl : null,
    protocol: typeof record.protocol === 'string' ? record.protocol : null,
    models: stringArrayOf(record.models),
    modelMap: stringMapOf(record.modelMap),
    priority: typeof record.priority === 'number' ? record.priority : 0,
    accessExpiresAt: typeof record.accessExpiresAt === 'string' ? record.accessExpiresAt : null,
    refreshDueAt: typeof record.refreshDueAt === 'string' ? record.refreshDueAt : null,
    lastRefreshAt: typeof record.lastRefreshAt === 'string' ? record.lastRefreshAt : null,
    lastError: typeof record.lastError === 'string' ? record.lastError : null,
    failureCount: typeof record.failureCount === 'number' ? record.failureCount : 0,
    backoffUntil: typeof record.backoffUntil === 'string' ? record.backoffUntil : null,
    lastTestAt: typeof record.lastTestAt === 'string' ? record.lastTestAt : null,
    lastTestOk: typeof record.lastTestOk === 'boolean' ? record.lastTestOk : null,
    lastTestError: typeof record.lastTestError === 'string' ? record.lastTestError : null,
    lastTestLatencyMs: typeof record.lastTestLatencyMs === 'number' ? record.lastTestLatencyMs : null,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
  }
}


/** 响应侧的形状归一：非数组 / 含非字符串一律退回 null，不把脏数据透给前端。 */
export function stringArrayOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items: string[] = []
  for (const item of value) {
    if (typeof item === 'string') items.push(item)
  }
  return items
}


export function stringMapOf(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null
  const map: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') map[key] = item
  }
  return map
}


export function normalizeBulkImport(value: unknown): unknown {
  if (!isPlainObject(value)) return value
  const items = Array.isArray(value.items) ? value.items : []
  return {
    ...value,
    items: items.map((item) => {
      if (!isPlainObject(item)) return item
      return {
        ...item,
        account: item.account === null || item.account === undefined ? null : accountOf(item.account),
      }
    }),
  }
}
