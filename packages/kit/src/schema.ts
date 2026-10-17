/**
 * 手写的 Standard Schema 实现与几个字段校验小工具。
 *
 * 为什么手写而不是引入 schemastery：cordis 只要求
 * `Config['~standard'].validate(config)`（必须同步返回），任何符合 Standard Schema 的
 * 对象都可以。当前配置面都很小，为它们引依赖不划算；等配置面变大或包多起来，
 * 再把这里换成 schemastery 也只需要改这一个文件。
 *
 * 校验策略保守：未知字段直接报错，不做静默忽略——配置写错必须立刻可见。
 */

export interface StandardIssue {
  readonly message: string
}

/**
 * 字段元数据：**声明**，不是校验。
 *
 * 合法性的唯一真相始终是 `validate`；`fields` 只用来让「设置插件 / 界面」知道
 * 有哪些字段、怎么称呼它们、哪些允许在运行期改写。两份列表靠 `knownKeysOf()`
 * 保持不漂移——配置校验里的已知键就是从这里派生的。
 *
 * 默认拒绝：`writable` 不写就是不可写；没有声明 `fields` 的插件，整个配置面只读。
 */
export type FieldKind = 'string' | 'boolean' | 'integer' | 'enum' | 'stringArray' | 'object'

export interface FieldSpec {
  /** 配置对象里的键名。 */
  readonly key: string
  /** 人类可读标签（中文），界面与排障用。 */
  readonly label: string
  readonly kind: FieldKind
  /** 是否允许在运行期改写。省略即 false。 */
  readonly writable?: boolean
  /**
   * 这个字段的值本身就是秘密。设置插件永远只回「配没配」，不回值，且不许写——
   * 秘密只能走 credentials 插件（避免设置插件变成第二个明文秘密仓库）。
   */
  readonly secret?: boolean
  /** 这个字段是「凭据引用名」，不是秘密本体；值可以显示。 */
  readonly credentialRef?: boolean
  /** kind 为 enum 时的可选值。 */
  readonly values?: readonly string[]
  /** kind 为 integer 时的取值范围，应与手写校验里的 min / max 一致。 */
  readonly min?: number
  readonly max?: number
  /** 单位或提示，仅供显示。 */
  readonly unit?: string
  /** kind 为 object 时的子字段。 */
  readonly fields?: readonly FieldSpec[]
}

export interface StandardSchema<Output> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Output } | { readonly issues: readonly StandardIssue[] }
  }
  /**
   * 字段元数据，见 FieldSpec。没有它 = 该插件的配置面对设置插件只读。
   *
   * 属性名不能叫 `merge`：`Service[symbols.resolveConfig]` 会读 `Config?.merge`
   * 拿它做配置合并（cordis/lib/index.js:1520），占用了就会被当成合并函数调用。
   */
  readonly fields?: readonly FieldSpec[]
}

export function issue(message: string): StandardIssue {
  return { message }
}

/**
 * 区分「校验通过」与「校验失败」。
 * 不能用 `Array.isArray` 直接判：`readonly T[]` 不是 `any[]`，
 * 收窄只会落到真分支，假分支里联合类型还在，赋值就报错。
 */
export function isIssueList(value: unknown): value is readonly StandardIssue[] {
  return Array.isArray(value)
}

/**
 * 用 `validate` 构造一个 cordis 能直接用的 Config。
 * `validate` 返回领域对象表示通过，返回 issue 数组表示失败。
 *
 * `fields` 是可选的字段元数据（见 FieldSpec）：挂成返回对象的一个普通属性，
 * 不塞进 `~standard`——cordis 只读 `~standard.validate`，多出来的属性它不看。
 */
export function standardSchema<Output>(
  vendor: string,
  validate: (value: unknown) => Output | readonly StandardIssue[],
  fields?: readonly FieldSpec[],
): StandardSchema<Output> {
  return {
    '~standard': {
      version: 1,
      vendor,
      validate(value: unknown) {
        const result = validate(value)
        if (Array.isArray(result)) return { issues: result }
        return { value: result as Output }
      },
    },
    ...(fields === undefined ? {} : { fields }),
  }
}

/** 字段元数据里的顶层键——配置校验的「已知键」就该从这里派生，避免两份列表漂移。 */
export function knownKeysOf(fields: readonly FieldSpec[]): string[] {
  return fields.map((field) => field.key)
}

/** 展平成点分路径（`smtp.host`），设置插件用它做 patch 键校验与描述。 */
export function flattenFields(
  fields: readonly FieldSpec[],
  prefix = '',
): (FieldSpec & { readonly path: string })[] {
  const out: (FieldSpec & { readonly path: string })[] = []
  for (const field of fields) {
    const path = prefix === '' ? field.key : `${prefix}.${field.key}`
    out.push({ ...field, path })
    if (field.fields !== undefined) out.push(...flattenFields(field.fields, path))
  }
  return out
}

export interface ObjectCheck {
  readonly raw: Record<string, unknown>
  readonly issues: StandardIssue[]
}

/**
 * 配置必须是对象；`known` 之外的字段一律报错。
 * 传 `undefined` / `null` 视为空配置（全部走默认值）。
 */
export function checkConfigObject(value: unknown, known: readonly string[]): ObjectCheck {
  if (value === undefined || value === null) return { raw: {}, issues: [] }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { raw: {}, issues: [issue('配置必须是一个对象')] }
  }

  const raw = value as Record<string, unknown>
  const issues: StandardIssue[] = []
  for (const key of Object.keys(raw)) {
    if (!known.includes(key)) {
      issues.push(issue(`未知配置项：${key}（可用项：${known.join(' / ')}）`))
    }
  }
  return { raw, issues }
}

export function readString(
  raw: Record<string, unknown>,
  key: string,
  issues: StandardIssue[],
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    issues.push(issue(`${key} 必须是字符串`))
    return undefined
  }
  if (!options.allowEmpty && value.trim() === '') {
    issues.push(issue(`${key} 不能为空字符串`))
    return undefined
  }
  return value
}

export function readBoolean(
  raw: Record<string, unknown>,
  key: string,
  issues: StandardIssue[],
): boolean | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    issues.push(issue(`${key} 必须是布尔值`))
    return undefined
  }
  return value
}

export function readPositiveInteger(
  raw: Record<string, unknown>,
  key: string,
  issues: StandardIssue[],
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issues.push(issue(`${key} 必须是整数`))
    return undefined
  }
  if (options.min !== undefined && value < options.min) {
    issues.push(issue(`${key} 不能小于 ${options.min}`))
    return undefined
  }
  if (options.max !== undefined && value > options.max) {
    issues.push(issue(`${key} 不能大于 ${options.max}`))
    return undefined
  }
  return value
}

export function readStringArray(
  raw: Record<string, unknown>,
  key: string,
  issues: StandardIssue[],
): string[] | undefined {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    issues.push(issue(`${key} 必须是字符串数组`))
    return undefined
  }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      issues.push(issue(`${key} 里的元素必须是非空字符串`))
      return undefined
    }
    out.push(item)
  }
  return out
}
