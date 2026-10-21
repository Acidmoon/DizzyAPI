/**
 * 账号管理门面的稳定错误码。
 *
 * 本插件自己产生的错误一律用 `ACCOUNT_ADMIN_*`；委托给 identity 的操作
 * （create / update / remove / importCredentials / refreshNow）如果被 identity 拒绝，
 * `IDENTITY_*` 错误会原样向上抛——identity 仍是账号规则的唯一真相，这里不复制一套映射。
 */
export type AccountAdminErrorCode =
  | 'ACCOUNT_ADMIN_ACTOR_REQUIRED'
  | 'ACCOUNT_ADMIN_ACTOR_FORBIDDEN'
  | 'ACCOUNT_ADMIN_INPUT_INVALID'
  | 'ACCOUNT_ADMIN_IMPORT_JSON_INVALID'
  | 'ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID'
  | 'ACCOUNT_ADMIN_IMPORT_FIELD_INVALID'
  | 'ACCOUNT_ADMIN_IMPORT_PROVIDER_REQUIRED'
  | 'ACCOUNT_ADMIN_IMPORT_CONFLICT'
  | 'ACCOUNT_ADMIN_IMPORT_TOO_LARGE'
  | 'ACCOUNT_ADMIN_IDENTITY_UNAVAILABLE'
  | 'ACCOUNT_TEST_BASE_URL_MISSING'
  | 'ACCOUNT_TEST_PROTOCOL_INVALID'
  | 'ACCOUNT_TEST_MODEL_INVALID'
  | 'ACCOUNT_IMPORT_SOURCE_INVALID'
  | 'ACCOUNT_IMPORT_FIELD_INVALID'
  | 'ACCOUNT_IMPORT_UNSUPPORTED_TYPE'
  | 'ACCOUNT_IMPORT_UNSUPPORTED_PLATFORM'
  | 'ACCOUNT_ADMIN_UNKNOWN'

export class AccountAdminError extends Error {
  readonly code: AccountAdminErrorCode

  constructor(code: AccountAdminErrorCode, message: string) {
    super(message)
    this.name = 'AccountAdminError'
    this.code = code
  }
}

export function isAccountAdminError(value: unknown): value is AccountAdminError {
  return value instanceof AccountAdminError
}

/**
 * 批量导入要原样保留每个条目的失败原因：identity / credentials 的错误也带稳定 code。
 * 拿不到字符串 code 时退回 `ACCOUNT_ADMIN_UNKNOWN`。
 */
export function errorCodeOf(error: unknown): string {
  if (isAccountAdminError(error)) return error.code
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'ACCOUNT_ADMIN_UNKNOWN'
}
