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
 * 兑换码插件配置。
 *
 * `dataPath` 省略 = 纯内存（`:memory:`），进程退出即丢；app.yml 里显式写
 * `./data/redeem.db` 才是持久化。测试与内嵌用法通常不写它。
 *
 * `adminPlugins` 是管理面白名单：生成的批次、启停、删除都只对列在这里的插件开放，
 * 读操作同样不放行白名单外的调用方。省略或空数组 = 谁都不许（默认拒绝）。
 */
export interface RedeemConfig {
  readonly dataPath?: string
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedRedeemConfig {
  readonly dataPath: string | undefined
  readonly adminPlugins: readonly string[]
}

/**
 * 字段元数据：两个字段都**不可**运行期改。
 * `dataPath` 换的是数据落点；`adminPlugins` 改的是写权限——让自己给自己提权，绝不能做。
 */
const REDEEM_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '兑换码数据库位置', kind: 'string', writable: false },
  { key: 'adminPlugins', label: '可管理兑换码的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(REDEEM_FIELDS)

export function validateRedeemConfig(value: unknown): ResolvedRedeemConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)

  if (issues.length > 0) return issues

  return { dataPath, adminPlugins: adminPlugins ?? [] }
}

export const REDEEM_CONFIG_SCHEMA = standardSchema<ResolvedRedeemConfig>(
  'dizzyapi',
  validateRedeemConfig,
  REDEEM_FIELDS,
)
