import {
  checkConfigObject,
  issue,
  knownKeysOf,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 鉴权插件的配置。所有时间单位都是毫秒。 */
export interface AuthConfig {
  /** 凭证 / 会话 / 待验证码的落盘位置；省略则纯内存。 */
  readonly dataPath?: string
  /**
   * 调用用户插件管理面时自报的插件名。必须同时出现在用户插件的
   * `adminPlugins` 白名单里，否则注册会在建用户那一步被拒绝。
   */
  readonly userActor?: string
  /** 验证码有效期，默认 10 分钟。 */
  readonly codeTtlMs?: number
  /** 验证码位数，默认 6。 */
  readonly codeDigits?: number
  /** 同一个验证码最多允许试几次，默认 5；超过即作废。 */
  readonly codeMaxAttempts?: number
  /** 同一邮箱两次请求验证码的最小间隔，默认 60 秒。 */
  readonly codeResendCooldownMs?: number
  /** 同一邮箱每小时最多请求几次验证码，默认 5。 */
  readonly codeRequestsPerHour?: number
  /** 会话有效期，默认 7 天。 */
  readonly sessionTtlMs?: number
  /** 密码长度下限，默认 8。 */
  readonly passwordMinLength?: number
  /** 密码长度上限，默认 128（scrypt 前截断没有意义，直接拒绝）。 */
  readonly passwordMaxLength?: number
  /** 登录失败计数的窗口，默认 15 分钟。 */
  readonly loginWindowMs?: number
  /** 窗口内允许的连续失败次数，默认 10；超过则暂时拒绝登录。 */
  readonly loginMaxFailures?: number
  /** 邮件主题前缀，默认 DizzyAPI。 */
  readonly mailSubjectPrefix?: string
}

export interface ResolvedAuthConfig {
  readonly dataPath: string | undefined
  readonly userActor: string
  readonly codeTtlMs: number
  readonly codeDigits: number
  readonly codeMaxAttempts: number
  readonly codeResendCooldownMs: number
  readonly codeRequestsPerHour: number
  readonly sessionTtlMs: number
  readonly passwordMinLength: number
  readonly passwordMaxLength: number
  readonly loginWindowMs: number
  readonly loginMaxFailures: number
  readonly mailSubjectPrefix: string
}

/**
 * 字段元数据：鉴权参数全部**不可**运行期改。
 * 这些值同时约束校验与安全边界（验证码次数、密码长度、会话寿命），
 * 什么时候允许热改由 owner 决定，不在这轮目录里顺手放开。
 */
const AUTH_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '鉴权数据文件位置', kind: 'string', writable: false },
  { key: 'userActor', label: '用户插件调用身份', kind: 'string', writable: false },
  { key: 'codeTtlMs', label: '验证码有效期', kind: 'integer', writable: false, min: 60_000, max: 86_400_000, unit: '毫秒' },
  { key: 'codeDigits', label: '验证码位数', kind: 'integer', writable: false, min: 4, max: 10 },
  { key: 'codeMaxAttempts', label: '验证码尝试上限', kind: 'integer', writable: false, min: 1, max: 20 },
  { key: 'codeResendCooldownMs', label: '验证码重发冷却', kind: 'integer', writable: false, min: 0, max: 3_600_000, unit: '毫秒' },
  { key: 'codeRequestsPerHour', label: '每小时验证码请求上限', kind: 'integer', writable: false, min: 1, max: 100 },
  { key: 'sessionTtlMs', label: '会话有效期', kind: 'integer', writable: false, min: 60_000, max: 31_536_000_000, unit: '毫秒' },
  { key: 'passwordMinLength', label: '密码长度下限', kind: 'integer', writable: false, min: 6, max: 128 },
  { key: 'passwordMaxLength', label: '密码长度上限', kind: 'integer', writable: false, min: 16, max: 1024 },
  { key: 'loginWindowMs', label: '登录失败计数窗口', kind: 'integer', writable: false, min: 60_000, max: 86_400_000, unit: '毫秒' },
  { key: 'loginMaxFailures', label: '窗口内失败上限', kind: 'integer', writable: false, min: 1, max: 1000 },
  { key: 'mailSubjectPrefix', label: '邮件主题前缀', kind: 'string', writable: false },
]

const KNOWN_KEYS = knownKeysOf(AUTH_FIELDS)

export function validateAuthConfig(value: unknown): ResolvedAuthConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const userActor = readString(raw, 'userActor', issues)
  const codeTtlMs = readPositiveInteger(raw, 'codeTtlMs', issues, { min: 60_000, max: 24 * 3600_000 })
  const codeDigits = readPositiveInteger(raw, 'codeDigits', issues, { min: 4, max: 10 })
  const codeMaxAttempts = readPositiveInteger(raw, 'codeMaxAttempts', issues, { min: 1, max: 20 })
  const codeResendCooldownMs = readPositiveInteger(raw, 'codeResendCooldownMs', issues, { min: 0, max: 3600_000 })
  const codeRequestsPerHour = readPositiveInteger(raw, 'codeRequestsPerHour', issues, { min: 1, max: 100 })
  const sessionTtlMs = readPositiveInteger(raw, 'sessionTtlMs', issues, { min: 60_000, max: 365 * 24 * 3600_000 })
  const passwordMinLength = readPositiveInteger(raw, 'passwordMinLength', issues, { min: 6, max: 128 })
  const passwordMaxLength = readPositiveInteger(raw, 'passwordMaxLength', issues, { min: 16, max: 1024 })
  const loginWindowMs = readPositiveInteger(raw, 'loginWindowMs', issues, { min: 60_000, max: 24 * 3600_000 })
  const loginMaxFailures = readPositiveInteger(raw, 'loginMaxFailures', issues, { min: 1, max: 1000 })
  const mailSubjectPrefix = readString(raw, 'mailSubjectPrefix', issues)

  if (passwordMinLength !== undefined && passwordMaxLength !== undefined && passwordMinLength > passwordMaxLength) {
    issues.push(issue('passwordMinLength 不能大于 passwordMaxLength'))
  }

  if (issues.length > 0) return issues

  return {
    dataPath,
    userActor: userActor ?? '@dizzyapi/plugin-auth',
    codeTtlMs: codeTtlMs ?? 10 * 60_000,
    codeDigits: codeDigits ?? 6,
    codeMaxAttempts: codeMaxAttempts ?? 5,
    codeResendCooldownMs: codeResendCooldownMs ?? 60_000,
    codeRequestsPerHour: codeRequestsPerHour ?? 5,
    sessionTtlMs: sessionTtlMs ?? 7 * 24 * 3600_000,
    passwordMinLength: passwordMinLength ?? 8,
    passwordMaxLength: passwordMaxLength ?? 128,
    loginWindowMs: loginWindowMs ?? 15 * 60_000,
    loginMaxFailures: loginMaxFailures ?? 10,
    mailSubjectPrefix: mailSubjectPrefix ?? 'DizzyAPI',
  }
}

export const AUTH_CONFIG_SCHEMA = standardSchema<ResolvedAuthConfig>(
  'dizzyapi',
  validateAuthConfig,
  AUTH_FIELDS,
)
