/**
 * API key 插件的稳定错误码。
 *
 * 调用方据 code 分支；message 只给人排障，永远不含完整 key 或 secret hash。
 */
export type ApiKeyErrorCode =
  | 'API_KEY_INVALID_INPUT'
  | 'API_KEY_NOT_FOUND'
  | 'API_KEY_USER_NOT_FOUND'
  | 'API_KEY_LIMIT_REACHED'
  | 'API_KEY_STORE_CORRUPT'
  | 'API_KEY_NAME_TAKEN'

export class ApiKeyError extends Error {
  readonly code: ApiKeyErrorCode

  constructor(code: ApiKeyErrorCode, message: string) {
    super(message)
    this.name = 'ApiKeyError'
    this.code = code
  }
}

export function isApiKeyError(value: unknown): value is ApiKeyError {
  return value instanceof ApiKeyError
}
