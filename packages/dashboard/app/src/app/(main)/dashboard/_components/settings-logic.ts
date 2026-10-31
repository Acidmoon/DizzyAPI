/**
 * 设置页的**纯逻辑**：服务端返回形状的运行时收窄 + 嵌套 patch 构造。
 *
 * ## 为什么有一份「本地形状」
 *
 * `app/src/lib/api/types/common.ts` 里的 `SettingsView` 写的是
 * `{ namespaces: [{ id, title, fields: [{ key, label, type, value, writable }] }] }`，
 * 而服务端 `packages/settings/src/service.ts` 的 `SettingsNamespaceView` 实际是
 * `{ ns, plugin, active, disabled, writable, overridden, revision, updatedAt, pending, fields }`，
 * 字段是 `{ path, label, kind, writable, secret, credentialRef, value?, configured?, children? }`。
 * **两边对不上**（字段名与语义都不同）。
 *
 * 类型文件在 `app/src/lib/**`，**不在本线的写面**（那是 API 客户端层的地盘），
 * 所以这里不去改它，而是**在运行时收窄**：拿到真实响应后逐个字段检查，
 * 形状不对就退化成「读不出来」，而不是直接崩或显示错值。
 * 这条契约缺口已报备，等客户端层统一修；修完这里可以删掉本地形状，
 * 直接用 `import type` 的命名类型。
 */

/** 服务端的一个字段（收窄后的本地形状）。 */
export interface SettingsFieldLocal {
  /** 点分路径，如 `smtp.host`；嵌套字段的叶子路径是完整路径。 */
  readonly path: string
  readonly label: string
  /** `string` / `boolean` / `integer` / `enum` / `stringArray` / `object`。 */
  readonly kind: string
  readonly writable: boolean
  /** 值本身是秘密：服务端只回「配没配」，不回值，也不许写。 */
  readonly secret: boolean
  /** 值是凭据引用名（不是秘密本体），可以显示。 */
  readonly credentialRef: boolean
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly unit?: string
  /** 当前值；`secret` 与 `object` 字段没有这个键。 */
  readonly value?: unknown
  /** 只有 `secret` 字段有：眼下到底配了没有。 */
  readonly configured?: boolean
  /** 只有 `object` 字段有。 */
  readonly children?: readonly SettingsFieldLocal[]
}

/** 服务端的一个命名空间（收窄后的本地形状）。 */
export interface SettingsNamespaceLocal {
  readonly ns: string
  readonly plugin: string
  readonly active: boolean
  readonly disabled: boolean
  /** 有没有可写字段。 */
  readonly writable: boolean
  /** 有没有覆盖。 */
  readonly overridden: boolean
  /** 覆盖内容的指纹；没有覆盖时是 `null`。写操作拿它做乐观锁。 */
  readonly revision: string | null
  readonly updatedAt: string | null
  /** 有覆盖，却因为目标缺失 / 被禁用 / 尚未装载而没能应用。 */
  readonly pending: boolean
  readonly pendingReason?: string
  readonly fields: readonly SettingsFieldLocal[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function boolOf(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

/** 收窄一个字段；形状完全对不上返回 `null`（跳过这一条，不整体失败）。 */
function fieldOf(raw: unknown): SettingsFieldLocal | null {
  if (!isRecord(raw)) return null
  const path = textOf(raw.path)
  const label = textOf(raw.label)
  if (path === null || label === null) return null
  const kind = textOf(raw.kind) ?? "string"
  const values = Array.isArray(raw.values)
    ? raw.values.filter((item): item is string => typeof item === "string")
    : undefined
  const children = Array.isArray(raw.children)
    ? raw.children
        .map((child) => fieldOf(child))
        .filter((child): child is SettingsFieldLocal => child !== null)
    : undefined
  return {
    path,
    label,
    kind,
    writable: boolOf(raw.writable),
    secret: boolOf(raw.secret),
    credentialRef: boolOf(raw.credentialRef),
    ...(values === undefined ? {} : { values }),
    ...(typeof raw.min === "number" ? { min: raw.min } : {}),
    ...(typeof raw.max === "number" ? { max: raw.max } : {}),
    ...(textOf(raw.unit) === null ? {} : { unit: textOf(raw.unit) as string }),
    ...("value" in raw ? { value: raw.value } : {}),
    ...(typeof raw.configured === "boolean" ? { configured: raw.configured } : {}),
    ...(children === undefined ? {} : { children }),
  }
}

/** 收窄一个命名空间；形状对不上返回 `null`。 */
function namespaceOf(raw: unknown): SettingsNamespaceLocal | null {
  if (!isRecord(raw)) return null
  const ns = textOf(raw.ns)
  if (ns === null) return null
  const fields = Array.isArray(raw.fields)
    ? raw.fields
        .map((field) => fieldOf(field))
        .filter((field): field is SettingsFieldLocal => field !== null)
    : []
  return {
    ns,
    plugin: textOf(raw.plugin) ?? "（不在插件树上）",
    active: boolOf(raw.active),
    disabled: boolOf(raw.disabled),
    writable: boolOf(raw.writable),
    overridden: boolOf(raw.overridden),
    revision: textOf(raw.revision),
    updatedAt: textOf(raw.updatedAt),
    pending: boolOf(raw.pending),
    ...(textOf(raw.pendingReason) === null ? {} : { pendingReason: textOf(raw.pendingReason) as string }),
    fields,
  }
}

/**
 * 把 `/api/settings` 的响应收窄成命名空间列表。
 *
 * 形状不对（没有 `namespaces` 数组）时返回空数组——页面显示「读不到设置」，
 * 而不是抛异常把整页炸掉。
 */
export function settingsNamespacesOf(raw: unknown): SettingsNamespaceLocal[] {
  if (!isRecord(raw)) return []
  const list = raw.namespaces
  if (!Array.isArray(list)) return []
  return list
    .map((item) => namespaceOf(item))
    .filter((item): item is SettingsNamespaceLocal => item !== null)
}

/**
 * 点分路径 → **嵌套**的 patch 对象。
 *
 * ## 为什么必须嵌套而不是 `"smtp.host"` 这样的扁平键
 *
 * 服务端 `packages/settings/src/merge.ts`：
 * - `assertPatchWritable` 用 `flattenPatch` 摊平，**扁平的点分键能通过校验**；
 * - 但真正生效的是 `mergeConfig(base, override)` —— 它按**普通对象递归**合并，
 *   扁平键 `"smtp.host"` 会被当成一个字面键写进去，**基线里的 `smtp.host` 根本没变**。
 *
 * 所以：校验认扁平键，生效认嵌套。前端必须发嵌套对象。
 *
 * `null` 表示「删掉这个键」（服务端存成墓碑，应用时真的删掉基线里的值）。
 */
export function patchFromPaths(paths: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(paths)) {
    const parts = path.split(".").filter((part) => part !== "")
    if (parts.length === 0) continue
    let cursor = out
    for (let index = 0; index < parts.length - 1; index += 1) {
      const key = parts[index] as string
      const existing = cursor[key]
      if (!isRecord(existing)) cursor[key] = {}
      cursor = cursor[key] as Record<string, unknown>
    }
    cursor[parts[parts.length - 1] as string] = value
  }
  return out
}

/**
 * 一组「改了哪些叶子」的描述：`path → 新值`。
 *
 * 只放**真正改了的**：服务端逐项 diff、逐项写审计，把没改的也发过去
 * 会在审计里多出一堆「把 X 改成 X」的噪声。
 */
export interface FieldEdit {
  readonly path: string
  readonly value: unknown
}

/** 文本输入 → 字段值：空串 = **清空**（发 `null`，删掉基线里的这个键）。 */
export function textFieldValue(input: string): string | null {
  const trimmed = input.trim()
  return trimmed === "" ? null : trimmed
}

/** 整数输入 → 字段值；非法返回 `"invalid"`，不猜。 */
export function integerFieldValue(input: string): number | "invalid" {
  const trimmed = input.trim()
  if (!/^-?\d+$/.test(trimmed)) return "invalid"
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : "invalid"
}

/**
 * 字符串数组输入 → 字段值：按换行或逗号切分，去掉空项。
 *
 * 服务端 `readStringArray` 要求每一项都是非空字符串，所以空项必须在这里剔掉，
 * 不能原样发过去让服务端报错。
 */
export function stringArrayFieldValue(input: string): string[] {
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

/** 当前值 → 编辑框里的初始文本（`undefined` / `null` 给空串）。 */
export function fieldInputText(value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").join("\n")
  return ""
}

/** 当前值 → 显示文本（数组用逗号连起来；其它类型直接字符串化）。 */
export function fieldValueText(value: unknown): string {
  if (value === undefined || value === null) return "—"
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ")
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}
