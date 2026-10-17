/**
 * 只读内省：把活的插件树与服务表拍成一份快照给面板用。
 *
 * 三个不能违反的规则（都是踩过的坑，见 AGENTS.md §10）：
 *
 * 1. **绝不碰 `ctx.get(name)` 的 traced proxy**。`ctx.get` 每次返回新 proxy，
 *    一 inspect 就抛「cannot get property X without inject」。这里一律走
 *    `ctx.reflect._getImpl(name, false)?.value` 与 `ctx.root.reflect.store`，拿原始实例。
 * 2. **入口身份用 `entry.options.id`**。`entry.id` 在生产里带着 include 生成的随机前缀
 *    （`development:hmr` 那种），换个进程就变，不能当身份。
 * 3. **`reflect.props` 会留过期名字**，真相只有 `store`。
 */
import { FiberState, symbols, type Context, type Fiber } from 'cordis'
import type { Entry } from '@cordisjs/plugin-loader'
import { nowIso } from '@dizzyapi/plugin-kit'

/**
 * `Impl` 与 `ReflectService` 在 cordis 的 `index.d.ts` 里没有再导出
 * （`reflect.d.ts` 只做了 Context 的类型增强），所以这里按结构声明一份最小视图。
 * 字段是照着 `node_modules/cordis/lib/reflect.d.ts:28-42` 抄的，没多没少。
 */
interface ServiceImpl {
  readonly uid: number
  readonly name: string
  readonly value: unknown
  readonly ctx: Context
  readonly dependents: Set<Fiber>
  readonly isolate: symbol
}

/** 根 `reflect.store` 的值是 `Impl`；形状见上，只是没法按名字 import。 */
function storeOf(ctx: Context): Record<symbol, ServiceImpl> {
  return ctx.root.reflect.store as unknown as Record<symbol, ServiceImpl>
}

/** `Impl.isolate` 是 symbol，读它的 description 才有人能看的名字。 */
function isolateName(impl: ServiceImpl): string | null {
  return typeof impl.isolate === 'symbol' ? (impl.isolate.description ?? null) : null
}

const STATE_NAMES = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

export type AdminPluginState = (typeof STATE_NAMES)[number] | 'disabled' | 'unloaded'

export interface AdminInjectEdge {
  readonly resolved: boolean
  readonly implUid: number | null
  /** 提供者的 `entry.options.id`；根上下文或程序化 provide 时为 null。 */
  readonly providerId: string | null
  readonly providerFiberUid: number | null
}

export interface AdminPluginNode {
  /** `entry.options.id` —— 稳定身份，也是设置插件的命名空间。 */
  readonly id: string
  /** `entry.id` —— 只用来调试（可能带 include 的随机前缀）。 */
  readonly treeId: string
  readonly package: string
  readonly kind: 'plugin' | 'group'
  readonly state: AdminPluginState
  readonly fiberUid: number | null
  readonly disabled: boolean
  /** 这个 fiber 提供的服务名。 */
  readonly provides: readonly string[]
  readonly declaredInject: readonly string[]
  readonly resolvedInject: readonly string[]
  readonly inject: Readonly<Record<string, AdminInjectEdge>>
  readonly restartable: boolean
  /** 机器可读的拦截原因；`null` 表示可重启。 */
  readonly restartBlockedCode: AdminRestartBlock | null
  /** 给人看的同一条原因。 */
  readonly restartBlockedReason: string | null
}

export type AdminRestartBlock =
  | 'disabled'
  | 'group'
  | 'unloaded'
  | 'inactive'
  | 'self'
  | 'infrastructure'
  | 'ambiguous'

const RESTART_BLOCK_REASON: Readonly<Record<AdminRestartBlock, string>> = {
  disabled: '在 app.yml 里被禁用',
  group: '分组不是插件',
  unloaded: '尚未装载',
  inactive: '未激活',
  self: '是面板自己或它的祖先',
  infrastructure: '基础设施入口',
  ambiguous: '入口 id 重名，无法确定目标',
}

export interface AdminConsumer {
  readonly pluginId: string | null
  readonly package: string | null
  readonly fiberUid: number
}

export interface AdminServiceNode {
  readonly name: string
  readonly implUid: number
  readonly isolate: string | null
  readonly active: boolean
  readonly provider: {
    readonly pluginId: string | null
    readonly package: string | null
    readonly fiberUid: number | null
  }
  readonly methods: readonly { readonly name: string; readonly arity: number }[]
  readonly callable: boolean
  readonly consumers: readonly AdminConsumer[]
}

export interface AdminGraph {
  readonly generatedAt: string
  readonly plugins: readonly AdminPluginNode[]
  readonly services: readonly AdminServiceNode[]
}

export interface CollectOptions {
  /** 面板自己的 fiber：它自己与它的祖先都不许重启，否则会把自己扯断。 */
  readonly selfFiber?: Fiber
}

/**
 * 重启一整个基础设施工厂出来的是灾难，不是运维。
 * cli / cli-cordis 负责注册 `run` 子命令，include 负责整棵树，loader 是树的根；
 * 按前缀匹配，免得将来 `plugin-cli-*` 多出一个漏掉。
 */
const NEVER_RESTART = ['@cordisjs/plugin-include', '@cordisjs/plugin-loader', '@cordisjs/plugin-cli']

function isInfrastructure(name: string): boolean {
  return NEVER_RESTART.some((prefix) => name === prefix || name.startsWith(`${prefix}-`))
}

export function collectGraph(ctx: Context, options: CollectOptions = {}): AdminGraph {
  const entries = [...ctx.loader.entries()]
  const byFiber = new Map<Fiber, Entry>()
  const nsCount = new Map<string, number>()
  for (const entry of entries) {
    const fiber = realFiber(entry)
    if (fiber !== undefined) byFiber.set(fiber, entry)
    nsCount.set(entry.options.id, (nsCount.get(entry.options.id) ?? 0) + 1)
  }

  const ancestors = ancestorFiberUids(options.selfFiber)
  const plugins = entries.map((entry) => pluginNode(entry, byFiber, nsCount, ancestors))
  const services = collectServices(ctx, byFiber)
  return { generatedAt: nowIso(), plugins, services }
}

/**
 * `entry.fiber` **不是**真实 fiber：cordis 的 `registry.plugin()` 返回的是
 * `Object.create(fiber)` 出来的包装（为了挂 `.then`），身份不同、状态走原型链共享。
 * 而服务表里的 `impl.ctx.fiber` 是真实 fiber，所以建索引必须用后者，否则按对象身份查永远查不到。
 */
function realFiber(entry: Entry): Fiber | undefined {
  return entry.fiber?.ctx.fiber
}

/**
 * 从面板自己的 fiber 往上走，收集所有祖先 fiber 的 uid（含自己）。
 * 根 fiber 的 `parent.fiber` 指向它自己（cordis `index.js` 里就是这么收尾的），
 * 不加这道判断就是死循环。
 */
function ancestorFiberUids(self: Fiber | undefined): ReadonlySet<number> {
  const uids = new Set<number>()
  let fiber = self
  while (fiber !== undefined) {
    if (fiber.uid !== null) uids.add(fiber.uid)
    const parent = fiber.parent.fiber
    if (parent === fiber) break
    fiber = parent
  }
  return uids
}

function pluginNode(
  entry: Entry,
  byFiber: ReadonlyMap<Fiber, Entry>,
  nsCount: ReadonlyMap<string, number>,
  ancestors: ReadonlySet<number>,
): AdminPluginNode {
  const fiber = realFiber(entry)
  // 分组入口会拿到一个 `EntryGroup`（填 `subgroup`）；include 入口会拿到一个 `EntryTree`
  // （填 `subtree`），而且它内部的根 group 也会顺手把 `subgroup` 填上。
  // 所以「有 subgroup」不够，必须「有 subgroup 且没有 subtree」才是分组。
  const kind: 'plugin' | 'group' =
    entry.subtree === undefined && entry.subgroup !== undefined ? 'group' : 'plugin'
  const disabled = entry.disabled

  const state: AdminPluginState = disabled
    ? 'disabled'
    : fiber === undefined
      ? 'unloaded'
      : (STATE_NAMES[fiber.state] ?? 'unloaded')

  // `fiber.inject` 是归一化后的字典（数组与对象两种写法都会被 Inject.resolve 统一），
  // key 就是它声明依赖的服务名。
  const declared = fiber === undefined ? keysOf(entry.options.inject) : Object.keys(fiber.inject)
  const inject: Record<string, AdminInjectEdge> = {}
  const resolved: string[] = []
  for (const name of declared) {
    // committed 是「上次成功解析到的实现」；fiber 刚好在重载途中时它是空的，按根服务表补一次。
    const impl = fiber === undefined ? undefined : (fiber.committed?.[name] ?? readImpl(fiber.ctx, name))
    if (impl !== undefined) resolved.push(name)
    inject[name] = {
      resolved: impl !== undefined,
      implUid: impl?.uid ?? null,
      providerId: impl === undefined ? null : (byFiber.get(impl.ctx.fiber)?.options.id ?? null),
      providerFiberUid: impl?.ctx.fiber.uid ?? null,
    }
  }

  const blocked = restartBlockedCodeOf(entry, fiber, kind, nsCount, ancestors)

  return {
    id: entry.options.id,
    treeId: entry.id,
    package: entry.options.name,
    kind,
    state,
    fiberUid: fiber?.uid ?? null,
    disabled,
    provides: fiber === undefined ? [] : [...fiber.provisions].map((impl) => impl.name).sort(),
    declaredInject: declared,
    resolvedInject: resolved,
    inject,
    restartable: blocked === null,
    restartBlockedCode: blocked,
    restartBlockedReason: blocked === null ? null : RESTART_BLOCK_REASON[blocked],
  }
}

function restartBlockedCodeOf(
  entry: Entry,
  fiber: Fiber | undefined,
  kind: 'plugin' | 'group',
  nsCount: ReadonlyMap<string, number>,
  ancestors: ReadonlySet<number>,
): AdminRestartBlock | null {
  if (entry.disabled) return 'disabled'
  if (kind === 'group') return 'group'
  if (fiber === undefined) return 'unloaded'
  if (fiber.uid === null) return 'inactive'
  if (ancestors.has(fiber.uid)) return 'self'
  if (isInfrastructure(entry.options.name)) return 'infrastructure'
  if ((nsCount.get(entry.options.id) ?? 0) > 1) return 'ambiguous'
  return null
}

function keysOf(inject: Entry['options']['inject']): string[] {
  if (inject === undefined || inject === null) return []
  return Array.isArray(inject) ? inject : Object.keys(inject)
}

function readImpl(ctx: Context, name: string): ServiceImpl | undefined {
  // `strict: false` 是刻意的：重载途中 fiber 不是 ACTIVE，也要能问到「它原本该由谁提供」。
  return ctx.root.reflect._getImpl(name, false) as ServiceImpl | undefined
}

function collectServices(ctx: Context, byFiber: ReadonlyMap<Fiber, Entry>): AdminServiceNode[] {
  const store = storeOf(ctx)
  const seen = new Set<number>()
  const nodes: AdminServiceNode[] = []

  for (const key of Reflect.ownKeys(store)) {
    const impl = Reflect.get(store, key) as ServiceImpl | undefined
    if (impl === undefined || typeof impl.name !== 'string') continue
    // 同名服务在 isolate 里可以有多份实现，去重只能按 impl.uid。
    if (seen.has(impl.uid)) continue
    seen.add(impl.uid)

    const consumers = new Map<number, AdminConsumer>()
    // 主来源：cordis 自己维护的反向边。
    for (const fiber of impl.dependents) {
      if (fiber.uid !== null) consumers.set(fiber.uid, consumerOf(fiber, byFiber))
    }
    // 状态切换途中 dependents 可能是空的/滞后的，用消费侧的 committed 补齐。
    for (const [fiber, entry] of byFiber) {
      if (fiber.uid === null) continue
      if (fiber.committed?.[impl.name] !== impl) continue
      consumers.set(fiber.uid, {
        pluginId: entry.options.id,
        package: entry.options.name,
        fiberUid: fiber.uid,
      })
    }

    const iface = collectMethods(impl.value)
    nodes.push({
      name: impl.name,
      implUid: impl.uid,
      isolate: isolateName(impl),
      active: impl.ctx.fiber.state === FiberState.ACTIVE,
      provider: {
        pluginId: byFiber.get(impl.ctx.fiber)?.options.id ?? null,
        package: byFiber.get(impl.ctx.fiber)?.options.name ?? null,
        fiberUid: impl.ctx.fiber.uid,
      },
      methods: iface.methods,
      callable: iface.callable,
      consumers: [...consumers.values()].sort((a, b) => a.fiberUid - b.fiberUid),
    })
  }

  return nodes.sort((a, b) => a.name.localeCompare(b.name))
}

function consumerOf(fiber: Fiber, byFiber: ReadonlyMap<Fiber, Entry>): AdminConsumer {
  const entry = byFiber.get(fiber)
  return {
    pluginId: entry?.options.id ?? null,
    package: entry?.options.name ?? null,
    fiberUid: fiber.uid as number,
  }
}

/** 这些名字不是「接口」，是对象/函数的固有属性。 */
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
 * 从**原始实例**上枚举公开方法。
 *
 * 只认字符串键：cordis 的 `Service` 把 `[symbols.filter]` / `[symbols.resolveConfig]`
 * 这些内部成员全挂在 symbol 上，按字符串过滤自然就排除了。
 * 用 `getOwnPropertyDescriptor(...).value` 读，避免触发 getter（有副作用的那种会炸）。
 * 以 `_` 开头的按项目惯例视为私有。
 */
export function collectMethods(value: unknown): {
  methods: { name: string; arity: number }[]
  callable: boolean
} {
  const methods = new Map<string, number>()
  const callable = isCallable(value)

  const seen = new Set<object>()
  let target: object | null = typeof value === 'object' || typeof value === 'function' ? (value as object) : null
  while (target !== null && target !== Object.prototype && target !== Function.prototype) {
    if (seen.has(target)) break
    seen.add(target)
    for (const key of Reflect.ownKeys(target)) {
      if (typeof key !== 'string') continue
      if (NOT_METHODS.has(key) || key.startsWith('_')) continue
      const descriptor = Object.getOwnPropertyDescriptor(target, key)
      if (descriptor === undefined) continue
      if (typeof descriptor.value !== 'function') continue
      // 子类覆盖父类同名方法时，子类的那个已经在更早的循环里登记过。
      if (!methods.has(key)) methods.set(key, descriptor.value.length)
    }
    target = Object.getPrototypeOf(target) as object | null
  }

  return {
    methods: [...methods].map(([name, arity]) => ({ name, arity })).sort((a, b) => a.name.localeCompare(b.name)),
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

/** 概览里的插件计数。单独拎出来，面板与测试都用同一份口径。 */
export function pluginCounts(plugins: readonly AdminPluginNode[]): Record<AdminPluginState, number> {
  const counts: Record<AdminPluginState, number> = {
    pending: 0,
    loading: 0,
    active: 0,
    failed: 0,
    disposed: 0,
    unloading: 0,
    disabled: 0,
    unloaded: 0,
  }
  for (const plugin of plugins) counts[plugin.state] += 1
  return counts
}
