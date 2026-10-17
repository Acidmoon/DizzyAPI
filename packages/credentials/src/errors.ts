/**
 * 凭据插件的错误码。
 *
 * 每个失败都有一个稳定的机器可读 code：调用方据 code 分支，人据 message 排障。
 */
export type CredentialsErrorCode =
  | 'CREDENTIALS_REF_INVALID'
  | 'CREDENTIALS_VALUE_INVALID'
  | 'CREDENTIALS_NOT_READY'
  | 'CREDENTIALS_STORE_CORRUPT'
  | 'CREDENTIALS_STORE_UNREADABLE'
  | 'CREDENTIALS_STORE_UNWRITABLE'

export class CredentialsError extends Error {
  readonly code: CredentialsErrorCode

  constructor(code: CredentialsErrorCode, message: string) {
    super(message)
    this.name = 'CredentialsError'
    this.code = code
  }
}

export function isCredentialsError(value: unknown): value is CredentialsError {
  return value instanceof CredentialsError
}
