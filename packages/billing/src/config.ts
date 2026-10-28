import {
  checkConfigObject,
  knownKeysOf,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 结算插件配置。
 *
 * `dataPath` 省略 = 纯内存（`:memory:`），进程退出即丢；app.yml 里显式写
 * `./data/billing.db` 才是持久化。测试与内嵌用法通常不写它。
 *
 * `adminPlugins` 是管理读接口的白名单：结算记录、失败 / 残留列表、汇总只对列在这里的
 * 插件开放，省略或空数组 = 谁都不许（默认拒绝）。写路径（settle）不在这里放行：
 * 它由 usage 的结算钩子调用，是幂等的领域动作，真正的钱闸门在 `user.balanceWriters`。
 */
export interface BillingConfig {
  readonly dataPath?: string
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedBillingConfig {
  readonly dataPath: string | undefined
  readonly adminPlugins: readonly string[]
}

/**
 * 字段元数据：两个字段都**不可**运行期改。
 * `dataPath` 换的是账本落点；`adminPlugins` 改的是读权限——两者都不该被在线改写。
 */
const BILLING_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '结算账本数据库位置', kind: 'string', writable: false },
  { key: 'adminPlugins', label: '可读结算记录的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(BILLING_FIELDS)

export const BILLING_DEFAULTS = {
  dataPath: './data/billing.db',
} as const

export function validateBillingConfig(value: unknown): ResolvedBillingConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)

  if (issues.length > 0) return issues

  return { dataPath: dataPath ?? BILLING_DEFAULTS.dataPath, adminPlugins: adminPlugins ?? [] }
}

export const BILLING_CONFIG_SCHEMA = standardSchema<ResolvedBillingConfig>(
  'dizzyapi',
  validateBillingConfig,
  BILLING_FIELDS,
)
