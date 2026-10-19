/**
 * 插件能力目录（服务名 `catalog`）。
 *
 * 它**不是**管理插件：不起 HTTP、不改任何状态、不调用被观察插件的方法。
 * 它回答三个问题：
 *
 *   - 现在运行的插件各自提供什么？（服务、方法、配置面、设置命名空间、存储）
 *   - 它们接受什么？（inject、配置字段、桥命令、事件）
 *   - 某个能力由谁提供？（`find({ capability })`）
 *
 * 运行时反射知道「有哪些方法」，但不知道 TS 类型与语义。这部分由插件可选的
 * `static catalog`（或模块级 `export const catalog`）声明；没有声明就标 `unknown`，
 * **不猜**。
 *
 * 三条硬约束：
 * 1. 只返回可 JSON 序列化的普通对象；
 * 2. 永远不返回秘密——配置只有 schema 元数据，存储只读非秘密路径字段；
 * 3. D5：被禁用 / 未激活的插件 `available: false`，`find()` 默认不返回它们。
 */
import { FiberState, Service, type Context, type Fiber } from 'cordis'
import type { Entry } from '@cordisjs/plugin-loader'
import { isIssueList, nowIso } from '@dizzyapi/plugin-kit'
import {
  CATALOG_CONFIG_SCHEMA,
  validateCatalogConfig,
  type CatalogConfig,
  type ResolvedCatalogConfig,
} from './config.ts'
import { CatalogError } from './errors.ts'
import type { CatalogManifest } from './types.ts'
import { readAttachedManifest, readModuleManifest } from './manifest.ts'
import {
  configFieldsOf,
  currentConfigOf,
  findConfigField,
  flattenConfigFields,
  injectViewsOf,
  isRecord,
  isStorageLike,
  kindOf,
  readConfigPath,
  realFiber,
  serviceViewsOf,
  settingsNamespaceOf,
  stateOf,
  storageKindOf,
  type ConfigFieldsView,
} from './reflect.ts'
import type {
  CatalogBridgeView,
  CatalogConfigView,
  CatalogCounts,
  CatalogEventView,
  CatalogManifestView,
  CatalogPlugin,
  CatalogQuery,
  CatalogQueryResult,
  CatalogSnapshot,
  CatalogSnapshotOptions,
  CatalogStorageView,
} from './types.ts'

const QUERY_KEYS = new Set(['capability', 'plugin', 'package', 'includeUnavailable'])

export class CatalogService extends Service {
  static Config = CATALOG_CONFIG_SCHEMA
  /** 没有插件树就没有可编目的东西。 */
  static inject = ['loader']
  /** 目录自己也可以被编目；这不是自恋，是给清单约定留一个现成样例。 */
  static catalog = {
    capabilities: ['plugin-catalog', 'capability-discovery'],
    events: [],
    bridge: [],
    storage: [],
  } as const

  readonly config: ResolvedCatalogConfig
  private readonly moduleManifests = new Map<string, Promise<CatalogManifest | undefined>>()

  constructor(ctx: Context, config: CatalogConfig | ResolvedCatalogConfig = {}) {
    super(ctx, 'catalog')
    this.config = resolveConfig(config)
  }

  // ───────────────────────────────── 读面 ─────────────────────────────────

  /**
   * 整棵插件树的目录快照。
   *
   * 默认包含被禁用 / 未装载的入口（`includeUnavailable`），但它们的 `available`
   * 一定是 false。排序：先 `id`，再 `package`，再 `kind`，最后 `treeId`。
   */
  async snapshot(options: CatalogSnapshotOptions = {}): Promise<CatalogSnapshot> {
    const includeUnavailable = options.includeUnavailable ?? this.config.includeUnavailable
    const plugins = await this.collect(includeUnavailable, options.resolveModuleManifests ?? true)
    return {
      generatedAt: nowIso(),
      counts: countsOf(plugins),
      plugins,
    }
  }

  /** 单个入口的目录视图。找不到抛 `CATALOG_PLUGIN_NOT_FOUND`。 */
  async describe(pluginId: string): Promise<CatalogPlugin> {
    const id = requireQueryString(pluginId, 'pluginId')
    const plugins = await this.collect(true, true)
    const matches = plugins.filter((plugin) => plugin.id === id)
    if (matches.length === 0) {
      throw new CatalogError('CATALOG_PLUGIN_NOT_FOUND', `没有这个插件入口：${id}`)
    }
    return matches[0] as CatalogPlugin
  }

  /**
   * 按能力查插件。默认只返回 `available` 的插件（D5）；
   * 分组入口永远不参与查询。
   */
  async find(query: CatalogQuery = {}): Promise<CatalogPlugin[]> {
    const parsed = normalizeQuery(query)
    const plugins = await this.collect(parsed.includeUnavailable === true, true)
    return plugins.filter((plugin) => matches(plugin, parsed))
  }

  /**
   * 桥命令形状的只读查询：`{ capability?, plugin?, package?, includeUnavailable? }`
   * → `{ generatedAt, count, plugins }`。给将来的前端 / 桥命令直接转发用；
   * 本插件不注册任何 HTTP 路由（D5 的四个入口在这里只剩「服务」一个）。
   */
  async query(params: unknown = {}): Promise<CatalogQueryResult> {
    const parsed = normalizeQuery(params)
    const plugins = await this.find(parsed)
    return { generatedAt: nowIso(), count: plugins.length, plugins }
  }

  // ───────────────────────────────── 组装 ─────────────────────────────────

  private async collect(
    includeUnavailable: boolean,
    resolveModuleManifests: boolean,
  ): Promise<CatalogPlugin[]> {
    const entries = [...this.ctx.loader.entries()]
    const byFiber = new Map<Fiber, Entry>()
    const idCount = new Map<string, number>()
    for (const entry of entries) {
      const fiber = realFiber(entry)
      if (fiber !== undefined) byFiber.set(fiber, entry)
      idCount.set(entry.options.id, (idCount.get(entry.options.id) ?? 0) + 1)
    }

    const plugins: CatalogPlugin[] = []
    for (const entry of entries) {
      const plugin = await this.buildPlugin(entry, byFiber, idCount, resolveModuleManifests)
      if (!includeUnavailable && !plugin.available) continue
      plugins.push(plugin)
    }
    return plugins.sort(comparePlugins)
  }

  private async buildPlugin(
    entry: Entry,
    byFiber: ReadonlyMap<Fiber, Entry>,
    idCount: ReadonlyMap<string, number>,
    resolveModuleManifests: boolean,
  ): Promise<CatalogPlugin> {
    const fiber = realFiber(entry)
    const kind = kindOf(entry)
    const state = stateOf(entry, fiber)
    const disabled = entry.disabled === true
    const available = !disabled && kind === 'plugin' && fiber?.state === FiberState.ACTIVE

    // 清单：静态属性优先；没有才尝试模块级导出（只在已装载、非禁用的入口上做）。
    let manifest = readAttachedManifest(fiber?.runtime?.callback)
    let source: 'plugin' | 'module' | null = manifest === undefined ? null : 'plugin'
    if (
      manifest === undefined &&
      resolveModuleManifests &&
      !disabled &&
      entry.fiber !== undefined
    ) {
      manifest = await this.moduleManifest(entry.options.name, entry.ctx.baseUrl)
      if (manifest !== undefined) source = 'module'
    }

    const configFields = configFieldsOf(fiber)
    const config = currentConfigOf(entry, fiber)
    const namespace = settingsNamespaceOf(entry, kind, configFields)
    const unknown: string[] = []

    const services = serviceViewsOf(fiber, manifest?.methods)
    const foundMethods = new Set<string>()
    for (const service of services) {
      for (const method of service.methods) foundMethods.add(method.name)
    }

    const events = eventViewsOf(manifest)
    const bridge = bridgeViewsOf(manifest)
    const storage = storageViewsOf(manifest, configFields, config, unknown)
    const storageKnown = configFields.fieldsKnown || manifest?.storage !== undefined
    const dataShapes = manifest?.shapes === undefined ? null : manifest.shapes

    if (manifest?.events === undefined) unknown.push('events')
    if (manifest?.bridge === undefined) unknown.push('bridge')
    if (manifest?.shapes === undefined) unknown.push('dataShapes')
    if (!configFields.fieldsKnown) unknown.push('config')
    if (!storageKnown) unknown.push('storage')
    for (const name of Object.keys(manifest?.methods ?? {})) {
      if (!foundMethods.has(name)) unknown.push(`method:${name}`)
    }

    const configView: CatalogConfigView = {
      fieldsKnown: configFields.fieldsKnown,
      fields: configFields.fields,
      writable: namespace?.writable ?? null,
      settingsNamespace: namespace?.ns ?? null,
    }

    return {
      id: entry.options.id,
      treeId: entry.id,
      package: entry.options.name,
      kind,
      state,
      disabled,
      available,
      idAmbiguous: (idCount.get(entry.options.id) ?? 0) > 1,
      manifest: manifestViewOf(manifest, source),
      services,
      injects: injectViewsOf(this.ctx, entry, fiber, byFiber),
      config: configView,
      events,
      bridge,
      storage,
      dataShapes,
      capabilities: capabilitiesOf(manifest, services, namespace?.ns ?? null, events, bridge, storage),
      unknown: [...new Set(unknown)].sort(),
    }
  }

  private moduleManifest(
    name: string,
    baseUrl: string | undefined,
  ): Promise<CatalogManifest | undefined> {
    const key = `${baseUrl ?? ''}\n${name}`
    let task = this.moduleManifests.get(key)
    if (task === undefined) {
      task = readModuleManifest(name, baseUrl)
      this.moduleManifests.set(key, task)
    }
    return task
  }
}

// ───────────────────────────────── 组装小工具 ─────────────────────────────────

function manifestViewOf(
  manifest: CatalogManifest | undefined,
  source: 'plugin' | 'module' | null,
): CatalogManifestView {
  return {
    declared: manifest !== undefined,
    source,
    version: manifest?.version ?? null,
    description: manifest?.description ?? null,
  }
}

function eventViewsOf(manifest: CatalogManifest | undefined): CatalogEventView[] {
  return (manifest?.events ?? []).map((event) => ({
    name: event.name,
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.payload === undefined ? {} : { payload: event.payload }),
  }))
}

function bridgeViewsOf(manifest: CatalogManifest | undefined): CatalogBridgeView[] {
  return (manifest?.bridge ?? []).map((command) => ({
    method: command.method,
    direction: command.direction ?? null,
    ...(command.description === undefined ? {} : { description: command.description }),
    ...(command.requestShape === undefined ? {} : { requestShape: command.requestShape }),
    ...(command.responseShape === undefined ? {} : { responseShape: command.responseShape }),
  }))
}

/**
 * 存储路径 = 清单声明 + 字段名推导。
 *
 * 安全规则：只认「路径样子」的键，且 schema 明确标成秘密 / 凭据引用的字段一律跳过。
 * 值只从当前配置里读这几个非秘密字段。
 */
function storageViewsOf(
  manifest: CatalogManifest | undefined,
  fields: ConfigFieldsView,
  config: Record<string, unknown>,
  unknown: string[],
): CatalogStorageView[] {
  const out = new Map<string, CatalogStorageView>()

  for (const declaration of manifest?.storage ?? []) {
    const key = declaration.key
    if (!isStorageLike(key)) {
      unknown.push(`storage:${key}`)
      continue
    }
    const field = findConfigField(fields.fields, key)
    if (field !== undefined && (field.secret || field.credentialRef)) {
      unknown.push(`storage:${key}`)
      continue
    }
    out.set(key, {
      key,
      path: pathValueOf(config, key),
      kind: declaration.kind ?? storageKindOf(key),
      declared: true,
      ...(declaration.description === undefined ? {} : { description: declaration.description }),
    })
  }

  for (const field of flattenConfigFields(fields.fields)) {
    if (out.has(field.path)) continue
    if (field.kind !== 'string' || field.secret || field.credentialRef) continue
    if (!isStorageLike(field.path)) continue
    out.set(field.path, {
      key: field.path,
      path: pathValueOf(config, field.path),
      kind: storageKindOf(field.path),
      declared: false,
    })
  }

  return [...out.values()].sort((a, b) => compareText(a.key, b.key))
}

function pathValueOf(config: Record<string, unknown>, path: string): string | null {
  const value = readConfigPath(config, path)
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function capabilitiesOf(
  manifest: CatalogManifest | undefined,
  services: readonly { readonly name: string }[],
  settingsNamespace: string | null,
  events: readonly CatalogEventView[],
  bridge: readonly CatalogBridgeView[],
  storage: readonly CatalogStorageView[],
): string[] {
  const capabilities = new Set<string>(manifest?.capabilities ?? [])
  for (const service of services) capabilities.add(`service:${service.name}`)
  if (settingsNamespace !== null) capabilities.add(`settings:${settingsNamespace}`)
  for (const event of events) capabilities.add(`event:${event.name}`)
  for (const command of bridge) capabilities.add(`bridge:${command.method}`)
  for (const item of storage) capabilities.add(`storage:${item.key}`)
  return [...capabilities].sort(compareText)
}

function countsOf(plugins: readonly CatalogPlugin[]): CatalogCounts {
  let available = 0
  let disabled = 0
  let inactive = 0
  let groups = 0
  for (const plugin of plugins) {
    if (plugin.available) available += 1
    if (plugin.disabled) disabled += 1
    if (plugin.kind === 'group') groups += 1
    else if (!plugin.available && !plugin.disabled) inactive += 1
  }
  return { total: plugins.length, available, disabled, inactive, groups }
}

function matches(plugin: CatalogPlugin, query: CatalogQuery): boolean {
  // 分组不是「能力提供者」，查询里永远不返回。
  if (plugin.kind !== 'plugin') return false
  if (query.includeUnavailable !== true && !plugin.available) return false
  if (query.capability !== undefined && !plugin.capabilities.includes(query.capability)) return false
  if (query.plugin !== undefined && plugin.id !== query.plugin) return false
  if (query.package !== undefined && plugin.package !== query.package) return false
  return true
}

function normalizeQuery(value: unknown): CatalogQuery {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    throw new CatalogError('CATALOG_QUERY_INVALID', '查询必须是一个对象')
  }
  for (const key of Object.keys(value)) {
    if (!QUERY_KEYS.has(key)) {
      throw new CatalogError(
        'CATALOG_QUERY_INVALID',
        `未知查询字段 ${key}（可用：${[...QUERY_KEYS].join(' / ')}）`,
      )
    }
  }

  const query: {
    capability?: string
    plugin?: string
    package?: string
    includeUnavailable?: boolean
  } = {}
  for (const key of ['capability', 'plugin', 'package'] as const) {
    const raw = value[key]
    if (raw === undefined) continue
    query[key] = requireQueryString(raw, key)
  }
  if (value.includeUnavailable !== undefined) {
    if (typeof value.includeUnavailable !== 'boolean') {
      throw new CatalogError('CATALOG_QUERY_INVALID', '`includeUnavailable` 必须是布尔值')
    }
    query.includeUnavailable = value.includeUnavailable
  }
  return query
}

function requireQueryString(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CatalogError('CATALOG_QUERY_INVALID', `\`${key}\` 必须是非空字符串`)
  }
  return value.trim()
}

function resolveConfig(config: CatalogConfig | ResolvedCatalogConfig): ResolvedCatalogConfig {
  const result = validateCatalogConfig(config)
  if (isIssueList(result)) {
    throw new CatalogError(
      'CATALOG_INVALID_CONFIG',
      `能力目录配置不合法：${result.map((item) => item.message).join('；')}`,
    )
  }
  return result
}

function comparePlugins(a: CatalogPlugin, b: CatalogPlugin): number {
  return (
    compareText(a.id, b.id) ||
    compareText(a.package, b.package) ||
    compareText(a.kind, b.kind) ||
    compareText(a.treeId, b.treeId)
  )
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
