/**
 * 能力目录的公开数据形状。
 *
 * 两条硬约束：
 *
 * 1. **全部可 JSON 序列化**：只有字符串、数字、布尔、null、数组与普通对象，
 *    没有函数、symbol、类实例。前端拿来就能渲染，桥拿来就能转发。
 * 2. **永远不含秘密**：配置只输出 schema 元数据（哪些字段、可不可写、是不是秘密），
 *    不输出任何配置值；存储路径只输出非秘密的路径字段。
 */
import type { FieldKind } from '@dizzyapi/plugin-kit'

// ───────────────────────────── 声明清单（manifest） ─────────────────────────────

/**
 * 插件可选的静态能力清单。
 *
 * 运行时反射知道「有哪些方法」，但不知道「这些方法什么意思、会发什么事件、
 * 跟 Go 之间用哪些桥命令」。这些只能由插件自己声明：
 *
 * ```ts
 * class Foo extends Service {
 *   static catalog = { capabilities: ['foo'], events: [{ name: 'foo/changed' }] } as const
 * }
 * ```
 *
 * 或者模块级导出 `export const catalog = { ... }`（默认导出没有静态 `catalog` 时才会读）。
 * **清单是声明，不是校验**：目录不会因为它而调用任何插件代码。
 */
export interface CatalogManifest {
  /** 清单版本；当前只认 1。 */
  readonly version?: 1
  /** 一句话说明这个插件提供什么。 */
  readonly description?: string
  /**
   * 自由的能力标签（如 `upstream-accounts`）。目录另外会自动派生带前缀的
   * facet：`service:<name>`、`settings:<ns>`、`event:<name>`、`bridge:<method>`、
   * `storage:<key>`。
   */
  readonly capabilities?: readonly string[]
  /** 本插件发出的事件。省略 = 未知（不是「没有」）；显式写 `[]` 才是「没有」。 */
  readonly events?: readonly CatalogEventDeclaration[]
  /** 本插件使用的控制桥命令。省略 = 未知。 */
  readonly bridge?: readonly CatalogBridgeDeclaration[]
  /** 落盘位置。`key` 是配置字段的点分路径，值只在该字段非秘密时输出。 */
  readonly storage?: readonly CatalogStorageDeclaration[]
  /** 已知的数据形状。省略 = 未知。 */
  readonly shapes?: Readonly<Record<string, CatalogDataShape>>
  /** 方法的补充说明；键是服务实例上的方法名。 */
  readonly methods?: Readonly<Record<string, CatalogMethodDeclaration>>
}

export interface CatalogEventDeclaration {
  readonly name: string
  readonly description?: string
  /** 载荷的人读说明，如 `id: string, reason: created|updated`。 */
  readonly payload?: string
}

export interface CatalogBridgeDeclaration {
  /** 桥方法名，如 `accountPriority.preview`。 */
  readonly method: string
  /** 本插件是发出去（outbound）还是处理别人发来的（inbound）。 */
  readonly direction?: 'inbound' | 'outbound'
  readonly description?: string
  /** 请求 / 响应形状的名字，对应 `shapes` 里的键。 */
  readonly requestShape?: string
  readonly responseShape?: string
}

export interface CatalogStorageDeclaration {
  /** 配置字段的点分路径，如 `dataPath` 或 `storage.dir`。 */
  readonly key: string
  readonly kind?: 'file' | 'directory' | 'socket' | 'path'
  readonly description?: string
}

export interface CatalogShapeField {
  /** 类型的人读写法，如 `string`、`integer`、`array<string>`。 */
  readonly type: string
  readonly description?: string
  readonly optional?: boolean
  /** 这个字段的值是秘密；目录本来就只描述形状，不带值。 */
  readonly secret?: boolean
  /** 指向 `shapes` 里的另一个形状。 */
  readonly shape?: string
}

export interface CatalogDataShape {
  readonly description?: string
  readonly fields?: Readonly<Record<string, CatalogShapeField>>
}

export interface CatalogMethodDeclaration {
  readonly description?: string
  /** 声明为私有。以 `_` 开头的方法即使不声明也会被标成 privateByConvention。 */
  readonly private?: boolean
}

// ───────────────────────────── 快照（snapshot） ─────────────────────────────

export type CatalogPluginState =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'disabled'
  | 'unloaded'

export type CatalogPluginKind = 'plugin' | 'group'

export interface CatalogMethod {
  readonly name: string
  /** 反射得到的参数个数（`Function.length`）；有默认值 / 剩余参数时可能小于真实参数。 */
  readonly arity: number
  /** 以 `_` 开头——项目惯例视为私有。 */
  readonly privateByConvention: boolean
  /** 清单里显式声明为私有。 */
  readonly declaredPrivate: boolean
  /** 上面两者任一成立。调用方应该只看 `isPrivate === false` 的方法。 */
  readonly isPrivate: boolean
  readonly description?: string
}

export interface CatalogServiceView {
  readonly name: string
  /** 服务实例本身是函数，或带 cordis 的 `[symbols.invoke]`。 */
  readonly callable: boolean
  readonly methods: readonly CatalogMethod[]
}

export interface CatalogInjectView {
  readonly name: string
  readonly resolved: boolean
  /** 提供者的 `entry.options.id`；根上下文或程序化 provide 时为 null。 */
  readonly providerId: string | null
}

export interface CatalogConfigField {
  /** 点分路径，如 `smtp.host`。 */
  readonly path: string
  readonly label: string
  readonly kind: FieldKind
  readonly writable: boolean
  /** 值是秘密。目录没有值字段，结构上就带不出秘密。 */
  readonly secret: boolean
  /** 值是凭据引用名（本身就允许显示）。 */
  readonly credentialRef: boolean
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly unit?: string
  readonly children?: readonly CatalogConfigField[]
}

export interface CatalogConfigView {
  /** 插件是否在 Config schema 上声明了 `fields`。false 时下面的字段列表是空的，不代表没有配置。 */
  readonly fieldsKnown: boolean
  readonly fields: readonly CatalogConfigField[]
  /** 是否有可运行期改写的字段；null = 未知。 */
  readonly writable: boolean | null
  /** 设置插件的命名空间（就是 entry 的稳定 id）；null = 这个入口不是设置目标。 */
  readonly settingsNamespace: string | null
}

export interface CatalogEventView {
  readonly name: string
  readonly description?: string
  readonly payload?: string
}

export interface CatalogBridgeView {
  readonly method: string
  readonly direction: 'inbound' | 'outbound' | null
  readonly description?: string
  readonly requestShape?: string
  readonly responseShape?: string
}

export interface CatalogStorageView {
  /** 配置字段的点分路径。 */
  readonly key: string
  /** 当前配置里的值；没配就是 null。值本身来自非秘密字段。 */
  readonly path: string | null
  readonly kind: 'file' | 'directory' | 'socket' | 'path'
  /** true = 清单声明；false = 从字段名推导（如 `dataPath`）。 */
  readonly declared: boolean
  readonly description?: string
}

export interface CatalogManifestView {
  readonly declared: boolean
  readonly source: 'plugin' | 'module' | null
  readonly version: number | null
  readonly description: string | null
}

export interface CatalogPlugin {
  /** `entry.options.id` —— 稳定身份，也是设置命名空间。 */
  readonly id: string
  /** `entry.id` —— 只用于调试，可能带 include 的随机前缀。 */
  readonly treeId: string
  /** `entry.options.name`（包名或相对路径）。 */
  readonly package: string
  readonly kind: CatalogPluginKind
  readonly state: CatalogPluginState
  readonly disabled: boolean
  /** `!disabled && state === 'active' && kind === 'plugin'`。D5：被禁用的插件永远不会是 true。 */
  readonly available: boolean
  /** 树上存在多个同 id 的入口；此时只有第一个会被 `describe()` 返回。 */
  readonly idAmbiguous: boolean
  readonly manifest: CatalogManifestView
  readonly services: readonly CatalogServiceView[]
  readonly injects: readonly CatalogInjectView[]
  readonly config: CatalogConfigView
  readonly events: readonly CatalogEventView[]
  readonly bridge: readonly CatalogBridgeView[]
  readonly storage: readonly CatalogStorageView[]
  /** 清单声明过 shapes 才是对象；否则 null（未知，不是「没有」）。 */
  readonly dataShapes: Readonly<Record<string, CatalogDataShape>> | null
  /** 声明标签 + 自动派生 facet，已排序去重。 */
  readonly capabilities: readonly string[]
  /** 无法从反射或清单得知的面：`events` / `bridge` / `dataShapes` / `storage` / `config` 等。 */
  readonly unknown: readonly string[]
}

export interface CatalogCounts {
  readonly total: number
  readonly available: number
  readonly disabled: number
  readonly inactive: number
  readonly groups: number
}

export interface CatalogSnapshot {
  readonly generatedAt: string
  readonly counts: CatalogCounts
  readonly plugins: readonly CatalogPlugin[]
}

export interface CatalogSnapshotOptions {
  /** 覆盖配置里的 `includeUnavailable`。 */
  readonly includeUnavailable?: boolean
  /**
   * 是否尝试动态 import 插件模块来读 `export const catalog`。默认 true。
   * 只会对相对路径与 `@dizzyapi/*` 生效；已装载的模块是缓存命中。
   */
  readonly resolveModuleManifests?: boolean
}

// ───────────────────────────── 查询（find / query） ─────────────────────────────

export interface CatalogQuery {
  /** 精确匹配 `capabilities` 里的一个标签或 facet（如 `service:identity`）。 */
  readonly capability?: string
  /** 精确匹配稳定 id。 */
  readonly plugin?: string
  /** 精确匹配包名。 */
  readonly package?: string
  /** 默认 false：只返回活动插件（D5）。 */
  readonly includeUnavailable?: boolean
}

export interface CatalogQueryResult {
  readonly generatedAt: string
  readonly count: number
  readonly plugins: readonly CatalogPlugin[]
}
