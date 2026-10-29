/**
 * 模型广场插件（服务名 `modelhub`）。
 *
 * 定位：**纯只读聚合**。它不落盘、不写任何数据，只把三份只读事实拼成一份
 * 「我们卖什么」：
 *
 * 1. `pricing` 的价格表 —— 哪些模型有精确价、每百万 token 多少钱；
 * 2. 账号声明的 `models` —— 哪些账号提供哪些**对外**模型名；
 * 3. 账号的 `modelMap` / 协议 / 健康度 / 凭据状态 —— 这个模型现在能不能用、
 *    会被改写成哪个上游模型名、覆盖哪些协议。
 *
 * 三条纪律：
 * - **不 inject 任何服务**：价格与账号都在**运行期**解析（`ctx.get(name, false)`）。
 *   `pricing` 被禁用时目录照样列模型，只是没有价格；`accountAdmin` 被禁用时
 *   目录只剩「有价但没人提供」——这符合 D5：禁用某个插件只关掉它自己的入口。
 * - **不落盘**：每次查询都现算。没有缓存，也就没有「缓存过期」这一类 bug。
 * - **不泄漏秘密**：只输出对外模型名、计数与协议名；账号 id、label、baseUrl、
 *   凭据状态都不出现在结果里（label 可能含敏感信息，baseUrl 可能带 key）。
 */
import { FiberState, Service, type Context, type Logger } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'
import {
  MODELHUB_CONFIG_SCHEMA,
  validateModelHubConfig,
  type ModelHubConfig,
  type ResolvedModelHubConfig,
} from './config.ts'
import { ModelHubError } from './errors.ts'
import type {
  ModelCatalog,
  ModelCatalogQuery,
  ModelCatalogSummary,
  ModelEntry,
  ModelPriceView,
  ModelUnavailableEntry,
} from './types.ts'

/**
 * 价格服务的结构面：只声明本插件用到的两个方法，不 import 实现类。
 * `snapshot()` 返回 `model → 单价` 的映射（`'*'` 是兜底条目）。
 */
interface PricingSeam {
  list(): readonly {
    readonly model: string
    readonly inputPerMillion: string
    readonly outputPerMillion: string
    readonly cacheReadPerMillion: string
    readonly cacheWritePerMillion: string
    readonly currency: string
    readonly updatedAt: string
  }[]
}

/**
 * 账号管理门面（identity 的只读门面）的结构面。
 *
 * 只用四个字段：`models`（对外模型名）、`modelMap`（对外名 → 上游名）、
 * `protocol`（上游协议）、以及「能不能用」那几个判断字段。
 */
interface AccountSeamRecord {
  readonly enabled: boolean
  readonly status: string
  readonly protocol?: string | null
  readonly models?: readonly string[] | null
  readonly modelMap?: Readonly<Record<string, string>> | null
  readonly health?: string | null
  readonly credentialConfigured?: boolean
  readonly accessExpiresAt?: string | null
}

interface AccountAdminSeam {
  list(): readonly AccountSeamRecord[]
}

/** 账号当前是否可用（与 Go 侧 `usable` 的口径对齐 + 启用 / 健康判断）。 */
function isAccountUsable(account: AccountSeamRecord, nowMs: number): boolean {
  // 停用 / 非 active / 自动停用的账号不提供任何模型。
  if (account.enabled === false) return false
  if (typeof account.status === 'string' && account.status !== 'active') return false
  // 健康状态是「未知也可能是好」的语义：unhealthy 才排除（与 Go 侧 exclude_unhealthy 一致）。
  if (account.health === 'unhealthy') return false
  // 凭据没配好 = 根本调不通。
  if (account.credentialConfigured === false) return false
  // 令牌已过期 = 调不通。
  if (typeof account.accessExpiresAt === 'string' && account.accessExpiresAt !== '') {
    const expiresAt = Date.parse(account.accessExpiresAt)
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false
  }
  return true
}

interface ModelAccumulator {
  readonly model: string
  accountCount: number
  healthyAccountCount: number
  readonly protocols: Set<string>
  readonly upstreamModels: Set<string>
}

export class ModelHubService extends Service {
  static Config = MODELHUB_CONFIG_SCHEMA

  /**
   * 不 inject 任何服务：价格与账号都在运行期解析。
   * 任何一方缺席时，目录降级而不是整个插件 PENDING（见文件头的「三条纪律」）。
   */
  static inject: readonly string[] = []

  static catalog = {
    capabilities: ['model-catalog', 'model-pricing-view'],
    events: [],
    bridge: [],
    storage: [],
    shapes: {
      ModelEntry: {
        description: '一个对外模型的目录条目：价格（十进制字符串，元 / 百万 token）与账号覆盖度',
        fields: {
          model: { type: 'string' },
          priced: { type: 'boolean' },
          price: { type: 'object|null' },
          accountCount: { type: 'integer' },
          healthyAccountCount: { type: 'integer' },
          protocols: { type: 'string[]' },
          upstreamModels: { type: 'string[]' },
          mapped: { type: 'boolean' },
        },
      },
    },
  } as const

  readonly config: ResolvedModelHubConfig
  private readonly logger: Logger

  constructor(ctx: Context, config: ModelHubConfig | ResolvedModelHubConfig = {}) {
    super(ctx, 'modelhub')
    const resolved = validateModelHubConfig(config)
    if (isIssueList(resolved)) {
      throw new ModelHubError(
        'MODELHUB_CONFIG_INVALID',
        `模型广场插件配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.logger = ctx.logger('modelhub')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.logger.info(
      `模型广场插件已装载：只读聚合（价格 + 账号覆盖度）；` +
        `未定价模型 ${this.config.includeUnpriced ? '列出' : '隐藏'}`,
    )
    yield () => {
      // 没有需要回收的东西：这个插件不注册定时器、不开连接、不监听事件。
    }
  }

  /**
   * 目录查询。**现算**，不落盘、不缓存。
   *
   * 过滤条件不合法时抛 `MODELHUB_QUERY_INVALID`（HTTP 层映射 400）。
   */
  catalog(query: ModelCatalogQuery = {}): ModelCatalog {
    const normalized = normalizeQuery(query)
    const nowMs = Date.now()

    const prices = this.priceTable()
    const accounts = this.accountList()
    const accumulators = new Map<string, ModelAccumulator>()

    // 账号提供的事实：模型名 → 覆盖度。
    for (const account of accounts) {
      const usable = isAccountUsable(account, nowMs)
      const models = account.models ?? []
      for (const model of models) {
        const name = model.trim()
        if (name === '') continue
        let entry = accumulators.get(name)
        if (entry === undefined) {
          entry = {
            model: name,
            accountCount: 0,
            healthyAccountCount: 0,
            protocols: new Set<string>(),
            upstreamModels: new Set<string>(),
          }
          accumulators.set(name, entry)
        }
        entry.accountCount += 1
        if (usable) entry.healthyAccountCount += 1
        const protocol = typeof account.protocol === 'string' ? account.protocol.trim() : ''
        if (protocol !== '') entry.protocols.add(protocol)
        const upstream = account.modelMap?.[name]
        if (typeof upstream === 'string' && upstream.trim() !== '') {
          entry.upstreamModels.add(upstream.trim())
        }
      }
    }

    // 价格表里的模型：有精确价的都进目录（哪怕没有账号提供 —— 那就是「不可用」）。
    for (const model of prices.keys()) {
      if (model === '*') continue
      if (!accumulators.has(model)) {
        accumulators.set(model, {
          model,
          accountCount: 0,
          healthyAccountCount: 0,
          protocols: new Set<string>(),
          upstreamModels: new Set<string>(),
        })
      }
    }

    // 兜底价 `'*'`：没有精确价格的模型按它计价，但**不**把它当成一个模型列出来。
    const fallback = prices.get('*')

    const available: ModelEntry[] = []
    const unavailable: ModelUnavailableEntry[] = []

    for (const entry of accumulators.values()) {
      const exact = prices.get(entry.model)
      const price = exact ?? fallback
      const priced = exact !== undefined
      if (!priced && !this.config.includeUnpriced) continue

      if (entry.healthyAccountCount > 0) {
        available.push({
          model: entry.model,
          priced,
          price: price === undefined ? null : toPriceView(price),
          accountCount: entry.accountCount,
          healthyAccountCount: entry.healthyAccountCount,
          protocols: [...entry.protocols].sort(),
          upstreamModels: [...entry.upstreamModels].sort(),
          mapped: entry.upstreamModels.size > 0,
        })
        continue
      }

      const reason = entry.accountCount === 0 ? 'no_account' : 'no_healthy_account'
      unavailable.push({
        model: entry.model,
        reason,
        detail:
          reason === 'no_account'
            ? '还没有账号声明提供这个模型'
            : '提供这个模型的账号当前都不可用（停用、凭据缺失或健康检查未通过）',
        accountCount: entry.accountCount,
        price: price === undefined ? null : toPriceView(price),
        priced,
      })
    }

    const filtered = applyFilters({ available, unavailable }, normalized)

    // 统计口径跟随过滤后的结果（页面上的卡片与表格永远一致）。
    const pricedCount = [...filtered.available, ...filtered.unavailable].filter((item) => item.priced).length
    const summary: ModelCatalogSummary = {
      total: filtered.available.length + filtered.unavailable.length,
      availableCount: filtered.available.length,
      unavailableCount: filtered.unavailable.length,
      pricedCount,
      accountCount: accounts.length,
    }

    return {
      available: filtered.available,
      unavailable: filtered.unavailable,
      summary,
    }
  }

  // ───────────────────────────────── 内部

  /** 运行期解析价格服务（不 inject，D5）。 */
  private pricingSeam(): PricingSeam | undefined {
    const impl = this.ctx.root.reflect._getImpl('pricing', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<PricingSeam> | undefined
    return typeof value?.list === 'function' ? (value as PricingSeam) : undefined
  }

  /** 运行期解析账号管理门面（不 inject，D5）。 */
  private accountSeam(): AccountAdminSeam | undefined {
    const impl = this.ctx.root.reflect._getImpl('accountAdmin', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<AccountAdminSeam> | undefined
    return typeof value?.list === 'function' ? (value as AccountAdminSeam) : undefined
  }

  private priceTable(): Map<string, ModelPriceView> {
    const table = new Map<string, ModelPriceView>()
    const pricing = this.pricingSeam()
    if (pricing === undefined) return table
    try {
      for (const price of pricing.list()) {
        table.set(price.model, toPriceView(price))
      }
    } catch (error) {
      // 价格服务出错不该让整个目录挂掉：记一条警告，目录退化成「没有价格」。
      this.logger.warn(`读取价格表失败，模型目录将不含价格：${describe(error)}`)
    }
    return table
  }

  private accountList(): readonly AccountSeamRecord[] {
    const accounts = this.accountSeam()
    if (accounts === undefined) return []
    try {
      return accounts.list()
    } catch (error) {
      this.logger.warn(`读取账号列表失败，模型目录将不含覆盖度：${describe(error)}`)
      return []
    }
  }
}

function toPriceView(price: {
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: string
  readonly updatedAt: string
}): ModelPriceView {
  return {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion,
    cacheWritePerMillion: price.cacheWritePerMillion,
    currency: price.currency,
    updatedAt: price.updatedAt,
  }
}

interface NormalizedQuery {
  search?: string
  availability?: 'all' | 'available' | 'unavailable'
  priced?: 'all' | 'priced' | 'unpriced'
}

function normalizeQuery(query: ModelCatalogQuery): NormalizedQuery {
  const result: NormalizedQuery = {}
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') {
      throw new ModelHubError('MODELHUB_QUERY_INVALID', 'search 必须是字符串')
    }
    const search = query.search.trim()
    if (search !== '') result.search = search
  }
  if (query.availability !== undefined) {
    if (query.availability !== 'all' && query.availability !== 'available' && query.availability !== 'unavailable') {
      throw new ModelHubError(
        'MODELHUB_QUERY_INVALID',
        `availability 只能是 all / available / unavailable，收到 ${String(query.availability)}`,
      )
    }
    result.availability = query.availability
  }
  if (query.priced !== undefined) {
    if (query.priced !== 'all' && query.priced !== 'priced' && query.priced !== 'unpriced') {
      throw new ModelHubError(
        'MODELHUB_QUERY_INVALID',
        `priced 只能是 all / priced / unpriced，收到 ${String(query.priced)}`,
      )
    }
    result.priced = query.priced
  }
  return result
}

function applyFilters(
  catalog: { readonly available: readonly ModelEntry[]; readonly unavailable: readonly ModelUnavailableEntry[] },
  query: ModelCatalogQuery,
): { readonly available: ModelEntry[]; readonly unavailable: ModelUnavailableEntry[] } {
  const search = query.search?.toLowerCase()
  const matches = (model: string): boolean => search === undefined || model.toLowerCase().includes(search)

  let available = catalog.available.filter((item) => matches(item.model))
  let unavailable = catalog.unavailable.filter((item) => matches(item.model))

  if (query.availability === 'available') {
    unavailable = []
  } else if (query.availability === 'unavailable') {
    available = []
  }
  if (query.priced === 'priced') {
    available = available.filter((item) => item.priced)
    unavailable = unavailable.filter((item) => item.priced)
  } else if (query.priced === 'unpriced') {
    available = available.filter((item) => !item.priced)
    unavailable = unavailable.filter((item) => !item.priced)
  }

  return { available, unavailable }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
