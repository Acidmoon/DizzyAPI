import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 自动健康检查的配置。 */
export interface AccountHealthConfig {
  /** 关掉就完全不跑定时器（插件仍装载，服务可被其他插件读到）。 */
  readonly enabled?: boolean
  /** 两轮检查之间的间隔（毫秒）。 */
  readonly intervalMs?: number
  /** 连续失败到几次就自动停用。 */
  readonly failureThreshold?: number
  /** 自动停用后连续成功到几次就自动恢复（一次成功即恢复时填 1）。 */
  readonly recoverySuccesses?: number
  /** 一轮检查里同时在飞的连通性测试数上限。 */
  readonly maxConcurrent?: number
  /**
   * 允许手动触发一轮检查（`runOnce`）的插件白名单；空 = 谁都不能手动触发。
   * 定时器自己不需要 actor；这是为将来的运维入口与面板预留的，不挂 HTTP。
   */
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedAccountHealthConfig {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly failureThreshold: number
  readonly recoverySuccesses: number
  readonly maxConcurrent: number
  readonly adminPlugins: readonly string[]
}

export const ACCOUNT_HEALTH_DEFAULTS = {
  enabled: true,
  /** 一分钟一轮：自用场景够用，也不会把上游打成压力测试。 */
  intervalMs: 60_000,
  /** 自用场景上游会抖；连续 3 次失败才停用，避免误禁。 */
  failureThreshold: 3,
  /** 一次成功即恢复（owner 决定：不做更复杂的滑动窗口）。 */
  recoverySuccesses: 1,
  maxConcurrent: 4,
  adminPlugins: [] as readonly string[],
} as const

const ACCOUNT_HEALTH_FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', label: '启用自动健康检查', kind: 'boolean', writable: true },
  {
    key: 'intervalMs',
    label: '检查间隔',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 3_600_000,
    unit: '毫秒',
  },
  {
    key: 'failureThreshold',
    label: '连续失败多少次自动停用',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 100,
  },
  {
    key: 'recoverySuccesses',
    label: '连续成功多少次自动恢复',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 100,
  },
  {
    key: 'maxConcurrent',
    label: '并发检查上限',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 64,
  },
  // 能改白名单等于给自己提权；与 user / settings / account-admin 同一条纪律。
  { key: 'adminPlugins', label: '可手动触发检查的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(ACCOUNT_HEALTH_FIELDS)

/**
 * 配置非法时明确失败（返回 issues，由 `standardSchema` 拒绝构造），不静默降级：
 * 一个填错的阈值会让自动停用永远不触发，那比插件起不来更危险。
 */
export function validateAccountHealthConfig(
  value: unknown,
): ResolvedAccountHealthConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const enabled = readBoolean(raw, 'enabled', issues)
  const intervalMs = readPositiveInteger(raw, 'intervalMs', issues, { min: 1_000, max: 3_600_000 })
  const failureThreshold = readPositiveInteger(raw, 'failureThreshold', issues, { min: 1, max: 100 })
  const recoverySuccesses = readPositiveInteger(raw, 'recoverySuccesses', issues, { min: 1, max: 100 })
  const maxConcurrent = readPositiveInteger(raw, 'maxConcurrent', issues, { min: 1, max: 64 })
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)

  if (issues.length > 0) return issues

  return {
    enabled: enabled ?? ACCOUNT_HEALTH_DEFAULTS.enabled,
    intervalMs: intervalMs ?? ACCOUNT_HEALTH_DEFAULTS.intervalMs,
    failureThreshold: failureThreshold ?? ACCOUNT_HEALTH_DEFAULTS.failureThreshold,
    recoverySuccesses: recoverySuccesses ?? ACCOUNT_HEALTH_DEFAULTS.recoverySuccesses,
    maxConcurrent: maxConcurrent ?? ACCOUNT_HEALTH_DEFAULTS.maxConcurrent,
    adminPlugins: adminPlugins ?? ACCOUNT_HEALTH_DEFAULTS.adminPlugins,
  }
}

export const ACCOUNT_HEALTH_CONFIG_SCHEMA = standardSchema<ResolvedAccountHealthConfig>(
  'dizzyapi',
  validateAccountHealthConfig,
  ACCOUNT_HEALTH_FIELDS,
)
