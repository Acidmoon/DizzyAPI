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

/** 前端宿主配置。所有 URL 都是**公开路径**，不含任何秘密。 */
export interface FrontendConfig {
  /** 版本目录、指针与 manifest 的落盘位置。相对路径按 cordis 的 baseUrl 解析。 */
  readonly dataPath?: string
  /** 版本化静态资源的公开前缀；实际目录是 `<publicBase>/<version>/`。 */
  readonly publicBase?: string
  /** 界面请求的 API 前缀；`''` = 同源根，也可给绝对 URL。 */
  readonly apiBase?: string
  /** SPA 部署前缀（反代挂子路径时用）；`''` = 根。 */
  readonly basePath?: string
  /** `rest` 调真实 API；`mock` 只在开发预览与本地演示里用。 */
  readonly mode?: 'rest' | 'mock'
  /** mock 适配器的假延迟，毫秒。 */
  readonly mockLatencyMs?: number
  /** 保留的版本数（含当前版本）；最少 2，保证回滚目标还在。 */
  readonly keepVersions?: number
  /** 启动时把包内 `assets/` 安装成当前版本。 */
  readonly autoInstall?: boolean
}

export interface ResolvedFrontendConfig {
  readonly dataPath: string
  readonly publicBase: string
  readonly apiBase: string
  readonly basePath: string
  readonly mode: 'rest' | 'mock'
  readonly mockLatencyMs: number
  readonly keepVersions: number
  readonly autoInstall: boolean
}

export const FRONTEND_DEFAULTS = {
  dataPath: './data/frontend',
  publicBase: '/assets/frontend',
  apiBase: '/api',
  basePath: '',
  mode: 'rest',
  mockLatencyMs: 120,
  keepVersions: 2,
  autoInstall: true,
} as const

const FRONTEND_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '资源与清单目录', kind: 'string', writable: false },
  { key: 'publicBase', label: '静态资源公开前缀', kind: 'string', writable: false },
  { key: 'apiBase', label: '界面 API 前缀', kind: 'string', writable: false },
  { key: 'basePath', label: 'SPA 部署前缀', kind: 'string', writable: false },
  {
    key: 'mode',
    label: 'API 模式',
    kind: 'enum',
    values: ['rest', 'mock'],
    writable: false,
  },
  { key: 'mockLatencyMs', label: 'mock 延迟（毫秒）', kind: 'integer', min: 0, max: 10_000, writable: true, unit: '毫秒' },
  { key: 'keepVersions', label: '保留版本数', kind: 'integer', min: 2, max: 20, writable: true },
  { key: 'autoInstall', label: '启动时安装内置资源', kind: 'boolean', writable: true },
]

const KNOWN_KEYS = knownKeysOf(FRONTEND_FIELDS)

export function validateFrontendConfig(value: unknown): ResolvedFrontendConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const publicBase = readMountPath(raw, 'publicBase', issues, { allowRoot: false })
  const apiBase = readApiBase(raw, 'apiBase', issues)
  const basePath = readMountPath(raw, 'basePath', issues, { allowRoot: true })
  const mode = readString(raw, 'mode', issues)
  if (mode !== undefined && mode !== 'rest' && mode !== 'mock') {
    issues.push(issue('mode 只能是 rest 或 mock'))
  }
  const mockLatencyMs = readPositiveInteger(raw, 'mockLatencyMs', issues, { min: 0, max: 10_000 })
  const keepVersions = readPositiveInteger(raw, 'keepVersions', issues, { min: 2, max: 20 })
  const autoInstall = readBoolean(raw, 'autoInstall', issues)

  if (issues.length > 0) return issues

  return {
    dataPath: dataPath ?? FRONTEND_DEFAULTS.dataPath,
    publicBase: publicBase ?? FRONTEND_DEFAULTS.publicBase,
    apiBase: apiBase ?? FRONTEND_DEFAULTS.apiBase,
    basePath: basePath ?? FRONTEND_DEFAULTS.basePath,
    mode: (mode as 'rest' | 'mock' | undefined) ?? FRONTEND_DEFAULTS.mode,
    mockLatencyMs: mockLatencyMs ?? FRONTEND_DEFAULTS.mockLatencyMs,
    keepVersions: keepVersions ?? FRONTEND_DEFAULTS.keepVersions,
    autoInstall: autoInstall ?? FRONTEND_DEFAULTS.autoInstall,
  }
}

export const FRONTEND_CONFIG_SCHEMA = standardSchema<ResolvedFrontendConfig>(
  'dizzyapi',
  validateFrontendConfig,
  FRONTEND_FIELDS,
)

/**
 * 公开挂载路径：`/a/b`，不带尾斜杠；`/` 归一成 `''`（根）。
 * 拒绝协议、查询串、片段与 `..`，因为它们会改变「这条路径属于谁」。
 */
function readMountPath(
  raw: Record<string, unknown>,
  key: string,
  issues: StandardIssue[],
  options: { readonly allowRoot: boolean },
): string | undefined {
  const value = readString(raw, key, issues, { allowEmpty: true })
  if (value === undefined) return undefined
  if (value === '') {
    if (options.allowRoot) return ''
    issues.push(issue(`${key} 不能为空`))
    return undefined
  }
  const normalized = normalizeMountPath(value)
  if (normalized === undefined) {
    issues.push(issue(`${key} 必须是以 / 开头的挂载路径，且不能含协议、查询串、片段或 ..`))
    return undefined
  }
  return normalized
}

function readApiBase(
  raw: Record<string, unknown>,
  key: string,
  issues: StandardIssue[],
): string | undefined {
  const value = readString(raw, key, issues, { allowEmpty: true })
  if (value === undefined) return undefined
  if (value === '') return ''
  if (value.startsWith('http://') || value.startsWith('https://')) {
    try {
      const url = new URL(value)
      if (url.search !== '' || url.hash !== '') {
        issues.push(issue(`${key} 不能带查询串或片段`))
        return undefined
      }
      return url.toString().replace(/\/$/, '')
    } catch {
      issues.push(issue(`${key} 不是合法的 URL`))
      return undefined
    }
  }
  const normalized = normalizeMountPath(value)
  if (normalized === undefined) {
    issues.push(issue(`${key} 必须是与源路径或 http(s) URL`))
    return undefined
  }
  return normalized
}

export function normalizeMountPath(value: string): string | undefined {
  if (!value.startsWith('/')) return undefined
  if (value.includes('?') || value.includes('#')) return undefined
  const parts: string[] = []
  for (const part of value.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') return undefined
    parts.push(part)
  }
  return parts.length === 0 ? '' : `/${parts.join('/')}`
}
