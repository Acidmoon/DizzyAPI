import {
  checkConfigObject,
  knownKeysOf,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 设置插件的配置。 */
export interface SettingsConfig {
  /**
   * 覆盖文件的落盘位置。省略则纯内存（进程退出即丢）——与 user / auth / credentials
   * 一致，部署时由 app.yml 明确给出 ./data/settings.json。
   */
  readonly dataPath?: string
  /**
   * 写白名单：只有列在这里的插件能改设置。省略或空 = 谁都不许（默认拒绝）。
   * 与 user 的 adminPlugins 同一个取向：写权限靠显式授权，不靠「没人试过」。
   */
  readonly adminPlugins?: readonly string[]
}

/**
 * 解析后的配置。字段与 user / auth 一样标成可选：cordis 拿构造函数参数推断
 * `ctx.plugin(X, config)` 里 config 的类型，因此这里保持「写不写都行」的形状，
 * 默认值由服务自己兜。
 */
export interface ResolvedSettingsConfig {
  readonly dataPath?: string | undefined
  readonly adminPlugins?: readonly string[]
}

/**
 * 字段元数据。两个字段都**不可写**：
 * 自改 `dataPath` 等于把覆盖文件挪到别处（要重启时由人决定），
 * 自改 `adminPlugins` 就是提权——拿一次写权限把自己变成永久管理员。
 */
const SETTINGS_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '覆盖文件位置', kind: 'string', writable: false },
  { key: 'adminPlugins', label: '可改设置的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(SETTINGS_FIELDS)

export function validateSettingsConfig(value: unknown): ResolvedSettingsConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const dataPath = readString(raw, 'dataPath', issues)
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)

  if (issues.length > 0) return issues

  return { dataPath, adminPlugins: adminPlugins ?? [] }
}

export const SETTINGS_CONFIG_SCHEMA = standardSchema<ResolvedSettingsConfig>(
  'dizzyapi',
  validateSettingsConfig,
  SETTINGS_FIELDS,
)
