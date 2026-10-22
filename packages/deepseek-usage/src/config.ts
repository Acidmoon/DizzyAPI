/**
 * 「用量信息」页的配置。
 *
 * 页面路径、端口、是否启用都在这里声明；`app.yml` 里对应一条 entry。
 */
import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 页面插件的配置。 */
export interface DeepseekUsageConfig {
  /** 监听端口。`0` = 让系统分配（测试用）。 */
  readonly port?: number
  /** 页面挂载路径；默认 `/console/usage`。 */
  readonly basePath?: string
  /** 控制台入口的绝对地址；侧栏的「API keys / 充值 / 账单」指向它。 */
  readonly consoleBaseUrl?: string
  /** 是否随插件启动 HTTP 服务。 */
  readonly enabled?: boolean
  /** 会话 cookie 名；与 `api` 插件保持一致才能复用登录态。 */
  readonly sessionCookieName?: string
}

export interface ResolvedDeepseekUsageConfig {
  readonly port: number
  readonly basePath: string
  readonly consoleBaseUrl: string
  readonly enabled: boolean
  readonly sessionCookieName: string
}

export const DEEPSEEK_USAGE_DEFAULTS = {
  port: 7793,
  basePath: '/console/usage',
  consoleBaseUrl: 'http://127.0.0.1:7791',
  enabled: true,
  sessionCookieName: 'dizzyapi_session',
} as const

/**
 * 字段元数据。全部**不可写**：
 *
 * - 改 `port` 会让插件重启并换一个地址，地址只出现在启动日志里；
 * - 改 `basePath` 会让已收藏的页面地址失效；
 * - 会话 cookie 名要与 `api` 插件一致才有意义。
 */
const FIELDS: readonly FieldSpec[] = [
  { key: 'port', label: '监听端口', kind: 'integer', min: 0, max: 65535, writable: false },
  { key: 'basePath', label: '页面路径', kind: 'string', writable: false },
  { key: 'consoleBaseUrl', label: '控制台地址', kind: 'string', writable: false },
  { key: 'enabled', label: '随插件启动页面服务', kind: 'boolean', writable: false },
  { key: 'sessionCookieName', label: '会话 cookie 名', kind: 'string', writable: false },
]

const KNOWN_KEYS = knownKeysOf(FIELDS)

export function validateDeepseekUsageConfig(
  value: unknown,
): ResolvedDeepseekUsageConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const port = readPositiveInteger(raw, 'port', issues, { min: 0, max: 65535 })
  const basePath = readString(raw, 'basePath', issues)
  const consoleBaseUrl = readString(raw, 'consoleBaseUrl', issues)
  const enabled = readBoolean(raw, 'enabled', issues)
  const sessionCookieName = readString(raw, 'sessionCookieName', issues)

  if (basePath !== undefined && !basePath.startsWith('/')) {
    issues.push({ message: 'basePath 必须以 / 开头' } as never)
  }
  if (consoleBaseUrl !== undefined && !/^https?:\/\//.test(consoleBaseUrl)) {
    issues.push({ message: 'consoleBaseUrl 必须是 http(s) 开头的绝对地址' } as never)
  }
  if (sessionCookieName !== undefined && !/^[A-Za-z0-9_.-]+$/.test(sessionCookieName)) {
    issues.push({ message: 'sessionCookieName 只能包含字母、数字、下划线、点与连字符' } as never)
  }

  if (issues.length > 0) return issues

  return {
    port: port ?? DEEPSEEK_USAGE_DEFAULTS.port,
    basePath: basePath ?? DEEPSEEK_USAGE_DEFAULTS.basePath,
    consoleBaseUrl: (consoleBaseUrl ?? DEEPSEEK_USAGE_DEFAULTS.consoleBaseUrl).replace(/\/+$/, ''),
    enabled: enabled ?? DEEPSEEK_USAGE_DEFAULTS.enabled,
    sessionCookieName: sessionCookieName ?? DEEPSEEK_USAGE_DEFAULTS.sessionCookieName,
  }
}

export const DEEPSEEK_USAGE_CONFIG_SCHEMA = standardSchema<ResolvedDeepseekUsageConfig>(
  'dizzyapi',
  validateDeepseekUsageConfig,
  FIELDS,
)
