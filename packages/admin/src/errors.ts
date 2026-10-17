/**
 * 面板的错误码。做法与 settings / user 一致：稳定的 UPPER_SNAKE 码 + 人能读的中文消息。
 *
 * 每个码都自带一个 HTTP 状态——面板是 HTTP 服务，状态码是它对外契约的一部分，
 * 让路由层再写一张 if/else 表只会两边漂移。
 */
export type AdminErrorCode =
  | 'ADMIN_BOOTSTRAP_TOKEN_INVALID'
  | 'ADMIN_UNAUTHORIZED'
  | 'ADMIN_HOST_INVALID'
  | 'ADMIN_ORIGIN_INVALID'
  | 'ADMIN_REQUEST_HEADER_REQUIRED'
  | 'ADMIN_ROUTE_NOT_FOUND'
  | 'ADMIN_METHOD_NOT_ALLOWED'
  | 'ADMIN_BODY_INVALID'
  | 'ADMIN_BODY_TOO_LARGE'
  | 'ADMIN_PLUGIN_NOT_FOUND'
  | 'ADMIN_PLUGIN_DISABLED'
  | 'ADMIN_PLUGIN_INACTIVE'
  | 'ADMIN_PLUGIN_NOT_RESTARTABLE'
  | 'ADMIN_PLUGIN_AMBIGUOUS'
  | 'ADMIN_PLUGIN_SELF_RESTART'
  | 'ADMIN_RESTART_FAILED'
  | 'ADMIN_SETTINGS_UNAVAILABLE'
  | 'ADMIN_TOO_MANY_SSE_CLIENTS'
  | 'ADMIN_SERVER_CLOSED'
  | 'ADMIN_INTERNAL'

const STATUS: Readonly<Record<AdminErrorCode, number>> = {
  ADMIN_BOOTSTRAP_TOKEN_INVALID: 401,
  ADMIN_UNAUTHORIZED: 401,
  ADMIN_HOST_INVALID: 403,
  ADMIN_ORIGIN_INVALID: 403,
  ADMIN_REQUEST_HEADER_REQUIRED: 403,
  ADMIN_ROUTE_NOT_FOUND: 404,
  ADMIN_METHOD_NOT_ALLOWED: 405,
  ADMIN_BODY_INVALID: 400,
  ADMIN_BODY_TOO_LARGE: 413,
  ADMIN_PLUGIN_NOT_FOUND: 404,
  ADMIN_PLUGIN_DISABLED: 409,
  ADMIN_PLUGIN_INACTIVE: 409,
  ADMIN_PLUGIN_NOT_RESTARTABLE: 409,
  ADMIN_PLUGIN_AMBIGUOUS: 409,
  ADMIN_PLUGIN_SELF_RESTART: 409,
  ADMIN_RESTART_FAILED: 500,
  ADMIN_SETTINGS_UNAVAILABLE: 503,
  ADMIN_TOO_MANY_SSE_CLIENTS: 503,
  ADMIN_SERVER_CLOSED: 503,
  ADMIN_INTERNAL: 500,
}

export class AdminError extends Error {
  readonly code: AdminErrorCode

  constructor(code: AdminErrorCode, message: string) {
    super(message)
    this.name = 'AdminError'
    this.code = code
  }

  get status(): number {
    return STATUS[this.code]
  }
}

export function isAdminError(value: unknown): value is AdminError {
  return value instanceof AdminError
}

/**
 * 设置插件的错误原样透传（码是 `SETTINGS_*`，那边已经是对外契约），
 * 这里只把它们映射成 HTTP 状态。不认识的按 500。
 */
export function statusOfSettingsCode(code: string): number {
  if (code === 'SETTINGS_ACTOR_REQUIRED' || code === 'SETTINGS_ACTOR_FORBIDDEN') return 403
  if (code === 'SETTINGS_NS_UNKNOWN' || code === 'SETTINGS_TARGET_MISSING') return 404
  if (code === 'SETTINGS_TARGET_DISABLED' || code === 'SETTINGS_TARGET_INACTIVE') return 409
  if (code === 'SETTINGS_CONFLICT') return 409
  if (code === 'SETTINGS_FIELD_UNKNOWN' || code === 'SETTINGS_FIELD_NOT_WRITABLE') return 400
  if (code === 'SETTINGS_VALUE_INVALID') return 400
  return 500
}
