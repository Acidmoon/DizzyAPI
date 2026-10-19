/** 账号请求优先级管理插件的稳定错误码。 */
export type AccountPriorityErrorCode =
  | 'ACCOUNT_PRIORITY_NOT_READY'
  | 'ACCOUNT_PRIORITY_STORE_CORRUPT'
  | 'ACCOUNT_PRIORITY_STORE_WRITE_FAILED'
  | 'ACCOUNT_PRIORITY_STRATEGY_NOT_FOUND'
  | 'ACCOUNT_PRIORITY_STRATEGY_INVALID'
  | 'ACCOUNT_PRIORITY_BINARY_MISSING'
  | 'ACCOUNT_PRIORITY_START_FAILED'
  | 'ACCOUNT_PRIORITY_START_TIMEOUT'
  | 'ACCOUNT_PRIORITY_CHILD_EXITED'
  | 'ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE'
  | 'ACCOUNT_PRIORITY_BRIDGE_TIMEOUT'
  | 'ACCOUNT_PRIORITY_BRIDGE_PROTOCOL'
  | 'ACCOUNT_PRIORITY_REQUEST_FAILED'
  | 'ACCOUNT_PRIORITY_INVALID_ARGUMENT'

export class AccountPriorityError extends Error {
  readonly code: AccountPriorityErrorCode
  /** Go 侧返回的原始错误码（如果有），排障用。 */
  readonly remoteCode: string | null

  constructor(code: AccountPriorityErrorCode, message: string, options: { remoteCode?: string } = {}) {
    super(message)
    this.name = 'AccountPriorityError'
    this.code = code
    this.remoteCode = options.remoteCode ?? null
  }
}

export function isAccountPriorityError(value: unknown): value is AccountPriorityError {
  return value instanceof AccountPriorityError
}
