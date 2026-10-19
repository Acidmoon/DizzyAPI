import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Service, type Context, type Logger } from 'cordis'
import { describeError, flattenFields, nowIso, type FieldSpec, type FieldKind, type JsonStore } from '@dizzyapi/plugin-kit'
import { SETTINGS_CONFIG_SCHEMA, type ResolvedSettingsConfig } from './config.ts'
import { discoverTargets, findTarget, type Target } from './discover.ts'
import { SettingsError } from './errors.ts'
import { isPlainObject, mergeConfig, mergePatch } from './merge.ts'
import { revisionOf } from './revision.ts'
import { createSettingsStore, type NamespaceRecord, type SettingsSnapshot } from './store.ts'

/** 一次增量改动：嵌套对象会并进覆盖里，值为 null 表示删除该键。 */
export type ConfigPatch = Record<string, unknown>

export interface SettingsFieldView {
  /** 点分路径，如 `smtp.host`。 */
  readonly path: string
  readonly label: string
  readonly kind: FieldKind
  readonly writable: boolean
  /** 值是秘密：这里**没有** value 键，只看得到「配没配」。 */
  readonly secret: boolean
  /** 值是凭据引用名（不是秘密本体），可以显示。 */
  readonly credentialRef: boolean
  readonly values?: readonly string[]
  readonly min?: number
  readonly max?: number
  readonly unit?: string
  /** 当前配置里的值。secret 与 object 字段没有这个键。 */
  readonly value?: unknown
  /** 只有 secret 字段有：眼下到底配了没有（永远不告诉你配的是什么）。 */
  readonly configured?: boolean
  /** 只有 object 字段有。 */
  readonly children?: readonly SettingsFieldView[]
}

export interface SettingsNamespaceView {
  readonly ns: string
  readonly plugin: string
  readonly active: boolean
  readonly disabled: boolean
  /** 有没有可写字段。没有的话，这个命名空间只是「只读可见」。 */
  readonly writable: boolean
  /** 有没有覆盖。 */
  readonly overridden: boolean
  readonly revision: string | null
  readonly updatedAt: string | null
  /** 有覆盖，却因为目标缺失 / 被禁用 / 尚未装载而没能应用。 */
  readonly pending: boolean
  readonly pendingReason?: 'missing' | 'disabled' | 'inactive'
  readonly fields: readonly SettingsFieldView[]
}

interface ConfigSchema {
  readonly fields?: readonly FieldSpec[]
  readonly '~standard': {
    readonly validate: (
      value: unknown,
    ) => { readonly value?: unknown } | { readonly issues: readonly { readonly message: string }[] }
  }
}

/**
 * 设置插件：**运行期配置的唯一写者**（AGENTS.md D8）。
 *
 * 三个角色的边界不能混：
 *
 * 1. `app.yml` 是**人写的基线**，带注释，设置插件从不改它；
 * 2. 本插件独占一个 gitignored 的**覆盖文件**；
 * 3. 应用时把两者合并，交给目标插件自己的 schema 校验，再过 cordis 的
 *    `fiber.update(merged, true)` 让它软重启——`noSave: true` 是硬要求：
 *    否则 loader 会把配置回写进 `app.yml`，把注释整份冲掉。
 *
 * 它不认识 `credentials`，也不认识任何具体插件：命名空间就是 entry 的 id，
 * 可写字段由各插件自己在 schema 上声明（`FieldSpec`）。默认拒绝——
 * 没声明 `fields` 的插件整个配置面只读。
 *
 * 成员不能用 `#` 私有字段：cordis 以 Proxy 作 receiver 调用服务方法，
 * `#` 字段的 brand check 会抛「Receiver must be an instance of class」。
 */
export class SettingsService extends Service {
  static Config = SETTINGS_CONFIG_SCHEMA
  /** 没有 loader 就没有插件树，也就没有可设的东西——直接不上马。 */
  static inject = ['loader']

  /** 能力清单：运行期配置的唯一写者。它自己不暴露桥命令。 */
  static catalog = {
    capabilities: ['runtime-config'],
    events: [{ name: 'settings/updated', description: '某个命名空间的覆盖变了', payload: 'ns: string' }],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: '设置覆盖 JSON（gitignored）' }],
  } as const

  readonly config: ResolvedSettingsConfig
  private store: JsonStore<SettingsSnapshot>
  private adminPlugins: readonly string[]
  private logger: Logger
  private state: SettingsSnapshot | undefined
  private loading: Promise<SettingsSnapshot> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private scheduled = false

  constructor(ctx: Context, config: ResolvedSettingsConfig = {}) {
    super(ctx, 'settings')
    this.config = config
    this.adminPlugins = config.adminPlugins ?? []
    this.logger = ctx.logger('settings')
    this.store = createSettingsStore(resolveDataPath(ctx, config.dataPath))

    this.logger.info(
      `设置插件已装载：覆盖 ${this.store.describe}；可写设置的插件 ${this.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (config.dataPath === undefined) {
      this.logger.warn('没有配置 dataPath：覆盖只存在内存里，进程一重启就没了')
    }
    if (this.adminPlugins.length === 0) {
      this.logger.warn('adminPlugins 为空：当前没有任何插件可以改设置（默认拒绝，这是刻意的）')
    }

    // 注册即副作用：插件被卸载时监听器与存储一起回收（AGENTS.md D5）。
    ctx.effect(() => {
      // 新 entry 上树、或某个 fiber 换了状态：都可能是「刚才没法应用的那个目标现在行了」
      const offPlugin = ctx.root.on('internal/plugin', () => this.scheduleReconcile())
      const offStatus = ctx.root.on('internal/status', () => this.scheduleReconcile())
      // 别的插件重载（HMR、人手改 app.yml）之后基线可能变了，覆盖要重新盖章。
      // 用箭头函数而不是 function：这里要的是服务自身的 this，不是被更新的那个 fiber。
      const offUpdate = ctx.on(
        'internal/update',
        (_config: unknown, next: () => void | Promise<void>) => {
          this.scheduleReconcile()
          return next()
        },
        { global: true },
      )
      return () => {
        offPlugin()
        offStatus()
        offUpdate()
      }
    }, 'settings.reconcile')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.state = await this.load()
    this.scheduleReconcile()
  }

  // ───────────────────────────────── 读面 ─────────────────────────────────

  /** 全部命名空间，含未激活与树上已经没有的。读不限权（与 user 的 get / list 一致）。 */
  async describe(): Promise<readonly SettingsNamespaceView[]> {
    const snapshot = await this.load()
    const targets = new Map(discoverTargets(this.ctx).map((target) => [target.ns, target]))
    const names = [...new Set([...targets.keys(), ...Object.keys(snapshot.namespaces)])].sort()
    return names.map((ns) => this.viewOf(ns, targets.get(ns), snapshot.namespaces[ns]))
  }

  /** 单个命名空间。树上没有、覆盖文件里也没有，就是 SETTINGS_NS_UNKNOWN。 */
  async get(ns: string): Promise<SettingsNamespaceView> {
    const snapshot = await this.load()
    const target = findTarget(this.ctx, ns)
    const record = snapshot.namespaces[ns]
    if (target === undefined && record === undefined) {
      throw new SettingsError('SETTINGS_NS_UNKNOWN', `没有这个设置命名空间：${ns}`)
    }
    return this.viewOf(ns, target, record)
  }

  // ───────────────────────────────── 写面 ─────────────────────────────────

  /** 增量改：patch 并进该命名空间的覆盖，合并基线后应用。 */
  async update(
    actor: string,
    ns: string,
    patch: ConfigPatch,
    expectedRevision?: string,
  ): Promise<SettingsNamespaceView> {
    this.assertAdmin(actor)
    if (!isPlainObject(patch)) {
      throw new SettingsError('SETTINGS_VALUE_INVALID', 'patch 必须是对象')
    }
    const target = this.requireTarget(ns)
    assertPatchWritable(target, patch)

    return this.exclusive(async () => {
      const snapshot = await this.load()
      const previous = snapshot.namespaces[ns]?.config ?? {}
      this.assertRevision(snapshot.namespaces[ns], expectedRevision)
      // 用 mergePatch 而不是 mergeConfig：null 要原样存下来当墓碑（见 merge.ts）
      const override = mergePatch(previous, patch)
      return this.writeAndApply(target, ns, override, snapshot)
    })
  }

  /**
   * 把所有覆盖重新盖一遍。内部 reconcile 的公开入口：启动重放是自动的，
   * 这个是给运维与测试的手动扳手。**是幂等的**——已经一致的不会重复重启。
   */
  async applyAll(): Promise<void> {
    await this.reconcile()
  }

  /** 清掉该命名空间的覆盖，回到 app.yml 的基线。 */
  async reset(actor: string, ns: string): Promise<SettingsNamespaceView> {
    this.assertAdmin(actor)
    const target = this.requireTarget(ns)

    return this.exclusive(async () => {
      const snapshot = await this.load()
      return this.writeAndApply(target, ns, {}, snapshot)
    })
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  /**
   * 应用一份覆盖，并把覆盖写进文件。**调用方必须已持有 exclusive 锁。**
   *
   * 顺序是刻意的：**先校验 → 再落地 → 再落盘 → 落盘失败才回退**。
   * 宁可「运行期生效了但文件没记下」（下次启动重放一次而已），
   * 也不能「文件记下了一份目标插件拒绝的覆盖」（下次启动会把插件打死）。
   */
  private async writeAndApply(
    target: Target,
    ns: string,
    override: Record<string, unknown>,
    snapshot: SettingsSnapshot,
  ): Promise<SettingsNamespaceView> {
    const merged = this.validateMerged(target, mergeConfig(target.baseline, override))

    const namespaces: Record<string, NamespaceRecord> = { ...snapshot.namespaces }
    const empty = Object.keys(override).length === 0
    if (empty) delete namespaces[ns]
    else namespaces[ns] = { revision: revisionOf(override), config: override, updatedAt: nowIso() }
    const next: SettingsSnapshot = { namespaces }

    const previous = await this.applyTo(target, merged)

    try {
      await this.store.write(next)
    } catch (error) {
      // 落盘失败：把运行期退回原样，免得「内存说的」和「文件说的」不一样
      await this.applyTo(target, previous)
      throw new SettingsError('SETTINGS_STORE_UNWRITABLE', `写入设置覆盖失败：${describeError(error)}`)
    }

    this.state = next
    this.ctx.emit('settings/updated', ns)
    return this.viewOf(ns, target, namespaces[ns])
  }

  /**
   * 启动重放：把文件里的覆盖重新盖到当前这棵树上。**调用方必须已持有 exclusive 锁。**
   *
   * 与显式 `update` 的区别：目标缺失或未激活时只告警、留着重试的机会，
   * 不让整个进程因为「某个 entry 现在没激活」就起不来。
   */
  private async reconcile(): Promise<void> {
    await this.exclusive(async () => {
      const snapshot = await this.load()
      for (const [ns, record] of Object.entries(snapshot.namespaces)) {
        const target = findTarget(this.ctx, ns)
        if (target === undefined || !target.active || target.fiber === undefined) {
          this.logger.warn(`覆盖里有 ${ns}，但它此刻不在运行（缺失或未激活）；先留着，等它就绪再重放`)
          continue
        }
        try {
          const merged = this.validateMerged(target, mergeConfig(target.baseline, record.config))
          await this.applyTo(target, merged)
        } catch (error) {
          this.logger.warn(`重放 ${ns} 的覆盖失败，已跳过：${describeError(error)}`)
        }
      }
    })
  }

  /** 合并微任务：一次状态抖动只重放一轮。 */
  private scheduleReconcile(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.reconcile().catch((error: unknown) => {
        this.logger.warn(`重放设置覆盖失败：${describeError(error)}`)
      })
    })
  }

  /** 用目标插件自己的 schema 预校验：给得出人能读的错误，也不靠 fiber.update 兜底。 */
  private validateMerged(target: Target, merged: Record<string, unknown>): Record<string, unknown> {
    const schema = target.fiber?.runtime?.Config as ConfigSchema | undefined
    if (schema === undefined) {
      throw new SettingsError('SETTINGS_TARGET_INACTIVE', `${target.ns} 尚未装载完成，无法校验新配置`)
    }
    const result = schema['~standard'].validate(merged)
    if ('issues' in result && result.issues !== undefined) {
      const detail = result.issues.map((item) => item.message).join('；')
      throw new SettingsError(
        'SETTINGS_VALUE_INVALID',
        `新配置没通过 ${target.plugin} 自己的校验：${detail}`,
      )
    }
    return merged
  }

  /**
   * 让目标插件换上新配置，返回它**换之前**的配置（供落盘失败时回退）。
   *
   * `noSave = true` 是硬要求：否则 loader 会 `internal/commit` → 把配置回写进
   * `app.yml` 并整份重写那个文件，注释全丢。
   */
  private async applyTo(target: Target, merged: unknown): Promise<unknown> {
    const fiber = target.fiber
    if (fiber === undefined) {
      throw new SettingsError('SETTINGS_TARGET_INACTIVE', `${target.ns} 尚未装载完成`)
    }
    const previous = fiber.config
    // 幂等：已经等于当前配置就不动它。启动重放、HMR 重放、状态抖动都靠这一条收敛。
    if (isDeepStrictEqual(merged, previous)) return previous

    // 直接等 cast：fiber.update 的返回类型带了 Awaitable，这里要的是「重启完」
    await fiber.update(merged as never, true)
    return previous
  }

  private requireTarget(ns: string): Target {
    const target = findTarget(this.ctx, ns)
    if (target === undefined) {
      const known = discoverTargets(this.ctx).map((item) => item.ns).join(' / ') || '无'
      throw new SettingsError('SETTINGS_TARGET_MISSING', `没有这个设置命名空间：${ns}（当前有：${known}）`)
    }
    if (target.disabled) {
      throw new SettingsError(
        'SETTINGS_TARGET_DISABLED',
        `${ns} 在 app.yml 里被禁用了，配置改了也不会应用；先启用它`,
      )
    }
    if (!target.active || target.fiber === undefined) {
      throw new SettingsError('SETTINGS_TARGET_INACTIVE', `${ns} 还没装载完成，此刻不能改`)
    }
    return target
  }

  private assertAdmin(actor: string): void {
    const name = normalizeActor(actor)
    if (!this.adminPlugins.includes(name)) {
      throw new SettingsError(
        'SETTINGS_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权改动设置（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }

  private assertRevision(record: NamespaceRecord | undefined, expected: string | undefined): void {
    if (expected === undefined) return
    const actual = record?.revision ?? null
    if (actual !== expected) {
      throw new SettingsError(
        'SETTINGS_CONFLICT',
        `覆盖已经被别人改过（你手上的 revision ${expected}，现在是 ${actual ?? '没有'}）；重新读一次再改`,
      )
    }
  }

  private viewOf(ns: string, target: Target | undefined, record: NamespaceRecord | undefined): SettingsNamespaceView {
    const override = record?.config ?? {}
    const overridden = Object.keys(override).length > 0
    const current = target?.fiber?.config ?? target?.baseline ?? {}

    const pendingReason: SettingsNamespaceView['pendingReason'] =
      target === undefined
        ? 'missing'
        : target.disabled && !target.active
          ? 'disabled'
          : !target.active
            ? 'inactive'
            : undefined

    const view: SettingsNamespaceView = {
      ns,
      plugin: target?.plugin ?? '（不在插件树上）',
      active: target?.active ?? false,
      disabled: target?.disabled ?? false,
      writable: (target?.fields ?? []).some((field) => field.writable === true),
      overridden,
      revision: overridden ? (record?.revision ?? null) : null,
      updatedAt: record?.updatedAt ?? null,
      pending: overridden && pendingReason !== undefined,
      fields: buildFieldViews(target?.fields ?? [], current),
    }
    return pendingReason !== undefined && overridden ? { ...view, pendingReason } : view
  }

  private load(): Promise<SettingsSnapshot> {
    if (this.state) return Promise.resolve(this.state)
    if (!this.loading) {
      const loading = this.store
        .read()
        .then((snapshot) => {
          this.state = snapshot
          return snapshot
        })
        .catch((error: unknown) => {
          // 编解码自己抛的 SettingsError（数据损坏）原样带出，其余包成「读不出来」
          if (error instanceof SettingsError) throw error
          throw new SettingsError('SETTINGS_STORE_UNREADABLE', `读取设置覆盖失败：${describeError(error)}`)
        })
      this.loading = loading
      loading.catch(() => {
        // 加载失败不缓存，下一次调用可以重试
        if (this.loading === loading) this.loading = undefined
      })
    }
    return this.loading
  }

  /** 串行执行：同一时刻只有一次「读覆盖 → 合并 → 应用 → 落盘」在进行。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(noop, noop)
    return result
  }
}

function noop(): void {
  // 只用来把队列里失败的 promise 咽掉，避免污染下一次 task
}

/**
 * patch 的键必须存在且可写。**例外：值为 null 的删除任何键都允许**——
 * 删不会注入值，而且这是把基线里的旧键（如互斥的 smtp.passEnv）清掉的唯一办法。
 */
function assertPatchWritable(target: Target, patch: Record<string, unknown>): void {
  const known = new Map(flattenFields(target.fields).map((field) => [field.path, field]))

  for (const [path, value] of flattenPatch(patch)) {
    const field = known.get(path)
    if (field === undefined) {
      const available = [...known.keys()].join(' / ') || '无'
      throw new SettingsError(
        'SETTINGS_FIELD_UNKNOWN',
        `${target.ns} 不认识配置项 ${path}（可用项：${available}）`,
      )
    }
    if (value === null) continue
    if (field.writable !== true) {
      throw new SettingsError(
        'SETTINGS_FIELD_NOT_WRITABLE',
        `${target.ns} 的 ${path} 不可在运行期改写${field.secret === true ? '（秘密只能走凭据插件）' : ''}`,
      )
    }
  }
}

/** 把 patch 摊成 [点分路径, 值]，普通对象往里递归，数组与标量算叶子。 */
function flattenPatch(patch: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = []
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (isPlainObject(value)) out.push(...flattenPatch(value, path))
    else out.push([path, value])
  }
  return out
}

function buildFieldViews(
  fields: readonly FieldSpec[],
  current: unknown,
  prefix = '',
): SettingsFieldView[] {
  return fields.map((field) => {
    const path = prefix === '' ? field.key : `${prefix}.${field.key}`
    const raw = isPlainObject(current) ? current[field.key] : undefined

    const view: SettingsFieldView = {
      path,
      label: field.label,
      kind: field.kind,
      writable: field.writable === true,
      secret: field.secret === true,
      credentialRef: field.credentialRef === true,
      ...(field.values !== undefined ? { values: field.values } : {}),
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
      ...(field.unit !== undefined ? { unit: field.unit } : {}),
    }

    if (field.fields !== undefined) {
      return { ...view, children: buildFieldViews(field.fields, raw, path) }
    }
    if (field.secret === true) {
      // 秘密只看得到「配没配」，值一个字都不给
      return { ...view, configured: raw !== undefined && raw !== '' }
    }
    return { ...view, value: raw }
  })
}

function normalizeActor(actor: string): string {
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw new SettingsError('SETTINGS_ACTOR_REQUIRED', '调用方必须声明自己的插件名')
  }
  return actor.trim()
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}
