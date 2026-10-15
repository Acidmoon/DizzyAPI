/**
 * 鉴权插件的错误码。每个失败都有稳定的机器可读 code。
 *
 * 两条纪律：
 * 1. 「邮箱错」与「密码错」必须给同一个错误（`AUTH_CREDENTIALS_INVALID`），否则就是账号枚举漏洞。
 * 2. 注册与找回的受理阶段永远返回同样的结果，不透露邮箱是否已存在。
 */
export type AuthErrorCode =
  | 'AUTH_EMAIL_INVALID'
  | 'AUTH_PASSWORD_WEAK'
  | 'AUTH_CODE_INVALID'
  | 'AUTH_CODE_ATTEMPTS_EXCEEDED'
  | 'AUTH_RATE_LIMITED'
  | 'AUTH_CREDENTIALS_INVALID'
  | 'AUTH_EMAIL_TAKEN'
  | 'AUTH_USER_MISSING'
  | 'AUTH_USER_BANNED'
  | 'AUTH_SESSION_INVALID'
  | 'AUTH_SESSION_EXPIRED'
  | 'AUTH_NAME_UNAVAILABLE'
  | 'AUTH_MAIL_FAILED'
  | 'AUTH_STORE_CORRUPT'
  | 'AUTH_STORE_UNREADABLE'
  | 'AUTH_DEPENDENCY_MISSING'

export class AuthError extends Error {
  readonly code: AuthErrorCode

  constructor(code: AuthErrorCode, message: string) {
    super(message)
    this.name = 'AuthError'
    this.code = code
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError
}
