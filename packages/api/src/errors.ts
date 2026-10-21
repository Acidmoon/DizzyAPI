/**
 * 产品 HTTP 入口的稳定错误码。
 *
 * HTTP 层只做两件事：把领域错误映射成状态码，把错误信封写成
 * `{ error: { code, message, requestId } }`。下游插件自己的 code 原样透出，
 * 因为调用方（前端 / 脚本）就是按 code 分支的。
 */
export type ApiErrorCode =
  | 'API_CONFIG_INVALID'
  | 'API_HOST_FORBIDDEN'
  | 'API_ORIGIN_FORBIDDEN'
  | 'API_REQUEST_HEADER_REQUIRED'
  | 'API_UNAUTHORIZED'
  | 'API_FORBIDDEN'
  | 'API_BAD_REQUEST'
  | 'API_NOT_FOUND'
  | 'API_METHOD_NOT_ALLOWED'
  | 'API_BODY_TOO_LARGE'
  | 'API_INVALID_JSON'
  | 'API_INTERNAL'
  | 'API_RESPONSE_INVALID'
  | 'FRONTEND_UNAVAILABLE'
  | 'CATALOG_UNAVAILABLE'
  | 'ACCOUNT_ADMIN_UNAVAILABLE'
  | 'API_KEY_UNAVAILABLE'
  | 'API_PROFILE_UNAVAILABLE'
  | 'API_USER_ROLE_UNAVAILABLE'
  | 'API_USER_BALANCE_ENABLED_UNAVAILABLE'
  | 'API_ACCOUNT_IMPORT_UNAVAILABLE'
  | 'API_ACCOUNT_TEST_UNAVAILABLE'
  | 'API_ACCOUNT_CREATE_UNAVAILABLE'
  | 'API_SETTINGS_UNAVAILABLE'
  | 'TOPUP_NOT_IMPLEMENTED'

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: unknown

  constructor(code: ApiErrorCode | string, status: number, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}

export function badRequest(message: string): ApiError {
  return new ApiError('API_BAD_REQUEST', 400, message)
}

export function unauthorized(message = '需要登录后才能访问'): ApiError {
  return new ApiError('API_UNAUTHORIZED', 401, message)
}

export function forbidden(message = '当前账号没有管理员权限'): ApiError {
  return new ApiError('API_FORBIDDEN', 403, message)
}

export function notFound(message = '没有这个接口'): ApiError {
  return new ApiError('API_NOT_FOUND', 404, message)
}

/**
 * 下游插件的 code → HTTP 状态码。
 *
 * 先查显式表，再按后缀兜底。兜底默认 500：未知的内部错误不能伪装成
 * 「用户输入有问题」，否则排障会被 400 误导。
 */
const EXPLICIT_STATUS: Readonly<Record<string, number>> = {
  AUTH_CODE_INVALID: 400,
  AUTH_EMAIL_INVALID: 400,
  AUTH_PASSWORD_WEAK: 400,
  AUTH_CREDENTIALS_INVALID: 401,
  AUTH_SESSION_INVALID: 401,
  AUTH_SESSION_EXPIRED: 401,
  AUTH_USER_MISSING: 401,
  AUTH_USER_BANNED: 403,
  AUTH_RATE_LIMITED: 429,
  AUTH_CODE_ATTEMPTS_EXCEEDED: 429,
  AUTH_EMAIL_TAKEN: 409,
  AUTH_NAME_UNAVAILABLE: 409,
  AUTH_MAIL_FAILED: 502,
  AUTH_DEPENDENCY_MISSING: 503,
  USER_NAME_TAKEN: 409,
  USER_BALANCE_NOT_ZERO: 409,
  USER_LAST_ADMIN: 409,
  SETTINGS_CONFLICT: 409,
  SETTINGS_TARGET_MISSING: 409,
  SETTINGS_TARGET_DISABLED: 409,
  SETTINGS_TARGET_INACTIVE: 409,
  SETTINGS_NS_UNKNOWN: 404,
  SETTINGS_FIELD_UNKNOWN: 400,
  SETTINGS_FIELD_NOT_WRITABLE: 403,
  API_KEY_LIMIT_REACHED: 409,
  ACCOUNT_ADMIN_IDENTITY_UNAVAILABLE: 503,
  ACCOUNT_ADMIN_IMPORT_CONFLICT: 409,
  ACCOUNT_ADMIN_IMPORT_TOO_LARGE: 413,
  ACCOUNT_ADMIN_UNKNOWN: 500,
  ACCOUNT_TEST_BASE_URL_MISSING: 400,
  ACCOUNT_TEST_PROTOCOL_INVALID: 400,
  ACCOUNT_TEST_MODEL_INVALID: 400,
  ACCOUNT_IMPORT_UNSUPPORTED_TYPE: 400,
  ACCOUNT_IMPORT_UNSUPPORTED_PLATFORM: 400,
  IDENTITY_ACCOUNT_NOT_FOUND: 404,
  IDENTITY_ACCOUNT_INVALID: 400,
  IDENTITY_ACCOUNT_DISABLED: 409,
  IDENTITY_ACCOUNT_NEEDS_REAUTH: 409,
  IDENTITY_CREDENTIAL_INVALID: 400,
  IDENTITY_CREDENTIAL_MISSING: 409,
  IDENTITY_PROVIDER_UNSUPPORTED: 400,
  IDENTITY_REFRESH_FAILED: 502,
  IDENTITY_REFRESH_NOT_SUPPORTED: 400,
  IDENTITY_NOT_READY: 503,
  CREDENTIALS_NOT_READY: 503,
  FRONTEND_ASSET_NOT_FOUND: 404,
  FRONTEND_ASSET_INVALID: 400,
  FRONTEND_ASSET_VERSION_EXISTS: 409,
  FRONTEND_NO_PREVIOUS_VERSION: 409,
  FRONTEND_MANIFEST_INVALID: 500,
  FRONTEND_CONFIG_INVALID: 500,
  CATALOG_PLUGIN_NOT_FOUND: 404,
  CATALOG_QUERY_INVALID: 400,
  CATALOG_INVALID_CONFIG: 500,
}

export function statusOfCode(code: string): number {
  const explicit = EXPLICIT_STATUS[code]
  if (explicit !== undefined) return explicit
  if (/(_INVALID|_REQUIRED|_UNSUPPORTED)$/.test(code)) return 400
  if (/_NOT_FOUND$/.test(code)) return 404
  if (/_FORBIDDEN$/.test(code)) return 403
  if (/(_TAKEN|_CONFLICT|_NOT_ZERO|_LAST_ADMIN|_LIMIT_REACHED|_EXISTS)$/.test(code)) return 409
  if (/(_RATE_LIMITED|_ATTEMPTS_EXCEEDED)$/.test(code)) return 429
  if (/(_UNAVAILABLE|_NOT_READY)$/.test(code)) return 503
  if (/_TOO_LARGE$/.test(code)) return 413
  return 500
}

/**
 * 任意异常 → ApiError。带字符串 code 的领域错误保留 code 与 message；
 * 其余统一成 API_INTERNAL，避免把内部堆栈或请求内容带进响应。
 */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') {
      const message = (error as { message?: unknown }).message
      return new ApiError(
        code,
        statusOfCode(code),
        typeof message === 'string' && message !== '' ? message : code,
      )
    }
  }
  return new ApiError('API_INTERNAL', 500, '内部错误')
}
