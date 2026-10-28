/**
 * 账号健康检查插件的稳定错误码。
 *
 * 本插件自己不存数据、不改存储：所有读写都走 `accountAdmin` 门面，
 * 门面再把写入委托给 identity。因此这里只有「谁能触发、服务在不在、参数对不对」三类错误。
 */
export type AccountHealthErrorCode =
  | 'ACCOUNT_HEALTH_ACTOR_REQUIRED'
  | 'ACCOUNT_HEALTH_ACTOR_FORBIDDEN'
  | 'ACCOUNT_HEALTH_ADMIN_UNAVAILABLE'
  | 'ACCOUNT_HEALTH_INVALID_ARGUMENT'
  | 'ACCOUNT_HEALTH_TIMER_UNAVAILABLE'

export class AccountHealthError extends Error {
  readonly code: AccountHealthErrorCode

  constructor(code: AccountHealthErrorCode, message: string) {
    super(message)
    this.name = 'AccountHealthError'
    this.code = code
  }
}

export function isAccountHealthError(value: unknown): value is AccountHealthError {
  return value instanceof AccountHealthError
}
