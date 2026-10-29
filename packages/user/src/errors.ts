/**
 * 用户插件的错误码。
 *
 * 每个失败都有一个稳定的机器可读 code：调用方据 code 分支，人据 message 排障。
 * 不返回 undefined 表示「失败」——静默失败在本项目里等于悄悄变成免费中转。
 */
export type UserErrorCode =
  | 'USER_NOT_FOUND'
  | 'USER_ID_INVALID'
  | 'USER_NAME_INVALID'
  | 'USER_NAME_TAKEN'
  | 'USER_STATUS_INVALID'
  | 'USER_ROLE_INVALID'
  | 'USER_LAST_ADMIN'
  | 'USER_PROFILE_INVALID'
  | 'USER_AVATAR_INVALID'
  | 'USER_BALANCE_ENABLED_INVALID'
  | 'USER_BALANCE_INVALID'
  | 'USER_CONCURRENCY_INVALID'
  | 'USER_UI_PREFERENCES_INVALID'
  | 'USER_BALANCE_NOT_ZERO'
  | 'USER_REASON_REQUIRED'
  | 'USER_ACTOR_REQUIRED'
  | 'USER_ACTOR_FORBIDDEN'
  | 'USER_STORE_CORRUPT'
  | 'USER_STORE_UNREADABLE'

export class UserError extends Error {
  readonly code: UserErrorCode

  constructor(code: UserErrorCode, message: string) {
    super(message)
    this.name = 'UserError'
    this.code = code
  }
}

export function isUserError(value: unknown): value is UserError {
  return value instanceof UserError
}
