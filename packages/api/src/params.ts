/**
 * params.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { ApiError, badRequest } from './errors.ts'


export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item))
}


export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}


export function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}


export function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} 必须是非空字符串`)
  return value
}


export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} 必须是非空字符串`)
  return value
}


export function nullableString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key]
  if (value === null) return null
  if (typeof value !== 'string' || value.trim() === '') throw badRequest(`${key} 必须是非空字符串或 null`)
  return value
}


/** 只做形状校验：数组且元素都是字符串。语义（trim / 去重 / 上限）由 identity 归一化。 */
export function readStringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw badRequest(`${key} 必须是字符串数组`)
  for (const item of value) {
    if (typeof item !== 'string') throw badRequest(`${key} 的元素必须是字符串`)
  }
  return value as string[]
}


/** 只做形状校验：对象且值都是字符串。 */
export function readStringMap(value: unknown, key: string): Record<string, string> {
  if (!isPlainObject(value)) throw badRequest(`${key} 必须是 JSON 对象`)
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== 'string') throw badRequest(`${key}.${entryKey} 必须是字符串`)
  }
  return value as Record<string, string>
}


/** 没给（或给了 null）→ `undefined`（新建时等同未声明）。 */
export function optionalStringArray(body: Record<string, unknown>, key: string): string[] | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  return readStringArray(value, key)
}


export function optionalStringMap(body: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  return readStringMap(value, key)
}


/** PATCH 里区分「没给」与「给了 null」：`null` 表示清空为未声明。 */
export function nullableStringArray(body: Record<string, unknown>, key: string): string[] | null {
  const value = body[key]
  if (value === null) return null
  return readStringArray(value, key)
}


export function nullableStringMap(body: Record<string, unknown>, key: string): Record<string, string> | null {
  const value = body[key]
  if (value === null) return null
  return readStringMap(value, key)
}


export function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = body[key]
  if (typeof value !== 'boolean') throw badRequest(`${key} 必须是布尔值`)
  return value
}


/** 必填的正整数（并发上限这类「小的运营限流」用它；金额走十进制字符串）。 */
export function requiredInteger(body: Record<string, unknown>, key: string): number {
  const value = body[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw badRequest(`${key} 必须是正整数`)
  }
  return value
}


export function optionalInteger(
  body: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw badRequest(`${key} 必须是 ${min}..${max} 的整数`)
  }
  return value
}


/**
 * 金额入参：只接受十进制整数微元（字符串或安全整数），**绝不经过浮点解析**。
 * 1 元 = 1_000_000 微元；传 `"5"` 表示 5 微元，不是 5 元。
 */
export function requiredMicros(body: Record<string, unknown>, key: string): bigint {
  const value = body[key]
  let text: string
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    text = value.trim()
  } else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    text = String(value)
  } else {
    throw badRequest(`${key} 必须是正整数微元的十进制字符串（1 元 = 1000000 微元）`)
  }
  return BigInt(text)
}


export const AVATAR_MAX_BYTES = 256 * 1024

export const AVATAR_URL_MAX_LENGTH = 2048

export const AVATAR_DATA_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/i


/**
 * 头像与 user 插件的约定对齐：
 * - `http(s)://` URL，长度 ≤ 2048；
 * - `image/png|jpeg|webp|gif` 的 base64 data URL，**解码后** ≤ 256 KiB；
 * - 其他 scheme / MIME 一律拒绝。
 *
 * 注意：CSP 只放行 `https:` 外链；`http:` 头像能存进用户表，但浏览器会按 CSP 拦下。
 */
export function optionalAvatar(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value === '') {
    throw badRequest('avatar 必须是 data URL、http(s) URL 或 null')
  }

  if (value.startsWith('data:')) {
    const match = AVATAR_DATA_RE.exec(value)
    if (match === null) {
      throw badRequest('avatar 必须是 png / jpeg / webp / gif 的 base64 data URL')
    }
    const decoded = Buffer.from(match[2] as string, 'base64')
    if (decoded.length > AVATAR_MAX_BYTES) {
      throw new ApiError('API_BODY_TOO_LARGE', 413, '头像解码后不能超过 256 KiB')
    }
    return value
  }

  if (value.length > AVATAR_URL_MAX_LENGTH) {
    throw badRequest(`avatar URL 最长 ${AVATAR_URL_MAX_LENGTH} 个字符`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw badRequest('avatar 必须是合法的 http(s) URL 或 data URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('avatar 只支持 http / https / data URL')
  }
  return value
}


export function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw badRequest(`不支持字段：${key}`)
  }
}


export function parseIntegerParam(
  value: string | null,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === null || value === '') return fallback
  if (!/^\d+$/.test(value)) throw badRequest(`${name} 必须是非负整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest(`${name} 必须在 ${min}..${max} 之间`)
  }
  return parsed
}


export function queryStringOf(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null || value === '' ? undefined : value
}


export function parsePositiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw badRequest(`${name} 必须是正整数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw badRequest(`${name} 必须是正整数`)
  return parsed
}


/**
 * 新建账号时的可选凭据。只做形状校验；格式识别与秘密落库由 account-admin /
 * identity 负责，HTTP 层不解析、不回显 payload。
 */
export function accountCredentialOf(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) throw badRequest('credential 必须是对象')
  assertOnlyKeys(value, ['payload', 'format', 'provider', 'kind'])
  const payload = value.payload
  if (typeof payload !== 'string' && !isPlainObject(payload)) {
    throw badRequest('credential.payload 必须是字符串或 JSON 对象')
  }
  if (typeof payload === 'string' && payload.trim() === '') {
    throw badRequest('credential.payload 不能为空')
  }
  const format = optionalString(value, 'format')
  const provider = optionalString(value, 'provider')
  const kind = optionalString(value, 'kind')
  return {
    payload,
    ...(format === undefined ? {} : { format }),
    ...(provider === undefined ? {} : { provider }),
    ...(kind === undefined ? {} : { kind }),
  }
}


/**
 * 上游账号**元数据**可改字段（不含 `enabled`）。
 *
 * `enabled` 刻意不在这个集合里：启停走 `accountAdmin.enable / disable` 这两条独立通道，
 * 与「改字段」是两笔独立审计（`account.update` vs `account.enable / account.disable`）。
 * 混在一起会出现「改名字顺带把账号启用了」这种审计上看不出来的副作用。
 */
export const ACCOUNT_PATCH_FIELDS = [
  'label',
  'email',
  'subject',
  'baseUrl',
  'protocol',
  'models',
  'modelMap',
  'priority',
] as const

/** 上游账号元数据补丁；只含**真的给了**的键。 */
export interface AccountPatchInput {
  label?: string
  email?: string | null
  subject?: string | null
  baseUrl?: string | null
  protocol?: string | null
  models?: string[] | null
  modelMap?: Record<string, string> | null
  priority?: number
}

/**
 * 从请求体里取出账号元数据补丁（`PATCH /api/accounts/:id` 与 `POST /api/accounts/bulk`
 * 的 `patch` 共用同一套字段口径，避免两条路径慢慢漂移）。
 *
 * **不**自己 `assertOnlyKeys`：单条 PATCH 允许带 `enabled`、批量 patch 不允许，
 * 键集合由调用方按场景挡。
 */
export function accountPatchOf(body: Record<string, unknown>): AccountPatchInput {
  const patch: AccountPatchInput = {}
  if (Object.hasOwn(body, 'label')) patch.label = requiredString(body, 'label')
  if (Object.hasOwn(body, 'email')) patch.email = nullableString(body, 'email')
  if (Object.hasOwn(body, 'subject')) patch.subject = nullableString(body, 'subject')
  if (Object.hasOwn(body, 'baseUrl')) patch.baseUrl = nullableString(body, 'baseUrl')
  if (Object.hasOwn(body, 'protocol')) patch.protocol = nullableString(body, 'protocol')
  if (Object.hasOwn(body, 'models')) patch.models = nullableStringArray(body, 'models')
  if (Object.hasOwn(body, 'modelMap')) patch.modelMap = nullableStringMap(body, 'modelMap')
  if (Object.hasOwn(body, 'priority')) patch.priority = optionalInteger(body, 'priority', 0, 1000)
  return patch
}


export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : undefined
}
