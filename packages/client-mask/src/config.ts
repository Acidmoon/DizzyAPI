/**
 * 插件配置。
 *
 * 三项，都很克制：
 * - `enabled`：整套伪装的总闸（停掉 = 所有账号都按「不伪装」发请求，但档案不丢）；
 * - `dataPath`：档案 JSON 的落点；
 * - `adminPlugins`：谁能改档案（默认拒绝，与 `settings` / `user` 的取向一致）。
 *
 * 配置非法**启动即失败**（AGENTS.md §2.4.5）：这里只有「未知键 / 类型不对 / 空字符串」三类，
 * 都能在构造期一眼看出来。
 */
import { checkConfigObject, isIssueList, readBoolean, readString, readStringArray, standardSchema } from '@dizzyapi/plugin-kit'
import type { FieldSpec } from '@dizzyapi/plugin-kit'

/** 配置项元数据（设置页据此渲染；`writable` 默认拒绝）。 */
export const CLIENT_MASK_FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', label: '启用客户端指纹伪装', kind: 'boolean', writable: true },
  { key: 'dataPath', label: '档案文件路径', kind: 'string', writable: false },
  {
    key: 'adminPlugins',
    label: '可以改档案的插件',
    kind: 'stringArray',
    writable: false,
  },
]

const KNOWN_KEYS = CLIENT_MASK_FIELDS.map((field) => field.key)

export interface ClientMaskConfig {
  readonly enabled?: boolean
  readonly dataPath?: string
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedClientMaskConfig {
  readonly enabled: boolean
  readonly dataPath: string
  readonly adminPlugins: readonly string[]
}

export const CLIENT_MASK_DEFAULTS = {
  enabled: true,
  dataPath: './data/client-mask.json',
} as const

export function resolveClientMaskConfig(
  value: unknown,
): ResolvedClientMaskConfig | readonly { readonly message: string }[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)
  const enabled = readBoolean(raw, 'enabled', issues as { message: string }[])
  const dataPath = readString(raw, 'dataPath', issues as { message: string }[])
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues as { message: string }[])
  if (issues.length > 0) return issues as readonly { message: string }[]
  return {
    enabled: enabled ?? CLIENT_MASK_DEFAULTS.enabled,
    dataPath: dataPath ?? CLIENT_MASK_DEFAULTS.dataPath,
    adminPlugins: adminPlugins ?? [],
  }
}

/** cordis 读取的配置 schema；校验不过就不构造插件。 */
export const CLIENT_MASK_CONFIG_SCHEMA = standardSchema<ResolvedClientMaskConfig>(
  'dizzyapi/client-mask',
  (value) => {
    const resolved = resolveClientMaskConfig(value)
    return isIssueList(resolved) ? resolved : resolved
  },
  CLIENT_MASK_FIELDS,
)
