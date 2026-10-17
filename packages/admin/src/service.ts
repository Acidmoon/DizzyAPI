/**
 * 开发者控制面板的服务实现。
 *
 * 定位：**控制面的只读观察窗 + 两个扳手**（重启单个插件、退出整个进程）。
 * 它不进 LLM 请求链路，不碰转发、不碰计费、不碰数据库（AGENTS.md §2.1）。
 *
 * 两条依赖纪律：
 *
 * 1. `static inject` 只有 `loader`。**不 inject `settings`**：
 *    改了 mailer 的配置会级联重启 auth，如果面板也注入 settings，
 *    就会跟着一起重启，等于每次改配置都把面板抖一下。
 *    所以 settings 用 `_getImpl('settings', false)` 在运行期按需解析。
 * 2. `shutdown()` **绝不** `process.exit`：它只负责把该关的关掉、把 `exit` 事件发出去。
 *    退出由 HTTP 路由的 `onExit` 负责（这样测试进程才能活着验完断言）。
 */
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { cpus, loadavg, platform } from 'node:os'
import { FiberState, Service, type Context, type Logger } from 'cordis'
import type { Entry } from '@cordisjs/plugin-loader'
import { nowIso } from '@dizzyapi/plugin-kit'
import type { ConfigPatch, SettingsNamespaceView } from '@dizzyapi/plugin-settings'
import { ADMIN_CONFIG_SCHEMA, ADMIN_DEFAULTS, type ResolvedAdminConfig } from './config.ts'
import { AdminError } from './errors.ts'
import { PanelServer, type PanelHandlers } from './http.ts'
import {
  collectGraph,
  pluginCounts,
  type AdminGraph,
  type AdminPluginNode,
  type AdminPluginState,
} from './introspect.ts'

/** 面板写设置时声明的身份。必须出现在 `settings.adminPlugins` 白名单里。 */
export const ADMIN_ACTOR = '@dizzyapi/plugin-admin'

/** 设置插件里面板实际用到的面。结构声明，不 import 它的类（避免把它的启动带进来）。 */
interface SettingsPort {
  describe(): Promise<readonly SettingsNamespaceView[]>
  update(actor: string, ns: string, patch: ConfigPatch, expectedRevision?: string): Promise<SettingsNamespaceView>
  reset(actor: string, ns: string): Promise<SettingsNamespaceView>
}

export interface AdminOverview {
  readonly generatedAt: string
  readonly process: { readonly pid: number; readonly node: string; readonly platform: string; readonly uptimeSec: number }
  readonly memory: {
    readonly rss: number
    readonly heapTotal: number
    readonly heapUsed: number
    readonly external: number
  }
  readonly cpu: {
    readonly percent: number
    readonly userMicros: number
    readonly systemMicros: number
    readonly cores: number
    readonly load1: number
  }
  readonly eventLoop: { readonly meanMs: number; readonly maxMs: number; readonly p50Ms: number; readonly p99Ms: number }
  readonly server: { readonly host: string; readonly port: number; readonly sseClients: number }
  readonly plugins: Record<AdminPluginState, number>
}

export interface AdminRestartResult {
  readonly id: string
  readonly package: string
  readonly fiberUid: number
  readonly state: AdminPluginState
  /** 预计会被一起重启的插件（它们注入了本插件提供的服务）。 */
  readonly cascaded: readonly { readonly id: string; readonly package: string }[]
}

/**
 * 面板服务。成员一律用 TS `private`，**不用 `#`**：
 * cordis 以 Proxy 作 receiver 调用服务方法，`#` 字段的 brand check 会抛
 * 「Receiver must be an instance of class」（AGENTS.md §10）。
 */
export class AdminService extends Service {
  static Config = ADMIN_CONFIG_SCHEMA
  static inject = ['loader']

  readonly config: ResolvedAdminConfig
  private readonly logger: Logger
  private panel: PanelServer | undefined
  private panelTask: Promise<PanelServer> | undefined
  private overviewTimer: NodeJS.Timeout | undefined
  private histogram: IntervalHistogram | undefined
  private closing: Promise<void> | undefined
  private lastCpu = process.cpuUsage()
  private lastCpuAt = process.hrtime.bigint()

  constructor(ctx: Context, config: ResolvedAdminConfig = {}) {
    super(ctx, 'admin')
    this.config = config
    this.logger = ctx.logger('admin')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    const port = this.config.port ?? ADMIN_DEFAULTS.port
    try {
      const panel = await this.ensurePanel()
      await panel.start(port)
    } catch (error) {
      // 端口被占就是起不来。D7：不静默降级、不换端口——那会让启动日志里的地址撒谎。
      this.logger.error(`面板启动失败（端口 ${port}）：${(error as Error).message}`)
      throw error
    }

    this.histogram = monitorEventLoopDelay({ resolution: 20 })
    this.histogram.enable()
    this.startOverview()
    this.logger.info(`面板已启动：${this.bootstrapUrl}（一次性令牌，打开即失效）`)

    yield async () => {
      this.stopOverview()
      this.histogram?.disable()
      this.histogram = undefined
      const panel = this.panel
      this.panel = undefined
      this.panelTask = undefined
      await panel?.stop()
    }
  }

  // ───────────────────────────────── 位置 ─────────────────────────────────

  get address(): { host: '127.0.0.1'; port: number } | undefined {
    return this.panel?.address
  }

  get url(): string | undefined {
    return this.panel?.origin
  }

  /** 带一次性 token 的地址。换过 cookie 之后就没了。 */
  get bootstrapUrl(): string | undefined {
    return this.panel?.bootstrapUrl
  }

  get listening(): boolean {
    return this.panel?.listening ?? false
  }

  get sseClientCount(): number {
    return this.panel?.clientCount ?? 0
  }

  // ───────────────────────────────── 读面 ─────────────────────────────────

  /** 插件树 + 服务表的快照。静态依赖图，不做运行期调用计数。 */
  async graph(): Promise<AdminGraph> {
    return collectGraph(this.ctx, { selfFiber: this.ctx.fiber })
  }

  async overview(): Promise<AdminOverview> {
    // 取同一时刻的 CPU 快照再算差：`process.cpuUsage(prev)` 与这里的差分是等价的，
    // 但只读一次时钟，窗口不会错位。
    const current = process.cpuUsage()
    const usage = { user: current.user - this.lastCpu.user, system: current.system - this.lastCpu.system }
    const now = process.hrtime.bigint()
    const elapsedMicros = Number(now - this.lastCpuAt) / 1_000
    this.lastCpu = current
    this.lastCpuAt = now

    const memory = process.memoryUsage()
    const histogram = this.histogram
    const address = this.address

    return {
      generatedAt: nowIso(),
      process: {
        pid: process.pid,
        node: process.version,
        platform: platform(),
        uptimeSec: Math.round(process.uptime()),
      },
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
      },
      cpu: {
        percent: elapsedMicros > 0 ? ((usage.user + usage.system) / elapsedMicros) * 100 : 0,
        userMicros: usage.user,
        systemMicros: usage.system,
        cores: cpus().length,
        load1: loadavg()[0] ?? 0,
      },
      eventLoop: {
        meanMs: histogram === undefined || histogram.count === 0 ? 0 : histogram.mean / 1e6,
        maxMs: histogram === undefined ? 0 : histogram.max / 1e6,
        p50Ms: histogram === undefined || histogram.count === 0 ? 0 : histogram.percentile(50) / 1e6,
        p99Ms: histogram === undefined || histogram.count === 0 ? 0 : histogram.percentile(99) / 1e6,
      },
      server: {
        host: address?.host ?? '127.0.0.1',
        port: address?.port ?? 0,
        sseClients: this.sseClientCount,
      },
      plugins: pluginCounts(collectGraph(this.ctx).plugins),
    }
  }

  // ───────────────────────────────── 扳手 ─────────────────────────────────

  /**
   * 重启单个插件。
   *
   * 用 `fiber.update(fiber.config, true)`，**不是** `fiber.restart()`：
   * `restart()` 对 FAILED 的 fiber 是空操作，`update()` 会先清掉错误再重载；
   * `noSave: true` 则保证 loader 不会把配置回写进 `app.yml`（AGENTS.md §10）。
   */
  async restartPlugin(id: string): Promise<AdminRestartResult> {
    const graph = await this.graph()
    const matches = graph.plugins.filter((plugin) => plugin.id === id)
    if (matches.length === 0) throw new AdminError('ADMIN_PLUGIN_NOT_FOUND', `没有这个插件入口：${id}`)
    if (matches.length > 1) {
      throw new AdminError('ADMIN_PLUGIN_AMBIGUOUS', `入口 id 重名（${matches.length} 个）：${id}`)
    }

    const node = matches[0] as AdminPluginNode
    switch (node.restartBlockedCode) {
      case null:
        break
      case 'disabled':
        throw new AdminError('ADMIN_PLUGIN_DISABLED', `${id} 在 app.yml 里被禁用了`)
      case 'unloaded':
      case 'inactive':
        throw new AdminError('ADMIN_PLUGIN_INACTIVE', `${id} 还不是活动 fiber`)
      case 'self':
        throw new AdminError('ADMIN_PLUGIN_SELF_RESTART', '不能重启面板自己或它的祖先分组')
      case 'ambiguous':
        throw new AdminError('ADMIN_PLUGIN_AMBIGUOUS', `入口 id 重名：${id}`)
      case 'group':
      case 'infrastructure':
        throw new AdminError(
          'ADMIN_PLUGIN_NOT_RESTARTABLE',
          `${id} 不能重启：${node.restartBlockedReason ?? '原因不明'}`,
        )
    }
    if (node.fiberUid === null) throw new AdminError('ADMIN_PLUGIN_INACTIVE', `${id} 还不是活动 fiber`)

    const entry = findEntry(this.ctx, id)
    if (entry === undefined || entry.fiber === undefined) {
      throw new AdminError('ADMIN_PLUGIN_INACTIVE', `${id} 的入口已经不在树上了`)
    }
    const fiber = entry.fiber
    const cascaded = cascadedBy(graph, node)

    try {
      await fiber.update(fiber.config, true)
    } catch (error) {
      throw new AdminError('ADMIN_RESTART_FAILED', `${id} 重启失败：${(error as Error).message}`)
    }
    if (fiber.state !== FiberState.ACTIVE) {
      throw new AdminError('ADMIN_RESTART_FAILED', `${id} 重启后状态是 ${String(fiber.state)}，不是 active`)
    }

    this.logger.info(
      `已重启插件 ${id}${cascaded.length === 0 ? '' : `（连带 ${cascaded.map((item) => item.id).join(' / ')}）`}`,
    )
    return {
      id,
      package: node.package,
      fiberUid: fiber.uid as number,
      state: 'active',
      cascaded,
    }
  }

  // ───────────────────────────────── 设置面 ─────────────────────────────────

  async describeSettings(): Promise<{ actor: string; namespaces: readonly SettingsNamespaceView[] }> {
    const settings = this.requireSettings()
    return { actor: ADMIN_ACTOR, namespaces: await settings.describe() }
  }

  async updateSettings(
    ns: string,
    patch: ConfigPatch,
    expectedRevision?: string,
  ): Promise<SettingsNamespaceView> {
    return this.requireSettings().update(ADMIN_ACTOR, ns, patch, expectedRevision)
  }

  async resetSettings(ns: string): Promise<SettingsNamespaceView> {
    return this.requireSettings().reset(ADMIN_ACTOR, ns)
  }

  // ───────────────────────────────── 退出 ─────────────────────────────────

  /**
   * 停监听、断 SSE、发出 `exit` 事件。**不**退出进程——调用方负责。
   * 幂等：第二次调用拿到的是同一个 promise。
   */
  shutdown(): Promise<void> {
    this.closing ??= this.close()
    return this.closing
  }

  private async close(): Promise<void> {
    this.stopOverview()
    this.histogram?.disable()
    this.histogram = undefined

    const panel = this.panel
    this.panel = undefined
    this.panelTask = undefined
    await panel?.stop()

    this.logger.info('面板已关闭，发出 exit 事件')
    await this.ctx.parallel('exit', 'SIGTERM')
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private requireSettings(): SettingsPort {
    const impl = this.ctx.root.reflect._getImpl('settings', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) {
      throw new AdminError('ADMIN_SETTINGS_UNAVAILABLE', '设置插件没有运行：面板只能看图，不能改配置')
    }
    return impl.value as SettingsPort
  }

  /** 只在真正监听时才构造：`port` 之类的配置在构造期还没有实际端口可用。 */
  private ensurePanel(): Promise<PanelServer> {
    this.panelTask ??= Promise.resolve().then(() => {
      const handlers: PanelHandlers = {
        graph: () => this.graph(),
        overview: () => this.overview(),
        restartPlugin: (id) => this.restartPlugin(id),
        describeSettings: () => this.describeSettings(),
        updateSettings: (ns, patch, expected) => this.updateSettings(ns, patch, expected),
        resetSettings: (ns) => this.resetSettings(ns),
        shutdown: () => this.shutdown(),
      }
      const panel = new PanelServer({
        handlers,
        bodyLimitBytes: this.config.bodyLimitBytes ?? ADMIN_DEFAULTS.bodyLimitBytes,
        sseHeartbeatMs: this.config.sseHeartbeatMs ?? ADMIN_DEFAULTS.sseHeartbeatMs,
        maxSseClients: this.config.maxSseClients ?? ADMIN_DEFAULTS.maxSseClients,
      })
      this.panel = panel
      return panel
    })
    return this.panelTask
  }

  private startOverview(): void {
    this.stopOverview()
    const timer = setInterval(() => {
      const panel = this.panel
      if (panel === undefined || panel.clientCount === 0) return
      void this.overview()
        .then((snapshot) => panel.broadcast('overview', snapshot))
        .catch((error: unknown) => this.logger.warn(`推送概览失败：${(error as Error).message}`))
    }, this.config.overviewIntervalMs ?? ADMIN_DEFAULTS.overviewIntervalMs)
    // unref：面板不能因为这条采样定时器把进程吊住。SSE 连接断了就没有必要再推。
    timer.unref()
    this.overviewTimer = timer
  }

  private stopOverview(): void {
    if (this.overviewTimer !== undefined) clearInterval(this.overviewTimer)
    this.overviewTimer = undefined
  }
}

function findEntry(ctx: Context, id: string): Entry | undefined {
  for (const entry of ctx.loader.entries()) {
    if (entry.options.id === id) return entry
  }
  return undefined
}

/** 注入了本插件所提供服务的其他插件——重启会级联到它们。 */
function cascadedBy(
  graph: AdminGraph,
  node: AdminPluginNode,
): readonly { readonly id: string; readonly package: string }[] {
  const provided = new Set(node.provides)
  if (provided.size === 0) return []
  return graph.plugins
    .filter((other) => other.id !== node.id)
    .filter((other) => other.resolvedInject.some((name) => provided.has(name)))
    .map((other) => ({ id: other.id, package: other.package }))
}
