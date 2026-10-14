/**
 * 插件配置与其校验。
 *
 * cordis 在构造插件前会调用 `Config['~standard'].validate(config)`，
 * 校验不过就不构造插件。这里**手写**这段 Standard Schema 实现，而不是引入
 * schemastery：本插件目前是仓库里唯一需要 schema 的地方，为一个配置面引入
 * 依赖不划算。等有第二个、第三个插件要 schema 时，再把这段提升为共享包，
 * 或统一换成 schemastery。
 *
 * 校验策略是保守的：未知字段直接报错，不做静默忽略——配置写错必须立刻可见。
 */

export interface UserConfig {
  /**
   * 用户数据落盘路径。省略则纯内存，进程退出即丢。
   * 相对路径按 cordis 的 baseUrl（通常就是工作目录）解析。
   */
  readonly dataPath?: string
  /**
   * 「指定插件」白名单：只有列在这里的插件名可以改动用户表单。
   * 省略或空数组 = 谁都不许（默认拒绝，见 AGENTS.md D7 的取向）。
   */
  readonly adminPlugins?: readonly string[]
  /**
   * 余额写入白名单。省略 = 不限制，任何插件都可以改余额——
   * 这与「余额接口供其他插件读取与修改」的需求一致。
   * 需要收窄时列出插件名即可，读取始终不限。
   */
  readonly balanceWriters?: readonly string[]
}

/**
 * 校验之后的配置：字段都变成可选，默认值的语义在 UserService 里解释。
 * 这样测试与内嵌用法可以只写自己关心的那几个字段。
 */
export interface ResolvedUserConfig {
  readonly dataPath?: string | undefined
  readonly adminPlugins?: readonly string[]
  readonly balanceWriters?: readonly string[] | undefined
}

export interface StandardIssue {
  readonly message: string
}

export interface StandardSchema<Output> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Output } | { readonly issues: readonly StandardIssue[] }
  }
}

const KNOWN_KEYS: readonly string[] = ['dataPath', 'adminPlugins', 'balanceWriters']

export function validateUserConfig(value: unknown): readonly StandardIssue[] {
  const issues: StandardIssue[] = []

  if (value === undefined || value === null) return issues
  if (typeof value !== 'object' || Array.isArray(value)) {
    return [{ message: '用户插件配置必须是一个对象' }]
  }

  const raw = value as Record<string, unknown>

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      issues.push({ message: `未知配置项：${key}（可用项：${KNOWN_KEYS.join(' / ')}）` })
    }
  }

  if (raw.dataPath !== undefined) {
    if (typeof raw.dataPath !== 'string' || raw.dataPath.trim() === '') {
      issues.push({ message: 'dataPath 必须是非空字符串' })
    }
  }

  for (const key of ['adminPlugins', 'balanceWriters'] as const) {
    const entry = raw[key]
    if (entry === undefined) continue
    if (!Array.isArray(entry)) {
      issues.push({ message: `${key} 必须是字符串数组` })
      continue
    }
    for (const name of entry) {
      if (typeof name !== 'string' || name.trim() === '') {
        issues.push({ message: `${key} 里的元素必须是非空字符串` })
        break
      }
    }
  }

  return issues
}

export function resolveUserConfig(value: unknown): ResolvedUserConfig {
  const raw = (value ?? {}) as Record<string, unknown>
  return {
    dataPath: typeof raw.dataPath === 'string' ? raw.dataPath : undefined,
    adminPlugins: Array.isArray(raw.adminPlugins) ? [...(raw.adminPlugins as string[])] : [],
    balanceWriters: Array.isArray(raw.balanceWriters) ? [...(raw.balanceWriters as string[])] : undefined,
  }
}

export const USER_CONFIG_SCHEMA: StandardSchema<ResolvedUserConfig> = {
  '~standard': {
    version: 1,
    vendor: 'dizzyapi',
    validate(value: unknown) {
      const issues = validateUserConfig(value)
      if (issues.length > 0) return { issues }
      return { value: resolveUserConfig(value) }
    },
  },
}
