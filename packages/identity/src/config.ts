import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

export interface IdentityConfig {
  /** 账号文件的落盘位置；省略则纯内存（测试用）。 */
  readonly dataPath?: string
  /** credentials 引用名的前缀，默认 `identity`。 */
  readonly credentialPrefix?: string
  /** 提前多久刷新：访问令牌剩余寿命低于它就开始换。 */
  readonly refreshLeadMs?: number
  /** 调度器轮询间隔。 */
  readonly pollIntervalMs?: number
  /** 一次刷新同时打给上游的并发数。 */
  readonly refreshConcurrency?: number
  /** 可重试失败后的退避基数。 */
  readonly retryBaseMs?: number
  /** 退避上限。 */
  readonly retryMaxMs?: number
  /** 单次令牌交换的超时。 */
  readonly requestTimeoutMs?: number
}

export interface ResolvedIdentityConfig {
  readonly dataPath: string | undefined
  readonly credentialPrefix: string
  readonly refreshLeadMs: number
  readonly pollIntervalMs: number
  readonly refreshConcurrency: number
  readonly retryBaseMs: number
  readonly retryMaxMs: number
  readonly requestTimeoutMs: number
}

export const IDENTITY_DEFAULTS = {
  credentialPrefix: 'identity',
  refreshLeadMs: 30 * 60_000,
  pollIntervalMs: 60_000,
  refreshConcurrency: 2,
  retryBaseMs: 5_000,
  retryMaxMs: 5 * 60_000,
  requestTimeoutMs: 15_000,
} as const

/**
 * 字段元数据。
 *
 * 只有刷新策略可写：`dataPath` / `credentialPrefix` 改的是「数据落在哪」，
 * 必须由人在启动时决定；改它们等于把已有的账号或秘密留在原地失联。
 */
const IDENTITY_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '账号文件位置', kind: 'string', writable: false },
  { key: 'credentialPrefix', label: '凭据引用前缀', kind: 'string', writable: false },
  {
    key: 'refreshLeadMs',
    label: '提前刷新窗口',
    kind: 'integer',
    writable: true,
    min: 60_000,
    max: 86_400_000,
    unit: '毫秒',
  },
  {
    key: 'pollIntervalMs',
    label: '调度轮询间隔',
    kind: 'integer',
    writable: true,
    min: 10_000,
    max: 3_600_000,
    unit: '毫秒',
  },
  { key: 'refreshConcurrency', label: '刷新并发数', kind: 'integer', writable: true, min: 1, max: 16 },
  {
    key: 'retryBaseMs',
    label: '重试退避基数',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 600_000,
    unit: '毫秒',
  },
  {
    key: 'retryMaxMs',
    label: '退避上限',
    kind: 'integer',
    writable: true,
    min: 10_000,
    max: 86_400_000,
    unit: '毫秒',
  },
  {
    key: 'requestTimeoutMs',
    label: '请求超时',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 120_000,
    unit: '毫秒',
  },
]

const KNOWN_KEYS = knownKeysOf(IDENTITY_FIELDS)

export function validateIdentityConfig(value: unknown): ResolvedIdentityConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const credentialPrefix = readString(raw, 'credentialPrefix', issues)
  if (credentialPrefix !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(credentialPrefix)) {
    issues.push({
      message: 'credentialPrefix 只能由小写字母、数字、点、下划线与连字符组成',
    })
  }

  const refreshLeadMs = readPositiveInteger(raw, 'refreshLeadMs', issues, { min: 60_000, max: 86_400_000 })
  const pollIntervalMs = readPositiveInteger(raw, 'pollIntervalMs', issues, { min: 10_000, max: 3_600_000 })
  const refreshConcurrency = readPositiveInteger(raw, 'refreshConcurrency', issues, { min: 1, max: 16 })
  const retryBaseMs = readPositiveInteger(raw, 'retryBaseMs', issues, { min: 1_000, max: 600_000 })
  const retryMaxMs = readPositiveInteger(raw, 'retryMaxMs', issues, { min: 10_000, max: 86_400_000 })
  const requestTimeoutMs = readPositiveInteger(raw, 'requestTimeoutMs', issues, { min: 1_000, max: 120_000 })

  if (issues.length > 0) return issues

  return {
    dataPath,
    credentialPrefix: credentialPrefix ?? IDENTITY_DEFAULTS.credentialPrefix,
    refreshLeadMs: refreshLeadMs ?? IDENTITY_DEFAULTS.refreshLeadMs,
    pollIntervalMs: pollIntervalMs ?? IDENTITY_DEFAULTS.pollIntervalMs,
    refreshConcurrency: refreshConcurrency ?? IDENTITY_DEFAULTS.refreshConcurrency,
    retryBaseMs: retryBaseMs ?? IDENTITY_DEFAULTS.retryBaseMs,
    retryMaxMs: retryMaxMs ?? IDENTITY_DEFAULTS.retryMaxMs,
    requestTimeoutMs: requestTimeoutMs ?? IDENTITY_DEFAULTS.requestTimeoutMs,
  }
}

export const IDENTITY_CONFIG_SCHEMA = standardSchema<ResolvedIdentityConfig>(
  'dizzyapi',
  validateIdentityConfig,
  IDENTITY_FIELDS,
)
