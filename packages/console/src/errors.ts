/** 前端宿主自己的稳定错误码。桥与 HTTP 层可以原样转发 `code`。 */
export type FrontendErrorCode =
  | 'FRONTEND_CONFIG_INVALID'
  | 'FRONTEND_MANIFEST_INVALID'
  | 'FRONTEND_ASSET_INVALID'
  | 'FRONTEND_ASSET_VERSION_EXISTS'
  | 'FRONTEND_ASSET_NOT_FOUND'
  | 'FRONTEND_NO_PREVIOUS_VERSION'

export class FrontendError extends Error {
  readonly code: FrontendErrorCode

  constructor(code: FrontendErrorCode, message: string) {
    super(message)
    this.name = 'FrontendError'
    this.code = code
  }
}

export function isFrontendError(error: unknown): error is FrontendError {
  return error instanceof FrontendError
}
