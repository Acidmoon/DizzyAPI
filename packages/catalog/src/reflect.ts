/**
 * 从活的 cordis 树里做只读反射。
 *
 * 三条踩过的坑（AGENTS.md §10）：
 *
 * 1. **绝不碰 `ctx.get(name)` 的 traced proxy**：一 inspect 就抛
 *    「cannot get property X without inject」。这里只走 `ctx.root.reflect._getImpl`
 *    与 `fiber.provisions`，拿原始实例。
 * 2. **`entry.fiber` 是包装对象，不是真实 fiber**：建索引要用 `entry.fiber.ctx.fiber`。
 * 3. **稳定身份是 `entry.options.id`**，`entry.id` 只用于调试。
 */
import { FiberState, symbols, type Context, type Fiber } from 'cordis'
import type { Entry } from '@cordisjs/plugin-loader'
import type { FieldKind } from '@dizzyapi/plugin-kit'
import type {
  CatalogConfigField,
  CatalogInjectView,
  CatalogMethod,
  CatalogMethodDeclaration,
  CatalogPluginKind,
  CatalogPluginState,
  CatalogServiceView,
} from './types.ts'

/** `Impl` 没有从 cordis 的 index 导出，按结构声明最小视图。 */
export interface ServiceImplLike {
  readonly uid: number
  readonly name: string
  readonly value: unknown
  readonly ctx: Context
}

export function realFiber(entry: Entry): Fiber | undefined {
  return entry.fiber?.ctx.fiber
}

const STATE_NAMES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

export function stateOf(entry: Entry, fiber: Fiber | undefined): CatalogPluginState {
  if (entry.disabled) return 'disabled'
  if (fiber === undefined) return 'unloaded'
  return STATE_NAMES[fiber.state] ?? 'unloaded'
}

export function kindOf(entry: Entry): CatalogPluginKind {
  // 分组入口会拿到 EntryGroup；include 入口会拿到 EntryTree，且内部根 group 也有 subgroup。
  return entry.subtree === undefined && entry.subgroup !== undefined ? 'group' : 'plugin'
}

export function keysOf(inject: Entry['options']['inject']): string[] {
  if (inject === undefined || inject === null) return []
  return Array.isArray(inject) ? [...inject] : Object.keys(inject)
}

export function readImpl(ctx: Context, name: string): ServiceImplLike | undefined {
  // strict: false —— 重载途中 fiber 不在 ACTIVE，也要能问到「它原本该由谁提供」。
  return ctx.root.reflect._getImpl(name, false) as ServiceImplLike | undefined
}

// ───────────────────────────────── 方法 ─────────────────────────────────

/** 这些名字不是「接口」，是对象 / 函数的固有属性。 */
const NOT_METHODS = new Set([
  'constructor',
  'ctx',
  'name',
  'length',
  'prototype',
  'caller',
  'arguments',
  'apply',
  'call',
  'bind',
])

/**
 * 枚举服务实例上的方法。
 *
 * 与面板的 `collectMethods` 的差别：**以 `_` 开头的方法保留**，标成
 * `privateByConvention`。目录要如实展示边界，而不是假装它们不存在。
 * 只读数据属性，绝不触发 getter。
 */
export function collectMethods(
  value: unknown,
  declarations?: Readonly<Record<string, CatalogMethodDeclaration>>,
): { methods: CatalogMethod[]; callable: boolean } {
  const methods = new Map<string, CatalogMethod>()
  const callable = isCallable(value)

  const seen = new Set<object>()
  let target: object | null =
    typeof value === 'object' || typeof value === 'function' ? (value as object) : null
  while (target !== null && target !== Object.prototype && target !== Function.prototype) {
    if (seen.has(target)) break
    seen.add(target)
    for (const key of Reflect.ownKeys(target)) {
      if (typeof key !== 'string') continue
      if (NOT_METHODS.has(key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (descriptor === undefined || typeof descriptor.value !== 'function') continue
      // 子类覆盖父类同名方法时，子类的那个已经在更早的循环里登记过。
      if (methods.has(key)) continue
      const declaration = declarations?.[key]
      const privateByConvention = key.startsWith('_')
      const declaredPrivate = declaration?.private === true
      methods.set(key, {
        name: key,
        arity: descriptor.value.length,
        privateByConvention,
        declaredPrivate,
        isPrivate: privateByConvention || declaredPrivate,
        ...(declaration?.description === undefined ? {} : { description: declaration.description }),
      })
    }
    target = Object.getPrototypeOf(target) as object | null
  }

  return {
    methods: [...methods.values()].sort((a, b) => a.name.localeCompare(b.name)),
    callable,
  }
}

function isCallable(value: unknown): boolean {
  if (typeof value === 'function') return true
  if (typeof value !== 'object' || value === null) return false
  try {
    return (value as Record<symbol, unknown>)[symbols.invoke] !== undefined
  } catch {
    return false
  }
}

// ───────────────────────────────── 服务与依赖 ─────────────────────────────────

export function serviceViewsOf(
  fiber: Fiber | undefined,
  declarations?: Readonly<Record<string, CatalogMethodDeclaration>>,
): CatalogServiceView[] {
  if (fiber === undefined) return []
  const seen = new Set<number>()
  const views: CatalogServiceView[] = []
  for (const impl of fiber.provisions) {
    if (seen.has(impl.uid)) continue
    seen.add(impl.uid)
    const { methods, callable } = collectMethods(impl.value, declarations)
    views.push({ name: impl.name, callable, methods })
  }
  return views.sort((a, b) => a.name.localeCompare(b.name))
}

export function injectViewsOf(
  ctx: Context,
  entry: Entry,
  fiber: Fiber | undefined,
  byFiber: ReadonlyMap<Fiber, Entry>,
): CatalogInjectView[] {
  // `fiber.inject` 是归一化后的字典，key 就是声明的服务名。
  const declared = fiber === undefined ? keysOf(entry.options.inject) : Object.keys(fiber.inject)
  const views = declared.map((name): CatalogInjectView => {
    // committed 是「上次成功解析到的实现」；重载途中可能为空，按根服务表补一次。
    const impl = fiber === undefined ? undefined : (fiber.committed?.[name] ?? readImpl(ctx, name))
    const provider = impl === undefined ? undefined : byFiber.get(impl.ctx.fiber)
    return {
      name,
      resolved: impl !== undefined,
      providerId: provider?.options.id ?? null,
    }
  })
  return views.sort((a, b) => a.name.localeCompare(b.name))
}

// ───────────────────────────────── 配置 schema ─────────────────────────────────

const FIELD_KINDS: readonly FieldKind[] = [
  'string',
  'boolean',
  'integer',
  'enum',
  'stringArray',
  'object',
]

export interface ConfigFieldsView {
  readonly fieldsKnown: boolean
  readonly fields: readonly CatalogConfigField[]
}

/**
 * 只读 Config schema 上的字段元数据。
 * **永远不读值**：秘密字段在这里也只有 `secret: true`，没有 value 槽位。
 */
export function configFieldsOf(fiber: Fiber | undefined): ConfigFieldsView {
  const schema = fiber?.runtime?.Config as { fields?: unknown } | undefined
  if (schema === undefined || !Array.isArray(schema.fields)) {
    return { fieldsKnown: false, fields: [] }
  }
  const fields: CatalogConfigField[] = []
  for (const raw of schema.fields) {
    const field = normalizeField(raw, '')
    if (field !== undefined) fields.push(field)
  }
  return { fieldsKnown: true, fields }
}

function normalizeField(value: unknown, prefix: string): CatalogConfigField | undefined {
  if (!isRecord(value)) return undefined
  const key = nonEmpty(value.key)
  if (key === undefined) return undefined
  const kind = value.kind
  if (typeof kind !== 'string' || !FIELD_KINDS.includes(kind as FieldKind)) return undefined

  const path = prefix === '' ? key : `${prefix}.${key}`
  const label = nonEmpty(value.label) ?? key
  const values = stringArray(value.values)
  const unit = nonEmpty(value.unit)
  const children: CatalogConfigField[] = []
  if (Array.isArray(value.fields)) {
    for (const item of value.fields) {
      const child = normalizeField(item, path)
      if (child !== undefined) children.push(child)
    }
  }

  return {
    path,
    label,
    kind: kind as FieldKind,
    writable: value.writable === true,
    secret: value.secret === true,
    credentialRef: value.credentialRef === true,
    ...(values === undefined ? {} : { values }),
    ...(typeof value.min === 'number' && Number.isFinite(value.min) ? { min: value.min } : {}),
    ...(typeof value.max === 'number' && Number.isFinite(value.max) ? { max: value.max } : {}),
    ...(unit === undefined ? {} : { unit }),
    ...(children.length === 0 ? {} : { children }),
  }
}

/** 展平（含子字段），保持 schema 声明顺序。 */
export function flattenConfigFields(fields: readonly CatalogConfigField[]): CatalogConfigField[] {
  const out: CatalogConfigField[] = []
  for (const field of fields) {
    out.push(field)
    if (field.children !== undefined) out.push(...flattenConfigFields(field.children))
  }
  return out
}

export function findConfigField(
  fields: readonly CatalogConfigField[],
  path: string,
): CatalogConfigField | undefined {
  return flattenConfigFields(fields).find((field) => field.path === path)
}

export function currentConfigOf(entry: Entry, fiber: Fiber | undefined): Record<string, unknown> {
  // fiber.config 是校验后的解析结果（含默认值）；没有 fiber 时退回 app.yml 里的基线。
  if (fiber !== undefined && isRecord(fiber.config)) return fiber.config
  if (isRecord(entry.options.config)) return entry.options.config
  return {}
}

export function readConfigPath(config: Record<string, unknown>, path: string): unknown {
  let current: unknown = config
  for (const part of path.split('.')) {
    if (!isRecord(current)) return undefined
    current = current[part]
  }
  return current
}

// ───────────────────────────────── 设置命名空间 ─────────────────────────────────

export interface SettingsNamespaceView {
  readonly ns: string
  readonly writable: boolean | null
}

/**
 * 入口是不是设置命名空间。与设置插件的 `discoverTargets` 保持同一口径：
 * 分组不是；有 Config schema 的是；被禁用的也留着（设置插件会报「被禁用了」）。
 */
export function settingsNamespaceOf(
  entry: Entry,
  kind: CatalogPluginKind,
  fields: ConfigFieldsView,
): SettingsNamespaceView | null {
  if (kind === 'group') return null
  if (entry.subgroup !== undefined || entry.options.group) return null
  if (fields.fieldsKnown) {
    return {
      ns: entry.options.id,
      writable: flattenConfigFields(fields.fields).some((field) => field.writable),
    }
  }
  return entry.disabled ? { ns: entry.options.id, writable: null } : null
}

// ───────────────────────────────── 存储路径 ─────────────────────────────────

/**
 * 哪些字段可以当「存储路径」输出。
 *
 * 保守到只认路径样子的名字，并排除 binary / executable 这类可执行文件路径，
 * 以及任何看起来像秘密的名字。值本身还要再经过 `secret` / `credentialRef` 检查。
 */
export function isStorageLike(path: string): boolean {
  const last = path.split('.').pop() ?? path
  if (/(secret|token|password|passwd|pass|credential|api[_-]?key)/i.test(last)) return false
  if (/^(binary|executable|command)/i.test(last)) return false
  return /(Path|File|Dir|Directory|Socket|Store)$/i.test(last)
}

export function storageKindOf(path: string): 'file' | 'directory' | 'socket' | 'path' {
  const last = path.split('.').pop() ?? path
  if (/Socket$/i.test(last)) return 'socket'
  if (/(Dir|Directory)$/i.test(last)) return 'directory'
  if (/(Path|File)$/i.test(last)) return 'file'
  return 'path'
}

// ───────────────────────────────── 小工具 ─────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') return undefined
    out.push(item)
  }
  return out
}
