import {
  checkConfigObject,
  issue,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 产品 HTTP 入口的配置。
 *
 * 所有字段都**不可**运行期改：换端口、换 body 上限或 cookie 名会让「当前正在
 * 监听的地址」与设置页显示的值脱节；这一轮不支持反向代理，`trustProxy` 只作为
 * 未来的声明占位，运行期永远是 false 语义。
 */
export interface ApiConfig {
  /** 监听端口；`0` = 系统分配（测试用）。只绑 127.0.0.1。 */
  readonly port?: number
  /** 请求体上限，字节。 */
  readonly bodyLimitBytes?: number
  /** 会话 cookie 名。 */
  readonly sessionCookieName?: string
  /** 预留给反向代理；本轮不支持，置 true 也不会改变任何行为。 */
  readonly trustProxy?: boolean
  /** 是否随插件启动。false 时插件装载但不监听端口。 */
  readonly enabled?: boolean
}

export interface ResolvedApiConfig {
  readonly port: number
  readonly bodyLimitBytes: number
  readonly sessionCookieName: string
  readonly trustProxy: boolean
  readonly enabled: boolean
}

export const API_DEFAULTS = {
  port: 7791,
  bodyLimitBytes: 1024 * 1024,
  sessionCookieName: 'dizzyapi_session',
  trustProxy: false,
  enabled: true,
} as const

/** 1 分 = 10_000 个余额最小单位（1 元 = 1_000_000 个）。 */
export const BALANCE_MINOR_UNITS_PER_CENT = 10_000n

const API_FIELDS: readonly FieldSpec[] = [
  { key: 'port', label: '产品 HTTP 端口', kind: 'integer', writable: false, min: 0, max: 65_535 },
  {
    key: 'bodyLimitBytes',
    label: '请求体上限',
    kind: 'integer',
    writable: false,
    min: 64 * 1024,
    max: 4 * 1024 * 1024,
    unit: '字节',
  },
  { key: 'sessionCookieName', label: '会话 cookie 名', kind: 'string', writable: false },
  { key: 'trustProxy', label: '信任反向代理（本轮不支持）', kind: 'boolean', writable: false },
  { key: 'enabled', label: '随插件启动 HTTP 入口', kind: 'boolean', writable: false },
]

const KNOWN_KEYS = knownKeysOf(API_FIELDS)
const COOKIE_NAME_RE = /^[A-Za-z0-9_.-]+$/

export function validateApiConfig(value: unknown): ResolvedApiConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const port = readPositiveInteger(raw, 'port', issues, { min: 0, max: 65_535 })
  const bodyLimitBytes = readPositiveInteger(raw, 'bodyLimitBytes', issues, {
    min: 64 * 1024,
    max: 4 * 1024 * 1024,
  })
  const sessionCookieName = readString(raw, 'sessionCookieName', issues)
  const trustProxy = readBoolean(raw, 'trustProxy', issues)
  const enabled = readBoolean(raw, 'enabled', issues)

  if (sessionCookieName !== undefined) {
    if (sessionCookieName.length > 64 || !COOKIE_NAME_RE.test(sessionCookieName)) {
      issues.push(issue('sessionCookieName 只能包含字母、数字、下划线、点与连字符，最长 64 个字符'))
    }
  }

  if (issues.length > 0) return issues

  return {
    port: port ?? API_DEFAULTS.port,
    bodyLimitBytes: bodyLimitBytes ?? API_DEFAULTS.bodyLimitBytes,
    sessionCookieName: sessionCookieName ?? API_DEFAULTS.sessionCookieName,
    trustProxy: trustProxy ?? API_DEFAULTS.trustProxy,
    enabled: enabled ?? API_DEFAULTS.enabled,
  }
}

export const API_CONFIG_SCHEMA = standardSchema<ResolvedApiConfig>(
  'dizzyapi',
  validateApiConfig,
  API_FIELDS,
)
