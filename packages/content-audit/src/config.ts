import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 内容审核插件的配置。
 *
 * - `dataPath`：规则 JSON（相对路径按 cordis 的 baseUrl 解析，即仓库根）。**本插件是唯一写者**。
 * - `enabled`：审核总开关，默认 **false**（新装的插件不该突然拦人）。关掉后仍会心跳推送
 *   `enabled:false` + 空规则，让 Go 侧立刻回到全放行——「不推」会让 Go 侧按 TTL 判定快照过期，
 *   严格模式下反而全 503（额度闸门踩过这个坑）。
 * - `pushIntervalMs`：心跳推送间隔，默认 5000；Go 侧 TTL 必须 ≥ 3 倍（由部署配置对齐）。
 * - `adminPlugins`：读写规则的白名单（`api` / `web` 以自己的 actor 身份调）。
 *   省略或空 = 谁都不许读写（默认拒绝），与 user / pricing / settings 同一个取向。
 */
export interface ContentAuditConfig {
  readonly dataPath?: string
  readonly enabled?: boolean
  readonly pushIntervalMs?: number
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedContentAuditConfig {
  readonly dataPath: string
  readonly enabled: boolean
  readonly pushIntervalMs: number
  readonly adminPlugins: readonly string[]
}

export const CONTENT_AUDIT_DEFAULTS = {
  dataPath: './data/content-audit.json',
  enabled: false,
  /** 5 秒一轮：规则不是热路径数据，够快也不刷屏。 */
  pushIntervalMs: 5_000,
} as const

const CONTENT_AUDIT_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '规则文件路径', kind: 'string', writable: false },
  { key: 'enabled', label: '启用内容审核', kind: 'boolean', writable: false },
  {
    key: 'pushIntervalMs',
    label: '规则心跳推送间隔',
    kind: 'integer',
    writable: false,
    min: 250,
    max: 60_000,
    unit: '毫秒',
  },
  { key: 'adminPlugins', label: '可读写审核规则的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(CONTENT_AUDIT_FIELDS)

/** 配置非法时明确失败（返回 issues，由 `standardSchema` 拒绝构造），不静默降级。 */
export function validateContentAuditConfig(
  value: unknown,
): ResolvedContentAuditConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  // 空字符串是合法值：表示不落盘，使用内存存储（测试与不需要持久化的场合）。
  const dataPath = readString(raw, 'dataPath', issues, { allowEmpty: true })
  const enabled = readBoolean(raw, 'enabled', issues)
  const pushIntervalMs = readPositiveInteger(raw, 'pushIntervalMs', issues, { min: 250, max: 60_000 })
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)
  if (issues.length > 0) return issues
  return {
    dataPath: dataPath ?? CONTENT_AUDIT_DEFAULTS.dataPath,
    enabled: enabled ?? CONTENT_AUDIT_DEFAULTS.enabled,
    pushIntervalMs: pushIntervalMs ?? CONTENT_AUDIT_DEFAULTS.pushIntervalMs,
    adminPlugins: adminPlugins ?? [],
  }
}

export const CONTENT_AUDIT_CONFIG_SCHEMA = standardSchema<ResolvedContentAuditConfig>(
  'dizzyapi',
  validateContentAuditConfig,
  CONTENT_AUDIT_FIELDS,
)
