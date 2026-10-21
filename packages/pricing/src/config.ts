import {
  checkConfigObject,
  knownKeysOf,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 价格表插件的配置。 */
export interface PricingConfig {
  /** 价格表 JSON 的存放路径；相对路径按 cordis 的 baseUrl（仓库根）解析。 */
  readonly dataPath?: string
  /**
   * 「指定插件」白名单：只有列在这里的插件名可以改价格。
   * 省略或空 = 谁都不许（默认拒绝，与 user / settings / account-admin 同一取向）。
   * 读价格不要求 actor。
   */
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedPricingConfig {
  readonly dataPath?: string
  readonly adminPlugins?: readonly string[]
}

export const PRICING_DEFAULTS = {
  dataPath: './data/pricing.json',
  adminPlugins: [] as readonly string[],
} as const

const PRICING_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '价格表文件路径', kind: 'string', writable: false },
  { key: 'adminPlugins', label: '可改价格的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(PRICING_FIELDS)

export function validatePricingConfig(value: unknown): ResolvedPricingConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  // 空字符串是合法值：表示不落盘，使用内存存储（测试与不需要持久化的场合）。
  const dataPath = readString(raw, 'dataPath', issues, { allowEmpty: true })
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)
  if (issues.length > 0) return issues
  return {
    dataPath: dataPath ?? PRICING_DEFAULTS.dataPath,
    adminPlugins: adminPlugins ?? PRICING_DEFAULTS.adminPlugins,
  }
}

export const PRICING_CONFIG_SCHEMA = standardSchema<ResolvedPricingConfig>(
  'dizzyapi',
  validatePricingConfig,
  PRICING_FIELDS,
)
