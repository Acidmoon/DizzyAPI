/** 余额快照的稳定错误码。用户可见文案只说「余额快照」，不回显任何余额值。 */
export type QuotaErrorCode = 'QUOTA_SNAPSHOT_INVALID'

export class QuotaError extends Error {
  readonly code: QuotaErrorCode

  constructor(code: QuotaErrorCode, message: string) {
    super(message)
    this.name = 'QuotaError'
    this.code = code
  }
}

export function isQuotaError(value: unknown): value is QuotaError {
  return value instanceof QuotaError
}
