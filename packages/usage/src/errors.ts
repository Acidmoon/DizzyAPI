/** 用量插件的稳定错误码；HTTP 层只做状态码映射。 */
export type UsageErrorCode =
  | 'USAGE_CONFIG_INVALID'
  | 'USAGE_STORE_CORRUPT'
  | 'USAGE_STORE_FAILED'
  | 'USAGE_QUERY_INVALID'
  | 'USAGE_NOT_READY'

export class UsageError extends Error {
  readonly code: UsageErrorCode

  constructor(code: UsageErrorCode, message: string) {
    super(message)
    this.name = 'UsageError'
    this.code = code
  }
}

export function isUsageError(error: unknown): error is UsageError {
  return error instanceof UsageError
}
