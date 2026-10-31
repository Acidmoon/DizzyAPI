import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 模型广场插件的配置。
 *
 * 这个插件**不落盘**，所以没有 `dataPath`。三个开关：
 *
 * - `includeUnpriced`：目录里是否包含「没有精确价格」的模型。默认 `true`——
 *   用户想知道自己能调什么，哪怕那个模型还没定价。
 * - `probeFailureThreshold`：**探测连续失败多少条才判「不可用」**。判定权在本插件，
 *   所以阈值也是本插件的配置 —— 改探测插件的阈值不会偷偷改变广场的口径。
 * - `probeHistoryPoints`：目录里每个模型带多少个探测点（给小柱状图）。
 *
 * 为什么没有「是否包含无账号声明的模型」这个开关：目录的模型集合是
 * 「价格表里的模型 ∪ 账号声明的模型」，两者都没有的模型不可能出现；
 * 而「有价但当前没人提供」正是需求要求**必须列出并给原因**的一类，不能做成开关。
 */
export interface ModelHubConfig {
  readonly includeUnpriced?: boolean
  /** 连续探测失败多少条判 `down`（1~100）。默认 3。 */
  readonly probeFailureThreshold?: number
  /** 目录条目里带多少个探测点（12~240）。默认 24。 */
  readonly probeHistoryPoints?: number
}

export interface ResolvedModelHubConfig {
  readonly includeUnpriced: boolean
  readonly probeFailureThreshold: number
  readonly probeHistoryPoints: number
}

const MODELHUB_FIELDS: readonly FieldSpec[] = [
  { key: 'includeUnpriced', label: '包含没有精确价格的模型', kind: 'boolean', writable: false },
  {
    key: 'probeFailureThreshold',
    label: '探测连续失败多少条判不可用',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 100,
  },
  {
    key: 'probeHistoryPoints',
    label: '目录里带多少个探测点',
    kind: 'integer',
    writable: true,
    min: 12,
    max: 240,
  },
]

const KNOWN_KEYS = knownKeysOf(MODELHUB_FIELDS)

export function validateModelHubConfig(
  value: unknown,
): ResolvedModelHubConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  // 布尔字段显式校验类型（不静默接受 "true" / 1）；默认值在通过校验后才填。
  const includeUnpriced = readBoolean(raw, 'includeUnpriced', issues)
  const probeFailureThreshold = readPositiveInteger(raw, 'probeFailureThreshold', issues, {
    min: 1,
    max: 100,
  })
  const probeHistoryPoints = readPositiveInteger(raw, 'probeHistoryPoints', issues, {
    min: 12,
    max: 240,
  })

  if (issues.length > 0) return issues

  return {
    includeUnpriced: includeUnpriced ?? true,
    probeFailureThreshold: probeFailureThreshold ?? 3,
    probeHistoryPoints: probeHistoryPoints ?? 24,
  }
}

export const MODELHUB_CONFIG_SCHEMA = standardSchema<ResolvedModelHubConfig>(
  'dizzyapi',
  validateModelHubConfig,
  MODELHUB_FIELDS,
)
