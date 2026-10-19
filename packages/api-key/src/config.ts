import {
  checkConfigObject,
  knownKeysOf,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'
import {
  API_KEY_MAX_KEYS_PER_USER_DEFAULT,
  API_KEY_MAX_KEYS_PER_USER_MAX,
  API_KEY_MAX_KEYS_PER_USER_MIN,
} from './types.ts'

/**
 * API key 插件配置。
 *
 * `dataPath` 省略 = 纯内存（`:memory:`），进程退出即丢；app.yml 里显式写
 * `./data/api-keys.db` 才是持久化。测试与内嵌用法通常不写它。
 */
export interface ApiKeyConfig {
  readonly dataPath?: string
  readonly maxKeysPerUser?: number
}

export interface ResolvedApiKeyConfig {
  readonly dataPath: string | undefined
  readonly maxKeysPerUser: number
}

export const API_KEY_DEFAULTS = {
  maxKeysPerUser: API_KEY_MAX_KEYS_PER_USER_DEFAULT,
} as const

/**
 * 字段元数据：**全部只读**。
 *
 * `dataPath` 决定数据落点；`maxKeysPerUser` 是配额上限，运行期改它会让
 * 已经建好的 key 数量与上限的关系变得不可预测。两者都必须由人在启动时决定。
 */
const API_KEY_FIELDS: readonly FieldSpec[] = [
  { key: 'dataPath', label: 'API key 数据库位置', kind: 'string', writable: false },
  {
    key: 'maxKeysPerUser',
    label: '每用户 key 上限',
    kind: 'integer',
    writable: false,
    min: API_KEY_MAX_KEYS_PER_USER_MIN,
    max: API_KEY_MAX_KEYS_PER_USER_MAX,
  },
]

const KNOWN_KEYS = knownKeysOf(API_KEY_FIELDS)

export function validateApiKeyConfig(value: unknown): ResolvedApiKeyConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const dataPath = readString(raw, 'dataPath', issues)
  const maxKeysPerUser = readPositiveInteger(raw, 'maxKeysPerUser', issues, {
    min: API_KEY_MAX_KEYS_PER_USER_MIN,
    max: API_KEY_MAX_KEYS_PER_USER_MAX,
  })

  if (issues.length > 0) return issues

  return {
    dataPath,
    maxKeysPerUser: maxKeysPerUser ?? API_KEY_DEFAULTS.maxKeysPerUser,
  }
}

export const API_KEY_CONFIG_SCHEMA = standardSchema<ResolvedApiKeyConfig>(
  'dizzyapi',
  validateApiKeyConfig,
  API_KEY_FIELDS,
)
