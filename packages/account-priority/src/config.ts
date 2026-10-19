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

export interface AccountPriorityConfig {
  /** 策略组文件；省略则纯内存（测试用）。 */
  readonly dataPath?: string
  /** gatewayd 可执行文件；相对路径按 app.yml 所在目录解析。 */
  readonly binaryPath?: string
  /** 追加给 gatewayd 的参数。 */
  readonly args?: string[]
  /** 是否随插件启动 gatewayd。 */
  readonly autoStart?: boolean
  /** Unix socket 路径；Windows 自动走 TCP，不需要它。 */
  readonly socketPath?: string
  /** 控制桥传输：auto（Windows=TCP，其他=Unix）/ unix / tcp。 */
  readonly transport?: 'auto' | 'unix' | 'tcp'
  /** LLM 请求 HTTP 入口；只允许回环地址。 */
  readonly httpListen?: string
  /**
   * 各 provider 的上游 OpenAI 兼容 base URL。
   * 只有配了映射的 provider 会被推给 Go；快照里不含没有上游地址的账号。
   */
  readonly upstreamBaseUrls?: Readonly<Record<string, string>>
  /** 从 spawn 到收到 ready 行并完成握手的超时。 */
  readonly startTimeoutMs?: number
  /** 单次桥请求超时。 */
  readonly requestTimeoutMs?: number
  /** 优雅停止的等待时间；超时后再强杀。 */
  readonly stopTimeoutMs?: number
  /** 子进程意外退出后的首次重试延迟。 */
  readonly restartDelayMs?: number
  /** 重试延迟上限。 */
  readonly maxRestartDelayMs?: number
  /** gatewayd 日志格式。 */
  readonly logFormat?: 'text' | 'json'
}

export interface ResolvedAccountPriorityConfig {
  readonly dataPath: string | undefined
  readonly binaryPath: string
  readonly args: readonly string[]
  readonly autoStart: boolean
  readonly socketPath: string
  readonly transport: 'auto' | 'unix' | 'tcp'
  readonly httpListen: string
  readonly upstreamBaseUrls: Readonly<Record<string, string>>
  readonly startTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly restartDelayMs: number
  readonly maxRestartDelayMs: number
  readonly logFormat: 'text' | 'json'
}

export const ACCOUNT_PRIORITY_DEFAULTS = {
  binaryPath: './bin/gatewayd',
  args: [] as readonly string[],
  autoStart: true,
  socketPath: './data/gatewayd.sock',
  transport: 'auto',
  httpListen: '127.0.0.1:8080',
  upstreamBaseUrls: {
    openai: 'https://api.openai.com/v1',
  } as Readonly<Record<string, string>>,
  startTimeoutMs: 10_000,
  requestTimeoutMs: 5_000,
  stopTimeoutMs: 5_000,
  restartDelayMs: 1_000,
  maxRestartDelayMs: 30_000,
  logFormat: 'text',
} as const

/**
 * 字段元数据。
 *
 * 可写的是「怎么等、怎么退避」这类运行期调优；`dataPath` / `binaryPath` / `args` /
 * `socketPath` / `transport` 改的是「子进程是谁、数据在哪」，必须由人在启动时决定。
 */
const ACCOUNT_PRIORITY_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '策略文件位置', kind: 'string', writable: false },
  { key: 'binaryPath', label: 'gatewayd 路径', kind: 'string', writable: false },
  { key: 'args', label: '额外参数', kind: 'stringArray', writable: false },
  { key: 'autoStart', label: '随插件启动', kind: 'boolean', writable: true },
  { key: 'socketPath', label: 'Unix socket 路径', kind: 'string', writable: false },
  {
    key: 'transport',
    label: '控制桥传输',
    kind: 'enum',
    values: ['auto', 'unix', 'tcp'],
    writable: false,
  },
  { key: 'httpListen', label: 'LLM 请求监听地址', kind: 'string', writable: false },
  {
    key: 'upstreamBaseUrls',
    label: '上游 OpenAI 兼容地址（按 provider）',
    kind: 'object',
    writable: false,
  },
  {
    key: 'startTimeoutMs',
    label: '启动超时',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 120_000,
    unit: '毫秒',
  },
  {
    key: 'requestTimeoutMs',
    label: '桥请求超时',
    kind: 'integer',
    writable: true,
    min: 100,
    max: 120_000,
    unit: '毫秒',
  },
  {
    key: 'stopTimeoutMs',
    label: '优雅停止超时',
    kind: 'integer',
    writable: true,
    min: 500,
    max: 60_000,
    unit: '毫秒',
  },
  {
    key: 'restartDelayMs',
    label: '重启退避基数',
    kind: 'integer',
    writable: true,
    min: 100,
    max: 60_000,
    unit: '毫秒',
  },
  {
    key: 'maxRestartDelayMs',
    label: '重启退避上限',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 600_000,
    unit: '毫秒',
  },
  {
    key: 'logFormat',
    label: 'gatewayd 日志格式',
    kind: 'enum',
    values: ['text', 'json'],
    writable: false,
  },
]

const KNOWN_KEYS = knownKeysOf(ACCOUNT_PRIORITY_FIELDS)

export function validateAccountPriorityConfig(
  value: unknown,
): ResolvedAccountPriorityConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const binaryPath = readString(raw, 'binaryPath', issues)
  const args = readStringArray(raw, 'args', issues)
  const autoStart = readBoolean(raw, 'autoStart', issues)
  const socketPath = readString(raw, 'socketPath', issues)
  const transport = readString(raw, 'transport', issues)
  if (transport !== undefined && !['auto', 'unix', 'tcp'].includes(transport)) {
    issues.push({ message: 'transport 只能是 auto / unix / tcp' })
  }
  const httpListen = readString(raw, 'httpListen', issues)
  if (httpListen !== undefined && !isLoopbackListen(httpListen)) {
    issues.push({ message: 'httpListen 必须是回环地址，如 127.0.0.1:8080' })
  }
  const upstreamBaseUrls = readBaseUrls(raw['upstreamBaseUrls'], issues)
  const startTimeoutMs = readPositiveInteger(raw, 'startTimeoutMs', issues, { min: 1_000, max: 120_000 })
  const requestTimeoutMs = readPositiveInteger(raw, 'requestTimeoutMs', issues, { min: 100, max: 120_000 })
  const stopTimeoutMs = readPositiveInteger(raw, 'stopTimeoutMs', issues, { min: 500, max: 60_000 })
  const restartDelayMs = readPositiveInteger(raw, 'restartDelayMs', issues, { min: 100, max: 60_000 })
  const maxRestartDelayMs = readPositiveInteger(raw, 'maxRestartDelayMs', issues, {
    min: 1_000,
    max: 600_000,
  })
  const logFormat = readString(raw, 'logFormat', issues)
  if (logFormat !== undefined && !['text', 'json'].includes(logFormat)) {
    issues.push({ message: 'logFormat 只能是 text / json' })
  }
  if (
    restartDelayMs !== undefined &&
    maxRestartDelayMs !== undefined &&
    maxRestartDelayMs < restartDelayMs
  ) {
    issues.push({ message: 'maxRestartDelayMs 不能小于 restartDelayMs' })
  }

  if (issues.length > 0) return issues

  return {
    dataPath,
    binaryPath: binaryPath ?? ACCOUNT_PRIORITY_DEFAULTS.binaryPath,
    args: args ?? ACCOUNT_PRIORITY_DEFAULTS.args,
    autoStart: autoStart ?? ACCOUNT_PRIORITY_DEFAULTS.autoStart,
    socketPath: socketPath ?? ACCOUNT_PRIORITY_DEFAULTS.socketPath,
    transport: (transport as ResolvedAccountPriorityConfig['transport'] | undefined) ??
      ACCOUNT_PRIORITY_DEFAULTS.transport,
    httpListen: httpListen ?? ACCOUNT_PRIORITY_DEFAULTS.httpListen,
    upstreamBaseUrls: {
      ...ACCOUNT_PRIORITY_DEFAULTS.upstreamBaseUrls,
      ...(upstreamBaseUrls ?? {}),
    },
    startTimeoutMs: startTimeoutMs ?? ACCOUNT_PRIORITY_DEFAULTS.startTimeoutMs,
    requestTimeoutMs: requestTimeoutMs ?? ACCOUNT_PRIORITY_DEFAULTS.requestTimeoutMs,
    stopTimeoutMs: stopTimeoutMs ?? ACCOUNT_PRIORITY_DEFAULTS.stopTimeoutMs,
    restartDelayMs: restartDelayMs ?? ACCOUNT_PRIORITY_DEFAULTS.restartDelayMs,
    maxRestartDelayMs: maxRestartDelayMs ?? ACCOUNT_PRIORITY_DEFAULTS.maxRestartDelayMs,
    logFormat: (logFormat as ResolvedAccountPriorityConfig['logFormat'] | undefined) ??
      ACCOUNT_PRIORITY_DEFAULTS.logFormat,
  }
}

function readBaseUrls(
  value: unknown,
  issues: StandardIssue[],
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ message: 'upstreamBaseUrls 必须是 provider → URL 的对象' })
    return undefined
  }
  const out: Record<string, string> = {}
  for (const [provider, rawUrl] of Object.entries(value)) {
    if (provider.trim() === '') {
      issues.push({ message: 'upstreamBaseUrls 的 provider 不能为空' })
      continue
    }
    if (typeof rawUrl !== 'string' || !isHttpUrl(rawUrl)) {
      issues.push({ message: `upstreamBaseUrls.${provider} 必须是 http(s) URL` })
      continue
    }
    out[provider] = rawUrl.trim()
  }
  return out
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== ''
  } catch {
    return false
  }
}

/** 只接受 127.0.0.1 / ::1 / localhost，端口允许 0（测试时由系统分配）。 */
function isLoopbackListen(value: string): boolean {
  const separator = value.lastIndexOf(':')
  if (separator <= 0) return false
  let host = value.slice(0, separator)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') return false
  const port = Number(value.slice(separator + 1))
  return Number.isInteger(port) && port >= 0 && port <= 65_535
}

export const ACCOUNT_PRIORITY_CONFIG_SCHEMA = standardSchema<ResolvedAccountPriorityConfig>(
  'dizzyapi',
  validateAccountPriorityConfig,
  ACCOUNT_PRIORITY_FIELDS,
)
