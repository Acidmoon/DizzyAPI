import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 用量插件配置。 */
export interface UsageConfig {
  /** SQLite 路径；相对路径按 cordis 的 baseUrl（仓库根）解析。 */
  readonly dataPath?: string
  /** 明细保留天数；默认 90。过期记录由每日清理分批删除。 */
  readonly retentionDays?: number
  /** 向 Go 轮询新记录的间隔（毫秒）；默认 2000。 */
  readonly pollIntervalMs?: number
  /** 单次轮询最多拉多少条；默认 500。 */
  readonly maxBatch?: number
}

export interface ResolvedUsageConfig {
  readonly dataPath?: string
  readonly retentionDays?: number
  readonly pollIntervalMs?: number
  readonly maxBatch?: number
}

export const USAGE_DEFAULTS = {
  dataPath: './data/usage.db',
  retentionDays: 90,
  pollIntervalMs: 2000,
  maxBatch: 500,
} as const

const USAGE_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '用量库路径', kind: 'string', writable: false },
  { key: 'retentionDays', label: '明细保留天数', kind: 'integer', writable: true, min: 1, max: 3650 },
  { key: 'pollIntervalMs', label: '轮询间隔（毫秒）', kind: 'integer', writable: true, min: 250, max: 60_000 },
  { key: 'maxBatch', label: '单次拉取上限', kind: 'integer', writable: true, min: 1, max: 5000 },
]

const KNOWN_KEYS = knownKeysOf(USAGE_FIELDS)

export function validateUsageConfig(value: unknown): ResolvedUsageConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const dataPath = readString(raw, 'dataPath', issues)
  const retentionDays = readPositiveInteger(raw, 'retentionDays', issues, { min: 1, max: 3650 })
  const pollIntervalMs = readPositiveInteger(raw, 'pollIntervalMs', issues, { min: 250, max: 60_000 })
  const maxBatch = readPositiveInteger(raw, 'maxBatch', issues, { min: 1, max: 5000 })
  if (issues.length > 0) return issues
  return {
    dataPath: dataPath ?? USAGE_DEFAULTS.dataPath,
    retentionDays: retentionDays ?? USAGE_DEFAULTS.retentionDays,
    pollIntervalMs: pollIntervalMs ?? USAGE_DEFAULTS.pollIntervalMs,
    maxBatch: maxBatch ?? USAGE_DEFAULTS.maxBatch,
  }
}

export const USAGE_CONFIG_SCHEMA = standardSchema<ResolvedUsageConfig>(
  'dizzyapi',
  validateUsageConfig,
  USAGE_FIELDS,
)
