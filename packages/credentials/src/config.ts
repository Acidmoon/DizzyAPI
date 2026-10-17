import {
  checkConfigObject,
  knownKeysOf,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/** 凭据插件的配置。 */
export interface CredentialsConfig {
  /**
   * 凭据文件的落盘位置。省略则纯内存（进程退出即丢）——与 user / auth 一致，
   * 部署时由 app.yml 明确给出 ./data/credentials.json。
   */
  readonly dataPath?: string
}

/**
 * 解析后的配置。字段与 user / auth 一样标成可选：cordis 拿构造函数参数推断
 * `ctx.plugin(X, config)` 里 config 的类型，因此这里保持「写不写都行」的形状，
 * 默认值由服务自己兜（`?? undefined` 那一步）。
 */
export interface ResolvedCredentialsConfig {
  readonly dataPath?: string | undefined
}

/**
 * 字段元数据。`dataPath` 不可写：改它等于换一个秘密仓库，必须重启时由人决定，
 * 不能让设置插件在运行期把凭据读写的落点改到别处去。
 */
const CREDENTIALS_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: '凭据文件位置', kind: 'string', writable: false },
]

const KNOWN_KEYS = knownKeysOf(CREDENTIALS_FIELDS)

export function validateCredentialsConfig(
  value: unknown,
): ResolvedCredentialsConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const dataPath = readString(raw, 'dataPath', issues)

  if (issues.length > 0) return issues

  return { dataPath }
}

export const CREDENTIALS_CONFIG_SCHEMA = standardSchema<ResolvedCredentialsConfig>(
  'dizzyapi',
  validateCredentialsConfig,
  CREDENTIALS_FIELDS,
)
