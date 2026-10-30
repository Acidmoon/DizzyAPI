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
 * 这个文件只放**编排**（定时器 / 事件 / 单飞 / 状态）；快照怎么算在 `snapshot.ts`，
 * 类型在 `types.ts`。
 *
 * 边界（AGENTS.md §2.2 / §2.4）：
 * - **自己不存数据**：价格是 `pricing` 的唯一数据，key 是 `apiKey` 的，用量是 `usage` 的；
 *   本插件只读、只转发；
 * - 桥归 `account-priority`（Go 是服务端、TS 是客户端），本插件不直接建连；
 * - 全部副作用挂 `ctx.effect`：卸载即停定时器与 debounce。
 */
import { Service, FiberState, type Context, type Logger } from 'cordis'
// 只为了类型：@cordisjs/plugin-timer 往 Context 上 mixin 了 setInterval。
import type {} from '@cordisjs/plugin-timer'
import { describeError } from '@dizzyapi/plugin-kit'
import { GATE_FEED_CONFIG_SCHEMA, type GateFeedConfig, type ResolvedGateFeedConfig } from './config.ts'
import {
  buildKeySpendSnapshot,
  buildPriceSnapshot,
  type SnapshotSources,
  type SpendCache,
} from './snapshot.ts'
import type {
  ApiKeySeam,
  BridgeSeam,
  GateFeedStatus,
  GoSnapshotState,
  PricingSeam,
  UsageSeam,
} from './types.ts'

/** 「同一原因」告警的最小间隔（防高 QPS / 桥断时刷屏）。 */
const WARN_THROTTLE_MS = 30_000

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
  /** Go 侧两份快照的健康度（每轮读一次；读不到是 null，不影响推送）。 */
  private goPricing: GoSnapshotState | null = null
  private goSpend: GoSnapshotState | null = null
  /**
   * 定价闸门装没装：`null` = 还没读到过 Go 侧状态。
   *
   * 只在**读到了** `pricing.status` 之后才更新：读失败保持上一次的值而不是退回 null，
   * 否则一次桥抖动就会让价格页从「闸门开着」翻成「不知道」。
   */
  private pricingGateEnabled: boolean | null = null
  /** 上一轮算出的消费快照缓存：key 集合与用量游标都没变时直接复用。 */
  private spendCache: SpendCache | undefined
  private spendRecomputes = 0
  private spendReuses = 0
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
      goPricing: this.goPricing,
      goSpend: this.goSpend,
      pricingGateEnabled: this.pricingGateEnabled,
      spendRecomputes: this.spendRecomputes,
      spendReuses: this.spendReuses,
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
      const sources = this.snapshotSources()

      const prices = buildPriceSnapshot(sources, () => this.nextGeneration())
      await bridge.replacePricing(prices.payload)
      this.lastPriceRevision = prices.payload.revision
      this.prices = prices.count

      // 消费快照：只有「配了金额上限」的 key 需要算（其余 key 的 Go 侧判定根本不做）。
      const spend = await buildKeySpendSnapshot(sources, () => this.nextGeneration(), this.spendCache)
      if (this.disposed) return
      await bridge.replaceKeySpend(spend.payload)
      this.lastSpendRevision = spend.payload.revision
      this.limitedKeys = spend.limitedKeys
      if (spend.cached) {
        this.spendReuses += 1
      } else {
        this.spendRecomputes += 1
        this.spendCache = spend.cache
      }

      // 推完之后读一次 Go 的健康度：闸门是 fail-closed，stale 必须能在管理面看到。
      await this.inspectGoState()

      this.lastPushAt = new Date().toISOString()
      this.lastSuccessAt = this.lastPushAt
      this.lastError = null
      this.failureStreak = 0
      this.pushes += 1
      this.ctx.emit('gate-feed/pushed', prices.count, spend.limitedKeys)
      this.logger.debug(
        `闸门快照已推送（${reason}）：priceRevision=${prices.payload.revision} prices=${String(prices.count)} ` +
          `spendRevision=${spend.payload.revision} limitedKeys=${String(spend.limitedKeys)}`,
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
   * 读一次 Go 侧两份快照的健康度，暴露到 status()。
   *
   * 为什么必须有：`-pricing-gate` 是 **fail-closed**，快照 stale 就是全站 503。
   * 只把这件事写进日志等于「线上 503 了没人知道为什么」，所以 `ready` / `stale` /
   * `ageMs` / `ttlMs` 必须在 status() 里能看到。读不到（旧 Go / 桥断）就静默跳过——
   * 它只是观测，不能影响推送本身。
   */
  private async inspectGoState(): Promise<void> {
    try {
      const bridge = this.bridgeSeam()
      const pricing = (await bridge.pricingStatus()) as Record<string, unknown>
      const spend = (await bridge.keySpendStatus()) as Record<string, unknown>
      this.goPricing = goStateOf(pricing)
      this.goSpend = goStateOf(spend)
      // 定价闸门装没装：`pricing.status` 的 `gate` 是 omitempty，**闸门没装就不出现**。
      // 指针非 nil 时哪怕计数全 0 也会输出 `"gate":{}`，所以「键在」= 闸门装了。
      this.pricingGateEnabled = Object.hasOwn(pricing, 'gate')
      if (this.goPricing.ttlMs > 0) {
        this.goTtlMs = this.goPricing.ttlMs
        if (this.goPricing.ttlMs < this.config.pollIntervalMs * 2) {
          this.logger.warn(
            `Go 侧价格快照 TTL=${String(this.goPricing.ttlMs)}ms 小于 2 × 推送间隔 ` +
              `${String(this.config.pollIntervalMs)}ms：心跳可能来不及刷新，` +
              '请把 -pricing-snapshot-ttl-ms 提到 ≥ 3 倍推送间隔',
          )
        }
      }
      if (this.goPricing.stale) {
        // 刚推完还是 stale：要么 TTL 比心跳还短，要么两次推送之间的空窗太长。
        this.logger.warn('刚推送完价格快照，Go 侧仍判定 stale：定价闸门会 fail-closed（503）')
      }
    } catch {
      // 观测失败不影响推送。
    }
  }

  // ───────────────────────────────── 内部：外部来源（结构面）

  private snapshotSources(): SnapshotSources {
    return {
      pricing: this.pricingSeam(),
      apiKey: this.apiKeySeam(),
      usage: this.usageSeam(),
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

/** 把 Go 的 pricing.status / keyspend.status 归一成一小块健康度（缺字段按「不可用」）。 */
function goStateOf(raw: Record<string, unknown>): GoSnapshotState {
  return {
    ready: raw.ready === true,
    stale: raw.stale === true,
    ageMs: typeof raw.ageMs === 'number' ? raw.ageMs : 0,
    ttlMs: typeof raw.ttlMs === 'number' ? raw.ttlMs : 0,
  }
}

export type { GateFeedConfig }
