/** 账号保管插件的稳定错误码。 */
export type IdentityErrorCode =
  | 'IDENTITY_NOT_READY'
  | 'IDENTITY_STORE_CORRUPT'
  | 'IDENTITY_STORE_WRITE_FAILED'
  | 'IDENTITY_ACCOUNT_NOT_FOUND'
  | 'IDENTITY_ACCOUNT_INVALID'
  | 'IDENTITY_ACCOUNT_DISABLED'
  | 'IDENTITY_ACCOUNT_NEEDS_REAUTH'
  | 'IDENTITY_CREDENTIAL_MISSING'
  | 'IDENTITY_CREDENTIAL_INVALID'
  | 'IDENTITY_PROVIDER_UNSUPPORTED'
  | 'IDENTITY_REFRESH_FAILED'
  | 'IDENTITY_REFRESH_NOT_SUPPORTED'

export class IdentityError extends Error {
  readonly code: IdentityErrorCode

  constructor(code: IdentityErrorCode, message: string) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
  }
}

export function isIdentityError(value: unknown): value is IdentityError {
  return value instanceof IdentityError
}
