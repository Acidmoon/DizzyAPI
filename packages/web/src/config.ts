/**
 * 前端入口的配置。只绑 127.0.0.1；端口冲突直接失败，不静默换端口。
 */
export interface WebConfig {
  /** 监听端口。`0` = 系统分配（测试用）。 */
  readonly port?: number
  /** 会话 cookie 名；必须与 `auth` / `api` 一致。 */
  readonly sessionCookieName?: string
  /** 是否随插件启动。false 时插件装载但不监听。 */
  readonly enabled?: boolean
}

export interface ResolvedWebConfig {
  readonly port: number
  readonly sessionCookieName: string
  readonly enabled: boolean
}

export const WEB_DEFAULTS = {
  port: 7792,
  sessionCookieName: 'dizzyapi_session',
  enabled: true,
} as const

export function validateWebConfig(value: unknown): ResolvedWebConfig | readonly string[] {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    return ['配置必须是一个对象']
  }
  const raw = (value ?? {}) as Record<string, unknown>
  const allowed = new Set(['port', 'sessionCookieName', 'enabled'])
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key))
  if (unknown.length > 0) return [`未知配置字段：${unknown.join(', ')}`]

  const port = raw.port === undefined ? WEB_DEFAULTS.port : raw.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535) {
    return ['port 必须是 0..65535 的整数']
  }
  const cookie = raw.sessionCookieName === undefined ? WEB_DEFAULTS.sessionCookieName : raw.sessionCookieName
  if (typeof cookie !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(cookie)) {
    return ['sessionCookieName 只能包含字母、数字、下划线、点与连字符']
  }
  const enabled = raw.enabled === undefined ? WEB_DEFAULTS.enabled : raw.enabled
  if (typeof enabled !== 'boolean') return ['enabled 必须是布尔值']
  return { port, sessionCookieName: cookie, enabled }
}
