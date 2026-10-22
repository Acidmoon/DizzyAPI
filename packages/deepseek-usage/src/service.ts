/**
 * 「用量信息」页插件的服务实现。
 *
 * 定位：**控制面的只读页面**。它不进 LLM 请求链路、不碰转发、不碰计费、
 * 不直接写任何库（AGENTS.md §2.1）。数据只经由 `usage` / `user` / `auth`
 * 三个服务的只读接口拿。
 *
 * 依赖纪律：
 *
 * 1. `static inject` 只有 `loader`。`usage` / `user` / `auth` 都**不**写进 inject：
 *    它们被禁用时本插件不该跟着停在 PENDING——页面要能起来并明确告诉用户
 *    「数据源没运行」，而不是整个插件消失。运行期用 `_getImpl(name, false)` 解析。
 * 2. 页面自己起一个 127.0.0.1 的 HTTP 服务（与 `api` 插件同源不同口），
 *    端口冲突直接失败，不静默换端口。
 */
import { FiberState, Service, type Context, type Logger } from 'cordis'
import { DEEPSEEK_USAGE_CONFIG_SCHEMA, type ResolvedDeepseekUsageConfig } from './config.ts'
import type { Board, GroupBy, RangeKey } from './board.ts'
import { RANGE_DAYS } from './board.ts'
import { collectBoard, type UsageReader } from './collect.ts'
import { UsagePageServer, readSessionCookie } from './http.ts'
import { renderPage } from './render.ts'
import type { IncomingMessage } from 'node:http'

/** 用量服务里我们用到的读接口（结构声明，不 import 它的实现类）。 */
interface UsageServiceLike {
  exportRows(query: {
    readonly fromMs: number
    readonly toMs: number
    readonly userId?: number
    readonly apiKeyId?: string
    readonly model?: string
  }, limit?: number): readonly UsageRowLike[]
  summary(query: {
    readonly fromMs: number
    readonly toMs: number
    readonly userId?: number
    readonly apiKeyId?: string
  }): { readonly totals: { readonly costMicros: string } }
}

/** 用量明细行。 */
interface UsageRowLike {
  readonly startedAt: string
  readonly model: string
  readonly protocol: string
  readonly apiKeyId: string
  readonly apiKeyName: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly costMicros: string
}

/** 用户服务里我们用到的读接口。 */
interface UserServiceLike {
  get(id: number): Promise<UserLike | undefined>
}

/** 用户视图。 */
interface UserLike {
  readonly id: number
  readonly name: string
  readonly balance: bigint
  readonly avatar: string | null
}

/** 鉴权服务里我们用到的读接口。 */
interface AuthServiceLike {
  verifySession(token: string): Promise<{ readonly userId: number }>
}

export class DeepseekUsageService extends Service {
  static Config = DEEPSEEK_USAGE_CONFIG_SCHEMA

  /**
   * 只有 `loader` 是硬依赖。数据源在运行期按需解析：被禁用时页面仍然起得来，
   * 只是没有数据（D5：禁用某个插件只关掉它自己的入口）。
   */
  static inject = ['loader']

  static catalog = {
    capabilities: ['usage-dashboard', 'deepseek-usage-page'],
    events: [],
    bridge: [],
    storage: [],
  } as const

  readonly config: ResolvedDeepseekUsageConfig
  private readonly logger: Logger
  private page: UsagePageServer | undefined

  constructor(ctx: Context, config: ResolvedDeepseekUsageConfig) {
    super(ctx, 'deepseekUsage')
    this.config = config
    this.logger = ctx.logger('deepseekUsage')
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    if (!this.config.enabled) {
      this.logger.info('页面服务未启用（enabled=false）：不监听端口')
      return
    }

    const port = this.config.port
    const page = new UsagePageServer({
      basePath: this.config.basePath,
      handlers: {
        sessionCookieName: this.config.sessionCookieName,
        render: (req, query) => this.render(req, query),
        exportCsv: (req, query) => this.exportCsv(req, query),
      },
    })
    this.page = page
    try {
      await page.start(port)
    } catch (error) {
      this.page = undefined
      this.logger.error(`页面服务启动失败（端口 ${port}）：${(error as Error).message}`)
      throw error
    }
    this.logger.info(`用量信息页已启动：${this.url}`)

    yield async () => {
      const current = this.page
      this.page = undefined
      await current?.stop()
    }
  }

  get address(): { readonly host: '127.0.0.1'; readonly port: number } | undefined {
    return this.page?.address
  }

  get url(): string | undefined {
    const origin = this.page?.origin
    return origin === undefined ? undefined : `${origin}${this.config.basePath}`
  }

  // ───────────────────────────── 数据源 ─────────────────────────────

  /** 运行期取原始服务实例；fiber 不是 ACTIVE 就当作「不在运行」。 */
  private serviceOf<T>(name: string): T | undefined {
    const impl = this.ctx.root.reflect._getImpl(name, false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
    return value as T
  }

  private usageService(): UsageServiceLike | undefined {
    const service = this.serviceOf<UsageServiceLike>('usage')
    if (service === undefined) return undefined
    return typeof service.exportRows === 'function' ? service : undefined
  }

  /** 当前会话；没有登录或会话失效都返回 null。 */
  private async currentSession(token: string | undefined): Promise<number | null> {
    if (token === undefined || token === '') return null
    const auth = this.serviceOf<AuthServiceLike>('auth')
    if (auth === undefined || typeof auth.verifySession !== 'function') return null
    try {
      const view = await auth.verifySession(token)
      return typeof view.userId === 'number' ? view.userId : null
    } catch {
      return null
    }
  }

  /** 当前用户（会话有效时）。 */
  private async currentUser(userId: number | null): Promise<UserLike | undefined> {
    if (userId === null) return undefined
    const user = this.serviceOf<UserServiceLike>('user')
    if (user === undefined || typeof user.get !== 'function') return undefined
    try {
      return await user.get(userId)
    } catch {
      return undefined
    }
  }

  /** 从请求里解析会话。 */
  private async sessionOf(req: IncomingMessage): Promise<number | null> {
    const token = readSessionCookie(req, this.config.sessionCookieName)
    return this.currentSession(token)
  }

  // ───────────────────────────── 页面 ─────────────────────────────

  /** 解析本次请求的筛选条件。 */
  private parseQuery(params: URLSearchParams): {
    readonly range: RangeKey
    readonly apiKeyId: string | null
    readonly groupBy: GroupBy
  } {
    const rangeParam = params.get('range')
    const range: RangeKey = rangeParam === '7d' || rangeParam === '30d' || rangeParam === '90d' ? rangeParam : '30d'
    const apiKeyParam = params.get('apiKeyId')
    const apiKeyId = apiKeyParam === null || apiKeyParam === '' ? null : apiKeyParam
    const groupParam = params.get('group')
    const groupBy: GroupBy = groupParam === 'apiKey' ? 'apiKey' : 'callKind'
    return { range, apiKeyId, groupBy }
  }

  /** 渲染页面。 */
  private async render(req: IncomingMessage, params: URLSearchParams): Promise<string> {
    const query = this.parseQuery(params)
    const userId = await this.sessionOf(req)
    const user = await this.currentUser(userId)
    const board = await this.buildBoard(query, userId, user)
    return renderPage({
      board,
      basePath: this.config.basePath,
      consoleBaseUrl: this.config.consoleBaseUrl,
      userName: user?.name ?? null,
      avatarUrl: user?.avatar ?? null,
    })
  }

  /** 导出 CSV。 */
  private async exportCsv(
    req: IncomingMessage,
    params: URLSearchParams,
  ): Promise<{ readonly filename: string; readonly content: string }> {
    const query = this.parseQuery(params)
    const userId = await this.sessionOf(req)
    const usage = this.usageService()
    const header = 'time,model,protocol,api_key,input_tokens,output_tokens,total_tokens,cost_micros'
    if (usage === undefined) {
      return { filename: 'usage.csv', content: `﻿${header}\r\n` }
    }

    const days = RANGE_DAYS[query.range]
    const now = new Date()
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const fromMs = todayStart - (days - 1) * 86_400_000
    const toMs = todayStart + 86_400_000
    const rows = usage.exportRows({
      fromMs,
      toMs,
      ...(userId === null ? {} : { userId }),
      ...(query.apiKeyId === null ? {} : { apiKeyId: query.apiKeyId }),
    }, 20_000)

    const lines = rows.map((row) =>
      [
        row.startedAt,
        row.model,
        row.protocol,
        row.apiKeyName === '' ? row.apiKeyId : row.apiKeyName,
        String(row.inputTokens),
        String(row.outputTokens),
        String(row.totalTokens),
        row.costMicros,
      ]
        .map(csvField)
        .join(','),
    )
    const from = new Date(fromMs).toISOString().slice(0, 10).replaceAll('-', '')
    const to = new Date(toMs - 86_400_000).toISOString().slice(0, 10).replaceAll('-', '')
    return { filename: `usage-${from}-${to}.csv`, content: `﻿${header}\r\n${lines.join('\r\n')}` }
  }

  /** 采集看板数据。 */
  private async buildBoard(
    query: { readonly range: RangeKey; readonly apiKeyId: string | null; readonly groupBy: GroupBy },
    userId: number | null,
    user: UserLike | undefined,
  ): Promise<Board> {
    const usage = this.usageService()
    const now = new Date()
    // 余额与用量费用同一尺度：1 元 = 1_000_000 个最小单位。
    const balanceMicros = user === undefined ? '0' : String(user.balance)
    if (usage === undefined) {
      return {
        balanceMicros,
        spentMicros: '0',
        totals: { costMicros: '0', requests: 0, tokens: 0 },
        daily: [],
        models: [],
        apiKeys: [],
        range: query.range,
        apiKeyId: query.apiKeyId,
        groupBy: query.groupBy,
        generatedAt: now.toISOString(),
        userId,
        userName: user?.name ?? null,
        userBalanceMicros: balanceMicros,
      }
    }

    const reader: UsageReader = {
      exportRows: (q, limit) => usage.exportRows(q, limit),
      summary: (q) => usage.summary(q),
    }
    return collectBoard({
      usage: reader,
      range: query.range,
      apiKeyId: query.apiKeyId,
      groupBy: query.groupBy,
      userId,
      balanceMicros,
      userName: user?.name ?? null,
      now,
    })
  }
}

/** CSV 单元格：`= + - @` 开头加前导 `'` 防公式注入，再按 RFC 4180 转义。 */
function csvField(value: string): string {
  const guarded = /^[=+\-@]/.test(value) ? `'${value}` : value
  if (!/[",\r\n]/.test(guarded)) return guarded
  return `"${guarded.replaceAll('"', '""')}"`
}
