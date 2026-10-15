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

export interface StandardSchema<Output> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (
      value: unknown,
    ) => { readonly value: Output } | { readonly issues: readonly StandardIssue[] }
  }
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
 */
export function standardSchema<Output>(
  vendor: string,
  validate: (value: unknown) => Output | readonly StandardIssue[],
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
  }
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
