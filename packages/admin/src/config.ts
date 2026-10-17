import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 面板自己的配置。 */
export interface AdminConfig {
  /** 监听端口。`0` = 让系统分配（测试用），实际端口从 `admin.address` 读。 */
  readonly port?: number
  /** 请求体上限，字节。 */
  readonly bodyLimitBytes?: number
  /** 运行时概览的采样间隔。 */
  readonly overviewIntervalMs?: number
  /** SSE 心跳间隔；心跳是注释行，不是事件。 */
  readonly sseHeartbeatMs?: number
  /** 同时打开的 SSE 连接上限。 */
  readonly maxSseClients?: number
}

export interface ResolvedAdminConfig {
  readonly port?: number | undefined
  readonly bodyLimitBytes?: number | undefined
  readonly overviewIntervalMs?: number | undefined
  readonly sseHeartbeatMs?: number | undefined
  readonly maxSseClients?: number | undefined
}

export const ADMIN_DEFAULTS = {
  port: 7788,
  bodyLimitBytes: 64 * 1024,
  overviewIntervalMs: 2_000,
  sseHeartbeatMs: 15_000,
  maxSseClients: 32,
} as const

/**
 * 字段元数据。全部**不可写**：
 *
 * - 改 `port` 会让面板重启并换一个地址，而地址只出现在启动日志里——等于把自己关在门外；
 * - `bodyLimitBytes` / 采样间隔这些是运维参数，改它们没有「运行期」的必要。
 *
 * 默认拒绝是本项目的取向（见 kit 的 FieldSpec）：没写 `writable` 就是不可写。
 */
const ADMIN_FIELDS: readonly FieldSpec[] = [
  { key: 'port', label: '监听端口', kind: 'integer', min: 0, max: 65535, writable: false },
  { key: 'bodyLimitBytes', label: '请求体上限（字节）', kind: 'integer', min: 1024, max: 1048576, writable: false },
  { key: 'overviewIntervalMs', label: '概览采样间隔（毫秒）', kind: 'integer', min: 500, max: 60000, writable: false },
  { key: 'sseHeartbeatMs', label: 'SSE 心跳间隔（毫秒）', kind: 'integer', min: 1000, max: 60000, writable: false },
  { key: 'maxSseClients', label: 'SSE 连接上限', kind: 'integer', min: 1, max: 256, writable: false },
]

const KNOWN_KEYS = knownKeysOf(ADMIN_FIELDS)

export function validateAdminConfig(value: unknown): ResolvedAdminConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  // port 允许 0（系统分配），所以 min 显式给 0——readPositiveInteger 的名字有误导性，
  // 它其实只要求「安全整数」，范围全靠调用方给。
  const port = readPositiveInteger(raw, 'port', issues, { min: 0, max: 65535 })
  const bodyLimitBytes = readPositiveInteger(raw, 'bodyLimitBytes', issues, { min: 1024, max: 1048576 })
  const overviewIntervalMs = readPositiveInteger(raw, 'overviewIntervalMs', issues, { min: 500, max: 60000 })
  const sseHeartbeatMs = readPositiveInteger(raw, 'sseHeartbeatMs', issues, { min: 1000, max: 60000 })
  const maxSseClients = readPositiveInteger(raw, 'maxSseClients', issues, { min: 1, max: 256 })

  if (issues.length > 0) return issues

  return { port, bodyLimitBytes, overviewIntervalMs, sseHeartbeatMs, maxSseClients }
}

export const ADMIN_CONFIG_SCHEMA = standardSchema<ResolvedAdminConfig>(
  'dizzyapi',
  validateAdminConfig,
  ADMIN_FIELDS,
)
