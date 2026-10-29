/** 审计插件的稳定错误码；HTTP 层只做状态码映射。 */
export type AuditErrorCode =
  | 'AUDIT_CONFIG_INVALID'
  | 'AUDIT_STORE_CORRUPT'
  | 'AUDIT_STORE_FAILED'
  | 'AUDIT_ENTRY_INVALID'
  | 'AUDIT_ACTOR_REQUIRED'
  | 'AUDIT_ACTOR_FORBIDDEN'
  | 'AUDIT_QUERY_INVALID'
  | 'AUDIT_NOT_READY'

export class AuditError extends Error {
  readonly code: AuditErrorCode

  constructor(code: AuditErrorCode, message: string) {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

export function isAuditError(error: unknown): error is AuditError {
  return error instanceof AuditError
}
