/** 内容审核的稳定错误码（大写蛇形；HTTP 层只做状态码映射）。 */
export type ContentAuditErrorCode =
  | 'CONTENT_AUDIT_CONFIG_INVALID'
  | 'CONTENT_AUDIT_FORBIDDEN'
  | 'CONTENT_AUDIT_INPUT_INVALID'
  | 'CONTENT_AUDIT_RULE_NOT_FOUND'
  | 'CONTENT_AUDIT_RULE_DUPLICATE'
  | 'CONTENT_AUDIT_STORE_FAILED'
  | 'CONTENT_AUDIT_NOT_READY'
  | 'CONTENT_AUDIT_GO_UNAVAILABLE'

export class ContentAuditError extends Error {
  readonly code: ContentAuditErrorCode

  constructor(code: ContentAuditErrorCode, message: string) {
    super(message)
    this.name = 'ContentAuditError'
    this.code = code
  }
}

export function isContentAuditError(error: unknown): error is ContentAuditError {
  return error instanceof ContentAuditError
}
