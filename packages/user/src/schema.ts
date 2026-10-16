import {
  checkConfigObject,
  readString,
  readStringArray,
  standardSchema,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 插件配置与其校验。
 *
 * cordis 在构造插件前会调用 `Config['~standard'].validate(config)`，
 * 校验不过就不构造插件。这里用的是 kit 里那份手写的 Standard Schema 实现。
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

const KNOWN_KEYS: readonly string[] = ['dataPath', 'adminPlugins', 'balanceWriters']

export function validateUserConfig(value: unknown): ResolvedUserConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)
  const balanceWriters = readStringArray(raw, 'balanceWriters', issues)

  if (issues.length > 0) return issues

  return { dataPath, adminPlugins: adminPlugins ?? [], balanceWriters }
}

export const USER_CONFIG_SCHEMA = standardSchema<ResolvedUserConfig>('dizzyapi', validateUserConfig)
