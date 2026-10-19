/**
 * 产品 HTTP 入口插件（服务名 `api`）。
 *
 * 它把「静态字节 + 界面请求」收在同一个同源入口里：
 *
 * - 静态资源从 `frontend` 服务读盘（版本目录 + 原子指针），本插件不复制资源；
 * - `/api/*` 在**进程内**调用 user / auth / catalog / accountAdmin 等控制面服务，
 *   不走控制桥（桥只承载控制消息，见 AGENTS.md D3）。
 *
 * 依赖纪律：只有 `user` / `auth` / `loader` 写进 `static inject`。`frontend` / `catalog` /
 * `accountAdmin` / `settings` / `apiKey` / `accountPriority` 都在请求时用
 * `ctx.reflect._getImpl(name, false)` 取原始实例（并要求 fiber 是 ACTIVE），缺谁就只让
 * 对应路由 503。否则禁用前端宿主或目录会让整个用户站跟着 PENDING 消失（D5）。
 *
 * 成员一律用 TS `private`，不用 `#`：cordis 以 Proxy 作 receiver 调用服务方法，
 * `#` 字段的 brand check 会抛「Receiver must be an instance of class」。
 */
import { FiberState, Service, type Context, type Logger } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'
import {
  API_CONFIG_SCHEMA,
  validateApiConfig,
  type ApiConfig,
  type ResolvedApiConfig,
} from './config.ts'
import { ApiError } from './errors.ts'
import { ApiServer } from './http.ts'
import type {
  AccountAdminPort,
  AccountPriorityPort,
  ApiKeyPort,
  ApiRuntime,
  AuthPort,
  CatalogPort,
  FrontendPort,
  SettingsPort,
  UserPort,
} from './types.ts'

/** 取原始服务实例：绕过 traced proxy，避免断言 / 反射时踩 `without inject`。 */
function rawService(ctx: Context, name: string): unknown {
  return ctx.root.reflect._getImpl(name, false)?.value
}

function requireService<T>(ctx: Context, name: string, label: string): T {
  const value = rawService(ctx, name)
  if (value === undefined || value === null) {
    throw new Error(`${label}（${name}）不在运行：产品 HTTP 入口需要它`)
  }
  return value as T
}

export class ApiService extends Service {
  static Config = API_CONFIG_SCHEMA

  /**
   * 只有身份相关依赖是必需的：没有 user / auth 就没有会话，产品入口整体不可用是合理的。
   *
   * frontend / catalog / accountAdmin / settings / apiKey / accountPriority 一律**不**
   * 写进 inject：D5 要求禁用某个插件只关闭它自己的入口，不能让整个用户站 / API 跟着
   * PENDING 消失。它们都在请求时按需解析，缺谁就只让对应路由 503。
   */
  static inject = ['user', 'auth', 'loader']

  /** 能力清单：同源 HTTP、SPA 托管、cookie 会话。它不发事件、不暴露桥命令、无存储。 */
  static catalog = {
    capabilities: ['http-api', 'spa-hosting', 'session-auth'],
    events: [],
    bridge: [],
    storage: [],
    shapes: {
      SessionUser: {
        description: '会话里的用户视图；余额只在 admin 或 balanceEnabled 时出现',
        fields: {
          id: { type: 'integer' },
          name: { type: 'string' },
          status: { type: 'string' },
          role: { type: 'string' },
          balanceEnabled: { type: 'boolean' },
          balanceCents: { type: 'integer', optional: true },
          avatar: { type: 'string', optional: true },
          createdAt: { type: 'string' },
          updatedAt: { type: 'string' },
        },
      },
      ApiError: {
        description: '统一错误信封；requestId 与响应头 X-Request-Id 相同',
        fields: {
          code: { type: 'string' },
          message: { type: 'string' },
          requestId: { type: 'string', optional: true },
        },
      },
    },
  } as const

  readonly config: ResolvedApiConfig
  private readonly logger: Logger
  private readonly server: ApiServer

  constructor(ctx: Context, config: ApiConfig | ResolvedApiConfig = {}) {
    super(ctx, 'api')

    const resolved = validateApiConfig(config)
    if (isIssueList(resolved)) {
      throw new ApiError(
        'API_CONFIG_INVALID',
        400,
        `产品 HTTP 入口配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.logger = ctx.logger('api')

    const runtime: ApiRuntime = {
      config: resolved,
      user: requireService<UserPort>(ctx, 'user', '用户插件'),
      auth: requireService<AuthPort>(ctx, 'auth', '鉴权插件'),
      frontend: () => this.optionalFrontend(),
      catalog: () => this.optionalService<CatalogPort>('catalog', ['query']),
      accountAdmin: () =>
        this.optionalService<AccountAdminPort>('accountAdmin', [
          'list',
          'get',
          'update',
          'enable',
          'disable',
          'remove',
        ]),
      settings: () => this.optionalService<SettingsPort>('settings', ['describe', 'update', 'reset']),
      apiKey: () => this.optionalService<ApiKeyPort>('apiKey', ['list', 'create', 'update', 'remove', 'rotate']),
      accountPriority: () => this.optionalService<AccountPriorityPort>('accountPriority', ['status']),
      now: () => new Date(),
      uptimeSec: () => Math.round(process.uptime()),
      log: (level, message) => {
        if (level === 'error') this.logger.error(message)
        else if (level === 'warn') this.logger.warn(message)
        else this.logger.info(message)
      },
    }
    this.server = new ApiServer(runtime)
  }

  get listening(): boolean {
    return this.server.listening
  }

  get port(): number {
    return this.server.address?.port ?? 0
  }

  get address(): { readonly host: '127.0.0.1'; readonly port: number } | undefined {
    return this.server.address
  }

  get url(): string | undefined {
    const address = this.server.address
    return address === undefined ? undefined : `http://127.0.0.1:${address.port}`
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    if (!this.config.enabled) {
      this.logger.info('产品 HTTP 入口未启用（enabled=false）：/api 与 SPA 都不监听')
      return
    }

    await this.start()
    yield async () => {
      await this.stop()
    }
  }

  /** 启动监听。幂等；端口冲突直接抛错（D7：不静默换端口）。 */
  async start(): Promise<void> {
    if (this.server.listening) return
    try {
      await this.server.start()
    } catch (error) {
      this.logger.error(
        `产品 HTTP 入口启动失败（端口 ${this.config.port}）：${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
    this.logger.info(
      `产品 HTTP 入口已启动：${this.url}/console（API ${this.url}/api，端口 ${this.port}）`,
    )
  }

  /** 停止监听并断开连接。幂等。 */
  async stop(): Promise<void> {
    if (!this.server.listening) return
    await this.server.stop()
    this.logger.info('产品 HTTP 入口已停止')
  }

  /**
   * 运行期取原始服务实例。fiber 不是 ACTIVE（未构造、正在重启、已 FAILED）一律当作
   * 不可用，让调用方走 503 而不是拿到半截实例或让整个插件停在 PENDING。
   */
  private optionalService<T>(name: string, methods: readonly string[]): T | undefined {
    const impl = this.ctx.root.reflect._getImpl(name, false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
    for (const method of methods) {
      if (typeof (value as Record<string, unknown>)[method] !== 'function') return undefined
    }
    return value as T
  }

  /** frontend 还要求 `config.publicBase` 可用；静态路由需要它拼公开前缀。 */
  private optionalFrontend(): FrontendPort | undefined {
    const value = this.optionalService<FrontendPort>('frontend', [
      'current',
      'assetPath',
      'manifest',
      'pages',
      'assets',
    ])
    if (value === undefined) return undefined
    const config = (value as { config?: unknown }).config
    if (config === null || typeof config !== 'object') return undefined
    return value
  }
}

export default ApiService
