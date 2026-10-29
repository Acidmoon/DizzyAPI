import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 运维总览插件的配置。
 *
 * 只有一个参数：审计窗口一次最多扫多少条。它决定「最近 24 小时按动作分组」的**扫描上限**
 * （审计插件的 `list` 单页上限是 200，这里再收一次，避免一次聚合把库读进内存）。
 * 超出上限时结果会标 `windowTruncated: true`——**不静默给出偏小的计数**。
 *
 * 非法值让插件装载**明确失败**（不静默回落默认值）。
 */
export interface ObservabilityConfig {
  readonly auditWindowLimit?: number
}

export interface ResolvedObservabilityConfig {
  readonly auditWindowLimit: number
}

export const OBSERVABILITY_DEFAULTS = {
  auditWindowLimit: 200,
} as const

const OBSERVABILITY_FIELDS: readonly FieldSpec[] = [
  {
    key: 'auditWindowLimit',
    label: '审计窗口扫描上限（条）',
    kind: 'integer',
    writable: false,
    min: 1,
    max: 1000,
  },
]

const KNOWN_KEYS = knownKeysOf(OBSERVABILITY_FIELDS)

export function validateObservabilityConfig(
  value: unknown,
): ResolvedObservabilityConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const auditWindowLimit = readPositiveInteger(raw, 'auditWindowLimit', issues, { min: 1, max: 1000 })
  if (issues.length > 0) return issues
  return { auditWindowLimit: auditWindowLimit ?? OBSERVABILITY_DEFAULTS.auditWindowLimit }
}

export const OBSERVABILITY_CONFIG_SCHEMA = standardSchema<ResolvedObservabilityConfig>(
  'dizzyapi',
  validateObservabilityConfig,
  OBSERVABILITY_FIELDS,
)
