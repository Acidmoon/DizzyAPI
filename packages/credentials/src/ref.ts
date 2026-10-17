import { CredentialsError } from './errors.ts'

/**
 * 凭据引用名的规则。
 *
 * 一段或多段，段内以小写字母或数字开头，其后可带 `.` `_` `-`，段间用 `/` 分隔。
 * 例如 `dizzyapi/smtp-163`。约定俗成用 `dizzyapi/` 前缀把本项目的凭据归到一处。
 *
 * 只认小写：引用名会出现在配置文件、日志与排障现场，大小写混用只会带来
 * 「明明是同一个东西却对不上」的麻烦。
 */
const REF_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/

export const REF_MAX_LENGTH = 200

export function isRef(value: unknown): value is string {
  return typeof value === 'string' && value.length <= REF_MAX_LENGTH && REF_PATTERN.test(value)
}

/** 写路径上的校验：不合法直接抛，不留「尽力而为」的余地。 */
export function normalizeRef(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CredentialsError('CREDENTIALS_REF_INVALID', '凭据引用名必须是非空字符串')
  }
  if (value.length > REF_MAX_LENGTH) {
    throw new CredentialsError('CREDENTIALS_REF_INVALID', `凭据引用名最长 ${REF_MAX_LENGTH} 个字符`)
  }
  if (!REF_PATTERN.test(value)) {
    throw new CredentialsError(
      'CREDENTIALS_REF_INVALID',
      `非法凭据引用名：${value}（只认小写字母、数字与 . _ -，段间用 /，例如 dizzyapi/smtp-163）`,
    )
  }
  return value
}
