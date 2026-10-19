import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 能力目录的配置。 */
export interface CatalogConfig {
  /**
   * `snapshot()` 默认是否包含被禁用 / 未装载的入口。默认 true：
   * 目录是观察窗，隐藏「存在但没运行」的插件反而会让人误判。
   * 无论这里怎么配，`available` 都会如实反映 D5 的启用状态。
   */
  readonly includeUnavailable?: boolean
}

export interface ResolvedCatalogConfig {
  readonly includeUnavailable: boolean
}

export const CATALOG_DEFAULTS = {
  includeUnavailable: true,
} as const

/** 可运行期改：它只影响这次查询是否多带几行，不改变任何插件的运行状态。 */
const CATALOG_FIELDS: readonly FieldSpec[] = [
  { key: 'includeUnavailable', label: '包含未运行的入口', kind: 'boolean', writable: true },
]

const KNOWN_KEYS = knownKeysOf(CATALOG_FIELDS)

export function validateCatalogConfig(value: unknown): ResolvedCatalogConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const includeUnavailable = readBoolean(raw, 'includeUnavailable', issues)
  if (issues.length > 0) return issues
  return {
    includeUnavailable: includeUnavailable ?? CATALOG_DEFAULTS.includeUnavailable,
  }
}

export const CATALOG_CONFIG_SCHEMA = standardSchema<ResolvedCatalogConfig>(
  'dizzyapi',
  validateCatalogConfig,
  CATALOG_FIELDS,
)
