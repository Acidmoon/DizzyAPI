/**
 * 控制台插件的配置。
 *
 * `app.yml` 里对应一条 entry。字段全部**只读**（`writable: false`）：改端口会让
 * 插件重启并换一个地址，而 nginx 反代的是固定端口；改产物目录会让页面 503。
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

import { defaultDistDir } from './paths.ts'

export interface DashboardConfig {
  /** 监听端口；`0` = 让系统分配（测试用）。 */
  readonly port?: number
  /** 静态产物目录；默认 `packages/dashboard/dist`。 */
  readonly distDir?: string
  /** 是否随插件启动 HTTP 服务。 */
  readonly enabled?: boolean
  /** 额外允许的 `Host` 头，逗号分隔；生产反代没改写 Host 时才需要。 */
  readonly extraAllowedHosts?: string
}

export interface ResolvedDashboardConfig {
  readonly port: number
  readonly distDir: string
  readonly enabled: boolean
  readonly extraAllowedHosts: readonly string[]
}

export const DASHBOARD_DEFAULTS = {
  port: 7792,
  enabled: true,
} as const

const FIELDS: readonly FieldSpec[] = [
  { key: 'port', label: '监听端口', kind: 'integer', min: 0, max: 65535, writable: false },
  { key: 'distDir', label: '静态产物目录', kind: 'string', writable: false },
  { key: 'enabled', label: '随插件启动控制台服务', kind: 'boolean', writable: false },
  { key: 'extraAllowedHosts', label: '额外允许的 Host（逗号分隔）', kind: 'string', writable: false },
]

const KNOWN_KEYS = knownKeysOf(FIELDS)

function parseHostList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

export function validateDashboardConfig(value: unknown): ResolvedDashboardConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const port = readPositiveInteger(raw, 'port', issues, { min: 0, max: 65535 })
  const distDir = readString(raw, 'distDir', issues)
  const enabled = readBoolean(raw, 'enabled', issues)
  const extraAllowedHosts = readString(raw, 'extraAllowedHosts', issues)

  if (distDir !== undefined && distDir.trim() === '') {
    issues.push({ message: 'distDir 不能是空字符串' } as never)
  }

  if (issues.length > 0) return issues

  return {
    port: port ?? DASHBOARD_DEFAULTS.port,
    distDir: distDir ?? defaultDistDir(),
    enabled: enabled ?? DASHBOARD_DEFAULTS.enabled,
    extraAllowedHosts: parseHostList(extraAllowedHosts),
  }
}

export const DASHBOARD_CONFIG_SCHEMA = standardSchema<ResolvedDashboardConfig>(
  'dizzyapi',
  validateDashboardConfig,
  FIELDS,
)
