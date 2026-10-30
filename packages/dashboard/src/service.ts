/**
 * `@dizzyapi/plugin-dashboard` 的服务实现。
 *
 * 定位：**控制面的静态字节服务**。它不进 LLM 请求链路、不碰转发、不碰计费、
 * 不读也不写任何存储（AGENTS.md §2.1）。对外只两件事：
 *
 * 1. 把 `packages/dashboard/dist` 里的静态产物按文件发出去（`/_next/**` 一年
 *    `immutable`，HTML 不缓存）；
 * 2. 页面路由回退到 `dist/index.html`，让客户端路由接管。
 *
 * 禁用即回收：`Service.init` 里 `start()`、把 `stop()` 作为 disposer yield 出去，
 * 卸载 / 禁用时监听关闭、连接断开，端口不再占用（与 `deepseek-usage` 同一范式）。
 * `start()` / `stop()` 是显式的，测试可以直接驱动它们而不必经过 Loader。
 *
 * **明确不注册**的部分（本插件没有这两个入口，不是漏写）：
 *
 * - 后台任务：没有任何定时器 / 轮询；
 * - 桥命令：不向 Go 侧推任何快照。
 */
import { Service, type Context, type Logger } from 'cordis'

import { DASHBOARD_CONFIG_SCHEMA, type ResolvedDashboardConfig } from './config.ts'
import { StaticServer } from './static-server.ts'

export class DashboardService extends Service {
  static Config = DASHBOARD_CONFIG_SCHEMA

  /** 不依赖任何别的服务：页面字节是纯文件读取。 */
  static inject = []

  static catalog = {
    capabilities: ['dashboard', 'dashboard-static'],
    events: [],
    bridge: [],
    storage: [],
  } as const

  readonly config: ResolvedDashboardConfig
  private readonly logger: Logger
  private server: StaticServer | undefined

  constructor(ctx: Context, config: ResolvedDashboardConfig) {
    super(ctx, 'dashboard')
    this.config = config
    this.logger = ctx.logger('dashboard')
  }

  /** 起监听。`enabled=false` 时什么都不做（不监听端口）。 */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.info('控制台服务未启用（enabled=false）：不监听端口')
      return
    }
    if (this.server !== undefined) return

    const server = new StaticServer({
      distDir: this.config.distDir,
      extraAllowedHosts: this.config.extraAllowedHosts,
    })
    this.server = server
    try {
      await server.start(this.config.port)
    } catch (error) {
      this.server = undefined
      this.logger.error(`控制台服务启动失败（端口 ${this.config.port}）：${(error as Error).message}`)
      throw error
    }
    this.logger.info(`控制台已启动：${this.origin}（产物目录 ${this.config.distDir}）`)
  }

  /** 停监听。幂等。 */
  async stop(): Promise<void> {
    const current = this.server
    this.server = undefined
    await current?.stop()
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    await this.start()
    yield () => this.stop()
  }

  get address(): { readonly host: '127.0.0.1'; readonly port: number } | undefined {
    return this.server?.address
  }

  get origin(): string | undefined {
    return this.server?.origin
  }
}

export default DashboardService
