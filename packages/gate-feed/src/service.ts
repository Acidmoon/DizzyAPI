/**
 * 闸门快照推送插件（服务名 `gateFeed`）。
 *
 * 它只做一件事：把两份**执行面快照**心跳式推给 Go：
 *
 *  1. **价格表**（`pricing.replace`）→ Go 的定价闸门判定「这个模型有没有价」；
 *  2. **每个 API key 的累计消费**（`keyspend.replace`）→ Go 的 key-gate 判定
 *     「key 的金额上限到了没有」。
 *
 * 为什么必须是心跳式：Go 侧按 TTL 判快照新鲜度。定价闸门是 **fail-closed**，
 * 「内容没变就跳过推送」会让它在 TTL 一到把所有请求打成 503（额度闸门
 * 2026-10-29 的生产事故就是同一类错误）。所以每一轮都推：`revision` 相同、
 * `generation` 递增，Go 侧会刷新 `updatedAt`。
 *
 * 边界（AGENTS.md §2.2 / §2.4）：
 * - **自己不存数据**：价格是 `pricing` 的唯一数据，key 是 `apiKey` 的，用量是 `usage` 的；
 *   本插件只读、只转发；
 * - 桥归 `account-priority`（Go 是服务端、TS 是客户端），本插件不直接建连；
 * - 全部副作用挂 `ctx.effect`：卸载即停定时器与 debounce。
 */
import { createHash } from 'node:crypto'
import { Service, FiberState, type Context, type Logger } from 'cordis'
// 只为了类型：@cordisjs/plugin-timer 往 Context 上 mixin 了 setInterval。
import type {} from '@cordisjs/plugin-timer'
import { describeError } from '@dizzyapi/plugin-kit'
import { GATE_FEED_CONFIG_SCHEMA, type GateFeedConfig, type ResolvedGateFeedConfig } from './config.ts'
import { GateFeedError } from './errors.ts'

/** 「同一原因」告警的最小间隔（防高 QPS / 桥断时刷屏）。 */
const WARN_THROTTLE_MS = 30_000

/** 价格服务的结构面：只声明用到的方法，不 import 实现类。 */
interface PricingSeam {
  list(): readonly {
    readonly model: string
    readonly inputPerMillion: string
    readonly outputPerMillion: string
    readonly cacheReadPerMillion: string
    readonly cacheWritePerMillion: string
  }[]
}

/** api-key 服务的结构面：只要 key 的 id 与金额上限（不要秘密）。 */
interface ApiKeySeam {
  listAll(): Promise<readonly { readonly id: string; readonly spendingLimitMicros: string | null }[]>
}

/** 用量服务的结构面：按 key 汇总费用（读取时按当前价格表算）。 */
interface UsageSeam {
  summary(query: {
    readonly fromMs: number
    readonly toMs: number
    readonly apiKeyId?: string
  }): { readonly totals: { readonly costMicros: string } }
}

/** 控制桥的持有者（account-priority）暴露给本插件的那一小块。 */
interface BridgeSeam {
  replacePricing(snapshot: PricingSnapshotPayload): Promise<unknown>
  pricingStatus(): Promise<unknown>
  replaceKeySpend(snapshot: KeySpendSnapshotPayload): Promise<unknown>
  keySpendStatus(): Promise<unknown>
}

export interface PriceEntryPayload {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
}

export interface PricingSnapshotPayload {
  readonly version: 1
  readonly generation: number
  readonly revision: string
  readonly prices: readonly PriceEntryPayload[]
}

export interface KeySpendEntryPayload {
  readonly keyId: string
  readonly spentMicros: string
}

export interface KeySpendSnapshotPayload {
  readonly version: 1
  readonly generation: number
  readonly revision: string
  readonly entries: readonly KeySpendEntryPayload[]
}

/** 面向排障的可观察状态（不含价格明细与 key id）。 */
export interface GateFeedStatus {
  readonly enabled: boolean
  readonly pollIntervalMs: number
  readonly debounceMs: number
  readonly lastPriceRevision: string | null
  readonly lastSpendRevision: string | null
  readonly lastPushAt: string | null
  readonly lastSuccessAt: string | null
  readonly lastError: string | null
  readonly pushes: number
  readonly failures: number
  readonly failureStreak: number
  /** 是否有一轮推送在飞。 */
  readonly inFlight: boolean
  /** 最近一轮算出的价格条数与带金额上限的 key 数（运维看规模用）。 */
  readonly prices: number
  readonly limitedKeys: number
  /** Go 侧价格快照 TTL（读一次 pricing.status 得到）；读不到为 null。 */
  readonly goTtlMs: number | null
  /** Go 侧 TTL 是否盖不住两个推送周期（配置耦合错误，心跳救不了）。 */
  readonly heartbeatTooSlow: boolean
}

export class GateFeedService extends Service {
  static Config = GATE_FEED_CONFIG_SCHEMA

  /**
   * 依赖：价格来源（pricing）、桥的持有者（accountPriority）、定时器 mixin（timer）。
   *
   * 不 inject `apiKey` / `usage`：它们是**可选**的只读来源（api-key 被禁用时没有 key，
   * 用量被禁用时算不出消费），本插件运行期解析，缺了只少一份快照，不该整体 PENDING。
   */
  static inject = ['pricing', 'accountPriority', 'timer']

  static catalog = {
    capabilities: ['pricing-snapshot-push', 'key-spend-snapshot-push', 'gate-feed-heartbeat'],
    events: [
      {
        name: 'gate-feed/pushed',
        description: 'Go 侧确认缓存了一版价格快照 / key 消费快照（不含明细）',
        payload: 'pricing: number, keys: number',
      },
      {
        name: 'gate-feed/error',
        description: '闸门快照推送失败（已按节流写日志）',
        payload: 'code: string, message: string',
      },
    ],
    bridge: [
      {
        method: 'pricing.replace',
        direction: 'outbound',
        requestShape: 'GatewayPricingSnapshot',
        responseShape: 'GatewayPricingResult',
      },
      { method: 'pricing.status', direction: 'outbound', responseShape: 'GatewayPricingStatus' },
      {
        method: 'keyspend.replace',
        direction: 'outbound',
        requestShape: 'GatewayKeySpendSnapshot',
        responseShape: 'GatewayKeySpendResult',
      },
      { method: 'keyspend.status', direction: 'outbound', responseShape: 'GatewayKeySpendStatus' },
    ],
    storage: [],
    methods: {
      status: { description: '推送状态与最近一次错误（不含价格明细与 key id）' },
      pushNow: { description: '立刻推一轮（运维 / 测试用，不等心跳）' },
    },
  } as const

  readonly config: ResolvedGateFeedConfig
  private logger: Logger
  private generation = 0
  private lastPriceRevision: string | null = null
  private lastSpendRevision: string | null = null
  private lastPushAt: string | null = null
  private lastSuccessAt: string | null = null
  private lastError: string | null = null
  private pushes = 0
  private failures = 0
  private failureStreak = 0
  private goTtlMs: number | null = null
  private inFlight = false
  private disposed = false
  private debounceTimer: NodeJS.Timeout | undefined
  private lastWarnAt = 0
  private queue: Promise<unknown> = Promise.resolve()
  private prices = 0
  private limitedKeys = 0

  constructor(ctx: Context, config: ResolvedGateFeedConfig) {
    super(ctx, 'gateFeed')
    this.config = config
    this.logger = ctx.logger('gate-feed')

    this.listenChanged()

    if (!config.enabled) {
      this.logger.info('闸门快照推送已关闭（enabled=false）：定价闸门将按 fail-closed 处理，建议同时关掉 -pricing-gate')
      return
    }

    ctx.effect(() => {
      const stop = ctx.setInterval(() => {
        void this.push('interval')
      }, config.pollIntervalMs)
      return () => {
        this.disposed = true
        stop()
        this.clearDebounce()
      }
    }, 'gate-feed.poll')

    // 启动时先推一轮，别让 Go 等到第一个心跳周期（定价闸门是 fail-closed）。
    void this.push('start')
    this.logger.info(
      `闸门快照推送已装载：心跳 ${config.pollIntervalMs}ms、变更 debounce ${config.debounceMs}ms`,
    )
  }

  /** 立刻推一轮（测试与管理面用）。 */
  async pushNow(): Promise<void> {
    await this.push('manual')
  }

  status(): GateFeedStatus {
    return {
      enabled: this.config.enabled,
      pollIntervalMs: this.config.pollIntervalMs,
      debounceMs: this.config.debounceMs,
      lastPriceRevision: this.lastPriceRevision,
      lastSpendRevision: this.lastSpendRevision,
      lastPushAt: this.lastPushAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      pushes: this.pushes,
      failures: this.failures,
      failureStreak: this.failureStreak,
      inFlight: this.inFlight,
      prices: this.prices,
      limitedKeys: this.limitedKeys,
      goTtlMs: this.goTtlMs,
      heartbeatTooSlow:
        this.goTtlMs !== null && this.goTtlMs < this.config.pollIntervalMs * 2,
    }
  }

  // ───────────────────────────────── 内部：事件与调度

  private listenChanged(): void {
    const target = this.ctx as unknown as {
      on(event: string, listener: (...args: unknown[]) => void): unknown
    }
    const schedule = (): void => this.schedule()
    // 价格改了 → 立刻补推（否则 Go 的闸门会拿着旧价表跑到下一个心跳）。
    target.on('pricing/changed', schedule)
    // key 的上限 / 启停改了 → 消费快照要重算（带金额上限的 key 集合可能变了）。
    target.on('api-key/changed', schedule)
  }

  private schedule(): void {
    if (this.disposed) return
    this.clearDebounce()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.push('debounce')
    }, this.config.debounceMs)
    this.debounceTimer.unref?.()
  }

  private clearDebounce(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  /** 单飞：同一时刻最多一次推送，其余排队（队列吞掉失败，避免污染下一轮）。 */
  private push(reason: string): Promise<void> {
    const task = this.queue.then(
      () => this.doPush(reason),
      () => this.doPush(reason),
    )
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async doPush(reason: string): Promise<void> {
    if (this.disposed || !this.config.enabled) return
    this.inFlight = true
    try {
      const bridge = this.bridgeSeam()
      const prices = this.buildPriceSnapshot()
      await bridge.replacePricing(prices)
      this.lastPriceRevision = prices.revision
      this.prices = prices.prices.length

      if (this.goTtlMs === null) void this.inspectGoTtl()

      // 消费快照：只有「配了金额上限」的 key 需要算（其余 key 的 Go 侧判定根本不做）。
      const spend = await this.buildKeySpendSnapshot()
      if (this.disposed) return
      await bridge.replaceKeySpend(spend)
      this.lastSpendRevision = spend.revision
      this.limitedKeys = spend.entries.length

      this.lastPushAt = new Date().toISOString()
      this.lastSuccessAt = this.lastPushAt
      this.lastError = null
      this.failureStreak = 0
      this.pushes += 1
      this.ctx.emit('gate-feed/pushed', prices.prices.length, spend.entries.length)
      this.logger.debug(
        `闸门快照已推送（${reason}）：priceRevision=${prices.revision} prices=${String(prices.prices.length)} ` +
          `spendRevision=${spend.revision} limitedKeys=${String(spend.entries.length)}`,
      )
    } catch (error) {
      this.failures += 1
      this.failureStreak += 1
      this.lastError = describeError(error)
      this.warnThrottled(
        `推送闸门快照失败（${reason}，连续第 ${String(this.failureStreak)} 次）：${this.lastError}`,
      )
      this.ctx.emit('gate-feed/error', 'GATE_FEED_PUSH_FAILED', this.lastError)
      // 失败重试走同一个 debounce 窗口，不额外造一条无界重试循环。
      this.schedule()
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 价格快照：模型名 + 四项单价（元 / 百万 token，十进制字符串）。
   *
   * 客户端不校验单价语义（那是 pricing 的事），但仍然拒绝明显不是十进制字符串的值：
   * Go 侧形状校验失败会整份拒绝，推一份注定被拒的快照只会让闸门一直 503。
   */
  private buildPriceSnapshot(): PricingSnapshotPayload {
    const entries: PriceEntryPayload[] = []
    for (const price of this.pricingSeam().list()) {
      for (const [field, value] of [
        ['inputPerMillion', price.inputPerMillion],
        ['outputPerMillion', price.outputPerMillion],
        ['cacheReadPerMillion', price.cacheReadPerMillion],
        ['cacheWritePerMillion', price.cacheWritePerMillion],
      ] as const) {
        if (typeof value !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(value)) {
          throw new GateFeedError(
            'GATE_FEED_PRICE_INVALID',
            `模型价格 ${price.model} 的 ${field} 不是十进制数字串：${String(value)}`,
          )
        }
      }
      entries.push({
        model: price.model,
        inputPerMillion: price.inputPerMillion,
        outputPerMillion: price.outputPerMillion,
        cacheReadPerMillion: price.cacheReadPerMillion,
        cacheWritePerMillion: price.cacheWritePerMillion,
      })
    }
    entries.sort((left, right) => left.model.localeCompare(right.model))
    return {
      version: 1,
      generation: this.nextGeneration(),
      revision: hashOf(entries),
      prices: entries,
    }
  }

  /**
   * 每个 key 的累计消费：只算「配了金额上限」的 key（其余 key Go 侧不判金额）。
   *
   * 数据来源是 `usage`（读取时按当前价格表算费用）：花钱的事实只有 TS 知道，
   * Go 只读、只比大小。用量插件 / api-key 插件缺席时推空快照——
   * Go 侧把它当「没有这个 key 的消费记录」，按未知放行（可用性优先）。
   */
  private async buildKeySpendSnapshot(): Promise<KeySpendSnapshotPayload> {
    const entries: KeySpendEntryPayload[] = []
    const apiKey = this.apiKeySeam()
    const usage = this.usageSeam()
    if (apiKey !== undefined && usage !== undefined) {
      const keys = await apiKey.listAll()
      for (const key of keys) {
        if (key.spendingLimitMicros === null) continue
        const summary = usage.summary({
          fromMs: 0,
          toMs: Number.MAX_SAFE_INTEGER,
          apiKeyId: key.id,
        })
        const spent = summary.totals.costMicros
        if (typeof spent !== 'string' || !/^[0-9]+$/.test(spent)) {
          throw new GateFeedError(
            'GATE_FEED_SPEND_INVALID',
            `用量汇总返回的费用不是非负十进制微元：${String(spent)}`,
          )
        }
        entries.push({ keyId: key.id, spentMicros: spent })
      }
    }
    entries.sort((left, right) => left.keyId.localeCompare(right.keyId))
    return {
      version: 1,
      generation: this.nextGeneration(),
      revision: hashOf(entries),
      entries,
    }
  }

  /** 单调递增的推送序号：同一毫秒内连推两次也不会相同，重启后靠时间戳继续向上。 */
  private nextGeneration(): number {
    const now = Date.now()
    this.generation = now > this.generation ? now : this.generation + 1
    return this.generation
  }

  /**
   * 失败告警：区分「偶发」与「持续」。
   *
   * 第 1 次连续失败立即报；之后每 10 次连续失败再报一次（文案带连续次数），
   * 中间还有最小间隔保护。这样「一直推不出去」不会被节流彻底藏起来。
   */
  private warnThrottled(message: string): void {
    const first = this.failureStreak === 1
    const sustained = this.failureStreak > 1 && this.failureStreak % 10 === 0
    if (!first && !sustained) return
    const now = Date.now()
    if (now - this.lastWarnAt < WARN_THROTTLE_MS) return
    this.lastWarnAt = now
    this.logger.warn(message)
  }

  /**
   * 读一次 Go 侧价格快照的 TTL，暴露到 status()，并在心跳跟不上 TTL 时明确告警。
   *
   * 这是配置耦合的护栏（TTL 必须 ≥ 3 × pollIntervalMs）。读不到（旧 Go / 桥断）
   * 就静默跳过——它只是观测，不能影响推送本身。
   */
  private async inspectGoTtl(): Promise<void> {
    try {
      const state = (await this.bridgeSeam().pricingStatus()) as { ttlMs?: unknown }
      const ttlMs = typeof state.ttlMs === 'number' && state.ttlMs > 0 ? state.ttlMs : null
      if (ttlMs === null) return
      this.goTtlMs = ttlMs
      if (ttlMs < this.config.pollIntervalMs * 2) {
        this.logger.warn(
          `Go 侧价格快照 TTL=${String(ttlMs)}ms 小于 2 × 推送间隔 ${String(this.config.pollIntervalMs)}ms：` +
            '心跳可能来不及刷新，请把 -pricing-snapshot-ttl-ms 提到 ≥ 3 倍推送间隔',
        )
      }
    } catch {
      // 观测失败不影响推送。
    }
  }

  private pricingSeam(): PricingSeam {
    return this.ctx.pricing as unknown as PricingSeam
  }

  private bridgeSeam(): BridgeSeam {
    return this.ctx.get('accountPriority') as unknown as BridgeSeam
  }

  /** 运行期解析 api-key（不 inject：它被禁用时本插件不该跟着 PENDING）。 */
  private apiKeySeam(): ApiKeySeam | undefined {
    const impl = this.ctx.root.reflect._getImpl('apiKey', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<ApiKeySeam> | undefined
    return typeof value?.listAll === 'function' ? (value as ApiKeySeam) : undefined
  }

  /** 运行期解析 usage（同上：它被禁用时只少一份消费快照）。 */
  private usageSeam(): UsageSeam | undefined {
    const impl = this.ctx.root.reflect._getImpl('usage', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<UsageSeam> | undefined
    return typeof value?.summary === 'function' ? (value as UsageSeam) : undefined
  }
}

function hashOf(entries: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 32)
}

export type { GateFeedConfig }
