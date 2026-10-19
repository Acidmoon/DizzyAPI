import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 账号管理门面的配置。 */
export interface AccountAdminConfig {
  /**
   * 「指定插件」白名单：只有列在这里的插件名可以新建 / 修改 / 停用 / 删除账号
   * 或导入凭据。省略或空 = 谁都不许（默认拒绝，与 user / settings 同一取向）。
   *
   * 读面（list / get / credentialStatus / previewImport）不要求 actor。
   */
  readonly adminPlugins?: readonly string[]
  /** 一次 bulkImport 最多接收多少项。默认 100。 */
  readonly maxBatchSize?: number
}

/** 解析后的配置；默认值由服务自己兜。 */
export interface ResolvedAccountAdminConfig {
  readonly adminPlugins?: readonly string[]
  readonly maxBatchSize?: number
}

export const ACCOUNT_ADMIN_DEFAULTS = {
  adminPlugins: [] as readonly string[],
  maxBatchSize: 100,
} as const

/**
 * 字段元数据。
 *
 * `adminPlugins` 不可在运行期写：能改白名单等于给自己永久提权
 * （与 settings.adminPlugins 同一条理由）。
 */
const ACCOUNT_ADMIN_FIELDS: readonly FieldSpec[] = [
  { key: 'adminPlugins', label: '可管理账号的插件', kind: 'stringArray', writable: false },
  {
    key: 'maxBatchSize',
    label: '批量导入上限',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 1000,
  },
]

const KNOWN_KEYS = knownKeysOf(ACCOUNT_ADMIN_FIELDS)

export function validateAccountAdminConfig(
  value: unknown,
): ResolvedAccountAdminConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)
  const maxBatchSize = readPositiveInteger(raw, 'maxBatchSize', issues, { min: 1, max: 1000 })

  if (issues.length > 0) return issues

  return {
    adminPlugins: adminPlugins ?? ACCOUNT_ADMIN_DEFAULTS.adminPlugins,
    maxBatchSize: maxBatchSize ?? ACCOUNT_ADMIN_DEFAULTS.maxBatchSize,
  }
}

export const ACCOUNT_ADMIN_CONFIG_SCHEMA = standardSchema<ResolvedAccountAdminConfig>(
  'dizzyapi',
  validateAccountAdminConfig,
  ACCOUNT_ADMIN_FIELDS,
)
