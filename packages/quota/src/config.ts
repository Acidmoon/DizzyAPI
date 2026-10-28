import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 余额只读快照推送插件的配置。 */
export interface QuotaConfig {
  /** 关掉就完全不推送（插件仍装载，服务可被读到）；默认 true。 */
  readonly enabled?: boolean
  /** 定时全量推送的间隔（毫秒）；默认 5000。 */
  readonly pollIntervalMs?: number
  /**
   * 余额变更事件后的 debounce（毫秒）：默认 1000。
   *
   * 一轮结算可能连着改多个用户的余额，逐笔推会让桥帧变成刷屏；debounce 之后只推最终态。
   * Go 侧的快照有效期应 ≥ 3 × pollIntervalMs，两者由部署配置对齐。
   */
  readonly debounceMs?: number
}

export interface ResolvedQuotaConfig {
  readonly enabled: boolean
  readonly pollIntervalMs: number
  readonly debounceMs: number
}

export const QUOTA_DEFAULTS = {
  enabled: true,
  /** 5 秒一轮：余额不是热路径数据，够快也不刷屏。 */
  pollIntervalMs: 5_000,
  debounceMs: 1_000,
} as const

const QUOTA_FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', label: '启用余额快照推送', kind: 'boolean', writable: true },
  {
    key: 'pollIntervalMs',
    label: '全量推送间隔',
    kind: 'integer',
    writable: true,
    min: 250,
    max: 60_000,
    unit: '毫秒',
  },
  {
    key: 'debounceMs',
    label: '余额变更后的推送延迟',
    kind: 'integer',
    writable: true,
    min: 100,
    max: 10_000,
    unit: '毫秒',
  },
]

const KNOWN_KEYS = knownKeysOf(QUOTA_FIELDS)

/**
 * 配置非法时明确失败（返回 issues，由 `standardSchema` 拒绝构造），不静默降级：
 * 间隔填成 0 会让轮询变成忙等，配额快照也永远追不上。
 */
export function validateQuotaConfig(value: unknown): ResolvedQuotaConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const enabled = readBoolean(raw, 'enabled', issues)
  const pollIntervalMs = readPositiveInteger(raw, 'pollIntervalMs', issues, { min: 250, max: 60_000 })
  const debounceMs = readPositiveInteger(raw, 'debounceMs', issues, { min: 100, max: 10_000 })

  if (issues.length > 0) return issues

  return {
    enabled: enabled ?? QUOTA_DEFAULTS.enabled,
    pollIntervalMs: pollIntervalMs ?? QUOTA_DEFAULTS.pollIntervalMs,
    debounceMs: debounceMs ?? QUOTA_DEFAULTS.debounceMs,
  }
}

export const QUOTA_CONFIG_SCHEMA = standardSchema<ResolvedQuotaConfig>(
  'dizzyapi',
  validateQuotaConfig,
  QUOTA_FIELDS,
)
