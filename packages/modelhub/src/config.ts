import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 模型广场插件的配置。
 *
 * 这个插件**不落盘**，所以没有 `dataPath`；配置面只有一个开关：
 *
 * - `includeUnpriced`：目录里是否包含「没有精确价格」的模型。默认 `true`——
 *   用户想知道自己能调什么，哪怕那个模型还没定价。
 *
 * 为什么没有「是否包含无账号声明的模型」这个开关：目录的模型集合是
 * 「价格表里的模型 ∪ 账号声明的模型」，两者都没有的模型不可能出现；
 * 而「有价但当前没人提供」正是需求要求**必须列出并给原因**的一类，不能做成开关。
 */
export interface ModelHubConfig {
  readonly includeUnpriced?: boolean
}

export interface ResolvedModelHubConfig {
  readonly includeUnpriced: boolean
}

const MODELHUB_FIELDS: readonly FieldSpec[] = [
  { key: 'includeUnpriced', label: '包含没有精确价格的模型', kind: 'boolean', writable: false },
]

const KNOWN_KEYS = knownKeysOf(MODELHUB_FIELDS)

export function validateModelHubConfig(
  value: unknown,
): ResolvedModelHubConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  // 布尔字段显式校验类型（不静默接受 "true" / 1）；默认值在通过校验后才填。
  const includeUnpriced = readBoolean(raw, 'includeUnpriced', issues)

  if (issues.length > 0) return issues

  return { includeUnpriced: includeUnpriced ?? true }
}

export const MODELHUB_CONFIG_SCHEMA = standardSchema<ResolvedModelHubConfig>(
  'dizzyapi',
  validateModelHubConfig,
  MODELHUB_FIELDS,
)
