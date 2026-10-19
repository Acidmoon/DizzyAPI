/**
 * 声明清单的读取与归一化。
 *
 * 清单是**静态数据**，不是代码：所有字段只认普通对象 / 字符串 / 布尔 / 数组，
 * getter 一律视为没声明（不去触发它）。归一化会丢掉未知键与非法项，
 * 结果只含目录认识的东西——这样快照的形状不会因为某个插件写错清单而漂移。
 *
 * 读取顺序：
 * 1. 插件对象自己的 `catalog`（类的静态属性，或函数 / 对象上挂的属性）；
 * 2. 模块级 `export const catalog`——只有第 1 步没有时才动态 import 模块。
 *    对外部包只在 `@dizzyapi/*` 范围内尝试，避免因为一次目录查询去执行陌生插件模块。
 */
import type {
  CatalogBridgeDeclaration,
  CatalogDataShape,
  CatalogEventDeclaration,
  CatalogManifest,
  CatalogMethodDeclaration,
  CatalogShapeField,
  CatalogStorageDeclaration,
} from './types.ts'

export interface LoadedManifest {
  readonly manifest: CatalogManifest
  readonly source: 'plugin' | 'module'
}

/** 从插件对象（类 / 函数 / `{ apply }`）上读静态 `catalog`。 */
export function readAttachedManifest(callback: unknown): CatalogManifest | undefined {
  if (typeof callback !== 'function' && !isRecord(callback)) return undefined
  return normalizeManifest(readStaticValue(callback, 'catalog'))
}

/**
 * 从模块命名空间读 `catalog`（模块级导出）或默认导出的静态 `catalog`。
 * 只对相对路径与 `@dizzyapi/*` 生效；失败一律当作没声明。
 */
export async function readModuleManifest(
  name: string,
  baseUrl: string | undefined,
): Promise<CatalogManifest | undefined> {
  if (!isAllowedModule(name)) return undefined
  try {
    const specifier = name.startsWith('.')
      ? new URL(name, baseUrl ?? pathFallbackBase()).href
      : name
    const module = (await import(specifier)) as Record<string, unknown>
    const direct = normalizeManifest(module.catalog)
    if (direct !== undefined) return direct
    const fallback = module.default
    if (typeof fallback === 'function' || isRecord(fallback)) {
      return normalizeManifest(readStaticValue(fallback, 'catalog'))
    }
    return undefined
  } catch {
    // 模块没装、路径不对、导入期抛错：都只是「清单未知」，不能让目录查询失败。
    return undefined
  }
}

function isAllowedModule(name: string): boolean {
  return name.startsWith('.') || name.startsWith('@dizzyapi/')
}

function pathFallbackBase(): string {
  // 正常路径永远有 baseUrl（cordis Context 会带）；这里只防测试里手搓的裸 Context。
  return new URL('file:///').href
}

/** 沿原型链找静态属性，但只接受数据属性；getter 不触发。 */
function readStaticValue(target: object, key: string): unknown {
  let current: object | null = target
  while (current !== null && current !== Object.prototype && current !== Function.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) return 'value' in descriptor ? descriptor.value : undefined
    current = Object.getPrototypeOf(current) as object | null
  }
  return undefined
}

export function normalizeManifest(value: unknown): CatalogManifest | undefined {
  if (!isRecord(value)) return undefined

  const version = value.version === 1 ? 1 : undefined
  const description = text(value.description)
  const capabilities = stringList(value.capabilities)
  const events = normalizeEvents(value.events)
  const bridge = normalizeBridge(value.bridge)
  const storage = normalizeStorage(value.storage)
  const shapes = normalizeShapes(value.shapes)
  const methods = normalizeMethods(value.methods)

  return {
    ...(version === undefined ? {} : { version }),
    ...(description === undefined ? {} : { description }),
    ...(capabilities === undefined ? {} : { capabilities }),
    ...(events === undefined ? {} : { events }),
    ...(bridge === undefined ? {} : { bridge }),
    ...(storage === undefined ? {} : { storage }),
    ...(shapes === undefined ? {} : { shapes }),
    ...(methods === undefined ? {} : { methods }),
  }
}

function normalizeEvents(value: unknown): CatalogEventDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byName = new Map<string, CatalogEventDeclaration>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const name = text(item.name)
    if (name === undefined) continue
    byName.set(name, {
      name,
      ...optionalText('description', item.description),
      ...optionalText('payload', item.payload),
    })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function normalizeBridge(value: unknown): CatalogBridgeDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byMethod = new Map<string, CatalogBridgeDeclaration>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const method = text(item.method)
    if (method === undefined) continue
    const direction =
      item.direction === 'inbound' || item.direction === 'outbound' ? item.direction : undefined
    byMethod.set(method, {
      method,
      ...(direction === undefined ? {} : { direction }),
      ...optionalText('description', item.description),
      ...optionalText('requestShape', item.requestShape),
      ...optionalText('responseShape', item.responseShape),
    })
  }
  return [...byMethod.values()].sort((a, b) => a.method.localeCompare(b.method))
}

function normalizeStorage(value: unknown): CatalogStorageDeclaration[] | undefined {
  if (!Array.isArray(value)) return undefined
  const byKey = new Map<string, CatalogStorageDeclaration>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const key = text(item.key)
    if (key === undefined) continue
    const kind =
      item.kind === 'file' || item.kind === 'directory' || item.kind === 'socket' || item.kind === 'path'
        ? item.kind
        : undefined
    byKey.set(key, {
      key,
      ...(kind === undefined ? {} : { kind }),
      ...optionalText('description', item.description),
    })
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key))
}

function normalizeShapes(value: unknown): Record<string, CatalogDataShape> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, CatalogDataShape> = {}
  for (const key of Object.keys(value).sort()) {
    const shape = normalizeShape(value[key])
    if (shape !== undefined) out[key] = shape
  }
  return out
}

function normalizeShape(value: unknown): CatalogDataShape | undefined {
  if (!isRecord(value)) return undefined
  const fields = normalizeShapeFields(value.fields)
  return {
    ...optionalText('description', value.description),
    ...(fields === undefined ? {} : { fields }),
  }
}

function normalizeShapeFields(value: unknown): Record<string, CatalogShapeField> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, CatalogShapeField> = {}
  for (const key of Object.keys(value).sort()) {
    const field = normalizeShapeField(value[key])
    if (field !== undefined) out[key] = field
  }
  return out
}

function normalizeShapeField(value: unknown): CatalogShapeField | undefined {
  if (!isRecord(value)) return undefined
  const type = text(value.type)
  if (type === undefined) return undefined
  return {
    type,
    ...optionalText('description', value.description),
    ...(value.optional === true ? { optional: true } : {}),
    ...(value.secret === true ? { secret: true } : {}),
    ...optionalText('shape', value.shape),
  }
}

function normalizeMethods(value: unknown): Record<string, CatalogMethodDeclaration> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, CatalogMethodDeclaration> = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (!isRecord(item)) continue
    out[key] = {
      ...optionalText('description', item.description),
      ...(item.private === true ? { private: true } : {}),
    }
  }
  return out
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = new Set<string>()
  for (const item of value) {
    const textValue = text(item)
    if (textValue !== undefined) out.add(textValue)
  }
  return [...out].sort()
}

function optionalText<Key extends string>(
  key: Key,
  value: unknown,
): { readonly [K in Key]?: string } {
  const parsed = text(value)
  return (parsed === undefined ? {} : { [key]: parsed }) as { readonly [K in Key]?: string }
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
