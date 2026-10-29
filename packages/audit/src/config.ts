import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 审计插件的配置。
 *
 * - `dataPath`：SQLite 路径（相对路径按 cordis 的 baseUrl 解析，即仓库根）。
 * - `retentionDays`：**保留期**，默认 180 天，边界 1..3650。过期记录由每日清理分批删除；
 *   非法值让插件装载**明确失败**（不静默回落默认值）。
 * - `adminPlugins`：**读**审计记录的白名单（`list` / `stats`）。写（`record`）不设限：
 *   任何插件都可以记录自己的动作，限制读才是关键——审计记录里有人与目标的信息。
 *   白名单省略或空 = 谁都不许读（默认拒绝），与 user / pricing / settings 同一个取向。
 *
 * 不可在运行期写：`dataPath` 换的是落点，`adminPlugins` / `retentionDays` 换的是可见性与
 * 留存期——能改留存期就能让记录提前消失，等于给自己擦痕迹。
 */
export interface AuditConfig {
  readonly dataPath?: string
  readonly retentionDays?: number
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedAuditConfig {
  readonly dataPath?: string
  readonly retentionDays: number
  readonly adminPlugins: readonly string[]
}

export const AUDIT_DEFAULTS = {
  dataPath: './data/audit.db',
  // 180 天：够覆盖「事后追责 + 合规自查」的窗口，又不至于把库撑大。
  retentionDays: 180,
} as const

const AUDIT_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '审计库路径', kind: 'string', writable: false },
  { key: 'retentionDays', label: '审计记录保留天数', kind: 'integer', writable: false, min: 1, max: 3650 },
  { key: 'adminPlugins', label: '可读审计记录的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(AUDIT_FIELDS)

export function validateAuditConfig(value: unknown): ResolvedAuditConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const dataPath = readString(raw, 'dataPath', issues)
  const retentionDays = readPositiveInteger(raw, 'retentionDays', issues, { min: 1, max: 3650 })
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)
  if (issues.length > 0) return issues
  return {
    dataPath: dataPath ?? AUDIT_DEFAULTS.dataPath,
    retentionDays: retentionDays ?? AUDIT_DEFAULTS.retentionDays,
    adminPlugins: adminPlugins ?? [],
  }
}

export const AUDIT_CONFIG_SCHEMA = standardSchema<ResolvedAuditConfig>(
  'dizzyapi',
  validateAuditConfig,
  AUDIT_FIELDS,
)
