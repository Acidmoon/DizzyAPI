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
  /** 向 Go 轮询新记录的间隔（毫秒）；默认 1000（1s）。 */
  readonly pollIntervalMs?: number
  /** 单次轮询最多拉多少条；默认 500。 */
  readonly maxBatch?: number
  /**
   * 同一批记录连续落库失败多少轮后走隔离（坏记录进 `usage_rejected`，游标放行）；
   * 默认 10，边界 1..1000。非法值让插件装载明确失败，不静默回落。
   */
  readonly rejectAfterFailures?: number
}

export interface ResolvedUsageConfig {
  readonly dataPath?: string
  readonly retentionDays?: number
  readonly pollIntervalMs?: number
  readonly maxBatch?: number
  readonly rejectAfterFailures?: number
}

export const USAGE_DEFAULTS = {
  dataPath: './data/usage.db',
  retentionDays: 90,
  // 1s：Go 缓冲默认 32768 条，1s 一轮在正常流量下离回绕很远；只改默认值，不做运行时热改。
  pollIntervalMs: 1000,
  maxBatch: 500,
  // 坏记录连续失败 10 轮后隔离：既给瞬时故障留足重试机会，又不让结算永久停摆。
  rejectAfterFailures: 10,
} as const

const USAGE_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '用量库路径', kind: 'string', writable: false },
  { key: 'retentionDays', label: '明细保留天数', kind: 'integer', writable: true, min: 1, max: 3650 },
  { key: 'pollIntervalMs', label: '轮询间隔（毫秒）', kind: 'integer', writable: true, min: 250, max: 60_000 },
  { key: 'maxBatch', label: '单次拉取上限', kind: 'integer', writable: true, min: 1, max: 5000 },
  {
    key: 'rejectAfterFailures',
    label: '坏记录隔离阈值（连续失败轮数）',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 1000,
  },
]

const KNOWN_KEYS = knownKeysOf(USAGE_FIELDS)

export function validateUsageConfig(value: unknown): ResolvedUsageConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const dataPath = readString(raw, 'dataPath', issues)
  const retentionDays = readPositiveInteger(raw, 'retentionDays', issues, { min: 1, max: 3650 })
  const pollIntervalMs = readPositiveInteger(raw, 'pollIntervalMs', issues, { min: 250, max: 60_000 })
  const maxBatch = readPositiveInteger(raw, 'maxBatch', issues, { min: 1, max: 5000 })
  const rejectAfterFailures = readPositiveInteger(raw, 'rejectAfterFailures', issues, {
    min: 1,
    max: 1000,
  })
  if (issues.length > 0) return issues
  return {
    dataPath: dataPath ?? USAGE_DEFAULTS.dataPath,
    retentionDays: retentionDays ?? USAGE_DEFAULTS.retentionDays,
    pollIntervalMs: pollIntervalMs ?? USAGE_DEFAULTS.pollIntervalMs,
    maxBatch: maxBatch ?? USAGE_DEFAULTS.maxBatch,
    rejectAfterFailures: rejectAfterFailures ?? USAGE_DEFAULTS.rejectAfterFailures,
  }
}

export const USAGE_CONFIG_SCHEMA = standardSchema<ResolvedUsageConfig>(
  'dizzyapi',
  validateUsageConfig,
  USAGE_FIELDS,
)
