/** 运维总览插件的稳定错误码；HTTP 层只做状态码映射。 */
export type ObservabilityErrorCode = 'OBSERVABILITY_CONFIG_INVALID' | 'OBSERVABILITY_NOT_READY'

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode

  constructor(code: ObservabilityErrorCode, message: string) {
    super(message)
    this.name = 'ObservabilityError'
    this.code = code
  }
}

export function isObservabilityError(error: unknown): error is ObservabilityError {
  return error instanceof ObservabilityError
}
