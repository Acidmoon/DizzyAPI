import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 闸门快照推送插件的配置（价格表 + 每个 key 的累计消费）。 */
export interface GateFeedConfig {
  /** 关掉就完全不推送（插件仍装载，服务可被读到）；默认 true。 */
  readonly enabled?: boolean
  /** 定时心跳推送的间隔（毫秒）；默认 5000，与 quota 的快照节奏对齐。 */
  readonly pollIntervalMs?: number
  /**
   * 价格 / key 变更事件后的 debounce（毫秒）：默认 1000。
   *
   * 一轮管理员操作可能连着改好几行价格，逐笔推会让桥帧变成刷屏；debounce 之后只推最终态。
   * Go 侧的快照有效期（-pricing-snapshot-ttl-ms / -keyspend-snapshot-ttl-ms）应 ≥ 3 × 本值。
   */
  readonly debounceMs?: number
}

export interface ResolvedGateFeedConfig {
  readonly enabled: boolean
  readonly pollIntervalMs: number
  readonly debounceMs: number
}

export const GATE_FEED_DEFAULTS = {
  enabled: true,
  /** 5 秒一轮：闸门按 TTL（默认 15s）判新鲜度，心跳必须明显快于 TTL。 */
  pollIntervalMs: 5_000,
  debounceMs: 1_000,
} as const

const GATE_FEED_FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', label: '启用闸门快照推送', kind: 'boolean', writable: true },
  {
    key: 'pollIntervalMs',
    label: '心跳推送间隔',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 60_000,
    unit: '毫秒',
  },
  {
    key: 'debounceMs',
    label: '变更后的推送延迟',
    kind: 'integer',
    writable: true,
    min: 100,
    max: 10_000,
    unit: '毫秒',
  },
]

const KNOWN_KEYS = knownKeysOf(GATE_FEED_FIELDS)

/**
 * 配置非法时明确失败（返回 issues，由 `standardSchema` 拒绝构造），不静默降级：
 * 间隔填成 0 会让轮询变成忙等，心跳也太慢——而 Go 侧按 TTL 判过期，
 * 心跳一慢，定价闸门就会周期性 fail-closed 全 503。
 */
export function validateGateFeedConfig(value: unknown): ResolvedGateFeedConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const enabled = readBoolean(raw, 'enabled', issues)
  const pollIntervalMs = readPositiveInteger(raw, 'pollIntervalMs', issues, { min: 1_000, max: 60_000 })
  const debounceMs = readPositiveInteger(raw, 'debounceMs', issues, { min: 100, max: 10_000 })

  if (issues.length > 0) return issues

  return {
    enabled: enabled ?? GATE_FEED_DEFAULTS.enabled,
    pollIntervalMs: pollIntervalMs ?? GATE_FEED_DEFAULTS.pollIntervalMs,
    debounceMs: debounceMs ?? GATE_FEED_DEFAULTS.debounceMs,
  }
}

export const GATE_FEED_CONFIG_SCHEMA = standardSchema<ResolvedGateFeedConfig>(
  'dizzyapi',
  validateGateFeedConfig,
  GATE_FEED_FIELDS,
)
