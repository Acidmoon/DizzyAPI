/**
 * 余额只读快照推送插件（服务名 `quota`）。
 *
 * 它只做一件事：把 `user` 的全量余额（只读）打包成快照，经 `accountPriority` 的
 * 控制桥推给 Go 的额度闸门（`quota.replace`）。
 *
 * **推送是心跳式**：每个 `pollIntervalMs` 周期都推一次，即使余额内容没变
 * （`revision` 相同、`generation` 递增）。Go 侧按 TTL 判快照新鲜度，
 * 「没变就跳过」等于让闸门在余额不变的十几秒后自动失效——那是拿正确性换流量，
 * 2026-10-29 生产上就是这么漏的（余额已 -97 仍然 200）。余额变更时另有
 * debounce 立即补推。
 *
 * 边界（AGENTS.md §2.2 / §2.4）：
 * - **自己不存数据、不做判断**：不落盘、没有 SQLite、不读余额表；
 * - 余额的唯一写者仍是 `user`，本插件只调它的只读接口 `balanceSnapshot()`；
 * - 桥的拥有者是 `account-priority`（Go 是服务端、TS 是客户端），本插件不直接建连；
 * - 全部副作用挂 `ctx.effect`：卸载即停定时器与 debounce；Go 侧按自己的 TTL 自然过期，
 *   所以禁用本插件不会让闸门永远停在旧余额上。
 */
import { createHash } from 'node:crypto'
import { Service, type Context, type Logger } from 'cordis'
// 只为了类型：@cordisjs/plugin-timer 往 Context 上 mixin 了 setInterval。
import type {} from '@cordisjs/plugin-timer'
import { describeError } from '@dizzyapi/plugin-kit'
import { QUOTA_CONFIG_SCHEMA, type QuotaConfig, type ResolvedQuotaConfig } from './config.ts'
import { QuotaError } from './errors.ts'

/** 幂等：同一版内容重推时，Go 会按 generation + revision 判重。 */
const DEFAULT_WARN_THROTTLE_MS = 30_000

/** 用户插件的只读视图：本插件不 import 它的实现。 */
interface UserSeam {
  balanceSnapshot(): Promise<{
    readonly entries: readonly { readonly userId: string; readonly balanceMicros: string }[]
  }>
}

/** 控制桥的持有者（account-priority）暴露给本插件的那一小块。 */
interface BridgeSeam {
  replaceQuota(snapshot: QuotaSnapshotPayload): Promise<unknown>
  quotaStatus(): Promise<unknown>
}

export interface QuotaSnapshotEntry {
  readonly userId: string
  readonly balanceMicros: string
}

export interface QuotaSnapshotPayload {
  readonly version: 1
  readonly generation: number
  readonly revision: string
  readonly entries: readonly QuotaSnapshotEntry[]
}

/** 面向排障的可观察状态（不含任何余额值）。 */
export interface QuotaStatus {
  readonly enabled: boolean
  readonly pollIntervalMs: number
  readonly debounceMs: number
  /** 最近一次成功推送的 revision；还没成功过为 null。 */
  readonly lastRevision: string | null
  readonly lastPushAt: string | null
  /** 最近一次失败的描述；成功一次即清空。 */
  readonly lastError: string | null
  /** 成功推送次数（含心跳）。 */
  readonly pushes: number
  readonly failures: number
  /** 内容没变、但仍按心跳推出去的次数（`pushes` 的子集）。 */
  readonly heartbeats: number
  /** 连续失败次数；成功一次即归零。 */
  readonly failureStreak: number
  /** 最近一次成功推送的时间；还没成功过为 null。 */
  readonly lastSuccessAt: string | null
  /** Go 侧的快照 TTL（读一次 quota.status 得到）；读不到为 null。 */
  readonly goTtlMs: number | null
  /** Go 侧 TTL 是否不足以覆盖两个推送周期（配置耦合错误，心跳也救不了）。 */
  readonly heartbeatTooSlow: boolean
  /** 当前是否有一次推送在飞。 */
  readonly inFlight: boolean
}

/** 余额变更事件的载荷：只读声明，避免 import user 的实现。 */
interface UserChangedPayload {
  readonly fields?: readonly string[]
}

export class QuotaService extends Service {
  static Config = QUOTA_CONFIG_SCHEMA

  /**
   * 依赖：余额来源（user）、桥的持有者（accountPriority）、定时器 mixin（timer）。
   * 缺任何一个都停在 PENDING——没有桥就推不了，没有 timer 就不该偷偷用裸 setInterval。
   */
  static inject = ['user', 'accountPriority', 'timer']

  /** 纯后台任务：没有 HTTP 路由、没有存储；桥命令是出站的 quota.replace / quota.status。 */
  static catalog = {
    capabilities: ['balance-snapshot-push', 'quota-gate-feed', 'snapshot-heartbeat'],
    events: [
      {
        name: 'quota/pushed',
        description: 'Go 侧确认缓存了一版余额快照（不含任何余额）',
        payload: 'revision: string, entries: number',
      },
      {
        name: 'quota/error',
        description: '余额快照推送失败（已按节流写日志）',
        payload: 'code: string, message: string',
      },
    ],
    bridge: [
      {
        method: 'quota.replace',
        direction: 'outbound',
        requestShape: 'QuotaSnapshotPayload',
        responseShape: 'quota.Result',
      },
      { method: 'quota.status', direction: 'outbound', responseShape: 'quota.State' },
    ],
    storage: [],
    methods: {
      status: { description: '推送状态与最近一次错误（不含任何余额值）' },
      pushNow: { description: '立刻推一次（运维 / 测试用，不等轮询）' },
    },
  } as const

  readonly config: ResolvedQuotaConfig
  private logger: Logger
  private revision: string | null = null
  private generation = 0
  private lastPushAt: string | null = null
  private lastError: string | null = null
  private pushes = 0
  private failures = 0
  private heartbeats = 0
  private failureStreak = 0
  private lastSuccessAt: string | null = null
  private goTtlMs: number | null = null
  private inFlight = false
  private disposed = false
  private debounceTimer: NodeJS.Timeout | undefined
  private lastWarnAt = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ResolvedQuotaConfig) {
    super(ctx, 'quota')
    this.config = config
    this.logger = ctx.logger('quota')

    // 余额变更 → debounce 补推；其它字段（改名 / 状态）与余额无关，不触发。
    this.listenUserChanged()

    if (!config.enabled) {
      this.logger.info('余额快照推送已关闭（enabled=false）：Go 侧额度闸门将按快照缺失策略处理')
      return
    }

    // 注册即副作用：定时器与 debounce 都挂 effect，卸载 / 禁用即回收（D5）。
    ctx.effect(() => {
      const stop = ctx.setInterval(() => {
        void this.push('interval')
      }, config.pollIntervalMs)
      return () => {
        this.disposed = true
        stop()
        this.clearDebounce()
      }
    }, 'quota.poll')

    // 启动时先推一次，别让 Go 等到第一个轮询周期。
    void this.push('start')
    this.logger.info(
      `余额快照推送已装载：全量间隔 ${config.pollIntervalMs}ms、变更 debounce ${config.debounceMs}ms`,
    )
  }

  /** 立刻推一次（测试与管理面用）；返回这一轮的 revision（失败返回 null）。 */
  async pushNow(): Promise<string | null> {
    await this.push('manual')
    return this.revision
  }

  status(): QuotaStatus {
    return {
      enabled: this.config.enabled,
      pollIntervalMs: this.config.pollIntervalMs,
      debounceMs: this.config.debounceMs,
      lastRevision: this.revision,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
      pushes: this.pushes,
      failures: this.failures,
      heartbeats: this.heartbeats,
      failureStreak: this.failureStreak,
      lastSuccessAt: this.lastSuccessAt,
      goTtlMs: this.goTtlMs,
      heartbeatTooSlow: this.goTtlMs !== null && heartbeatTooSlow(this.goTtlMs, this.config.pollIntervalMs),
      inFlight: this.inFlight,
    }
  }

  // ───────────────────────────────── 内部：事件与调度

  private listenUserChanged(): void {
    // 事件名与载荷由 user 插件声明；这里用最小结构声明，避免 import 它的实现。
    const target = this.ctx as unknown as {
      on(event: string, listener: (payload: UserChangedPayload) => void): unknown
    }
    target.on('user/changed', (payload) => {
      if (this.disposed) return
      const fields = payload.fields
      // fields 缺省 = 整条记录变化，按余额也可能变了处理（宁可多推一次）。
      if (fields !== undefined && !fields.includes('balance')) return
      this.schedule()
    })
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
    // enabled=false 是「本插件不参与推送」：连余额都不读，更不该占桥。
    if (this.disposed || !this.config.enabled) return
    this.inFlight = true
    try {
      const snapshot = await this.userSeam().balanceSnapshot()
      if (this.disposed) return
      const entries = this.normalizeEntries(snapshot.entries)
      const revision = hashEntries(entries)
      const unchanged = revision === this.revision
      // 心跳推送：内容没变也照推（revision 相同、generation 递增）。
      //
      // **绝不能「没变就跳过」**：Go 侧按 TTL 判快照新鲜度，跳过等于让额度闸门在
      // 余额不变的十几秒后自动失效（2026-10-29 生产事故：余额已 -97 仍 200）。
      // Go 侧对「同 revision + 更大 generation」是接受的，并会刷新 updatedAt。
      const payload: QuotaSnapshotPayload = {
        version: 1,
        generation: this.nextGeneration(),
        revision,
        entries,
      }
      await this.bridgeSeam().replaceQuota(payload)
      this.revision = revision
      this.lastPushAt = new Date().toISOString()
      this.lastSuccessAt = this.lastPushAt
      this.lastError = null
      this.failureStreak = 0
      this.pushes += 1
      if (unchanged) this.heartbeats += 1
      // 首次成功推送到 Go 之后，读一次它的 TTL：心跳间隔必须明显小于 TTL，
      // 否则「心跳也救不了」（配置耦合错误会让闸门周期性失效）。
      if (this.goTtlMs === null) void this.inspectGoTtl()
      this.logger.debug(
        `余额快照已推送（${reason}${unchanged ? '，内容未变=心跳' : ''}）：revision=${revision} entries=${String(entries.length)}`,
      )
      this.ctx.emit('quota/pushed', revision, entries.length)
    } catch (error) {
      this.failures += 1
      this.failureStreak += 1
      this.lastError = describeError(error)
      // 告警要能区分「偶发」与「持续」：第 1 次立即报，之后每 10 次再报一次，
      // 文案带上连续次数，避免「一直在失败」被 30 秒节流彻底藏起来。
      this.warnThrottled(
        `推送余额快照失败（${reason}，连续第 ${String(this.failureStreak)} 次）：${this.lastError}`,
      )
      this.ctx.emit('quota/error', 'QUOTA_PUSH_FAILED', this.lastError)
      // 失败重试：走同一个 debounce 窗口，不额外造一条无界重试循环。
      this.schedule()
    } finally {
      this.inFlight = false
    }
  }

  /**
   * 校验并规范化快照条目：userId 必须是十进制字符串、余额必须是十进制整数微元。
   *
   * 坏数据绝不静默跳过——那会让 Go 用旧余额放行；宁可整份不推、记明确错误。
   */
  private normalizeEntries(
    entries: readonly { readonly userId: string; readonly balanceMicros: string }[],
  ): QuotaSnapshotEntry[] {
    const normalized: QuotaSnapshotEntry[] = []
    const seen = new Set<string>()
    for (const entry of entries) {
      if (!/^[0-9]+$/.test(entry.userId)) {
        throw new QuotaError('QUOTA_SNAPSHOT_INVALID', `userId 必须是十进制数字串：${entry.userId}`)
      }
      if (!/^-?[0-9]+$/.test(entry.balanceMicros)) {
        throw new QuotaError(
          'QUOTA_SNAPSHOT_INVALID',
          `userId=${entry.userId} 的余额不是整数最小单位：${entry.balanceMicros}`,
        )
      }
      if (seen.has(entry.userId)) {
        throw new QuotaError('QUOTA_SNAPSHOT_INVALID', `userId 重复：${entry.userId}`)
      }
      seen.add(entry.userId)
      normalized.push({ userId: entry.userId, balanceMicros: entry.balanceMicros })
    }
    // 稳定排序：同样的余额集合必须得到同一个 revision。
    normalized.sort((left, right) => (BigInt(left.userId) < BigInt(right.userId) ? -1 : 1))
    return normalized
  }

  /** 单调递增的推送序号：同一毫秒内连续推两次也不会相同，重启后靠时间戳继续向上。 */
  private nextGeneration(): number {
    const now = Date.now()
    this.generation = now > this.generation ? now : this.generation + 1
    return this.generation
  }

  /**
   * 失败告警：区分「偶发」与「持续」。
   *
   * 第 1 次连续失败立即报；之后每 10 次连续失败再报一次（文案带连续次数），
   * 中间还有最小间隔保护，避免高频失败刷屏。这样「一直推不出去」不会被节流藏起来。
   */
  private warnThrottled(message: string): void {
    const first = this.failureStreak === 1
    const sustained = this.failureStreak > 1 && this.failureStreak % 10 === 0
    if (!first && !sustained) return
    const now = Date.now()
    if (now - this.lastWarnAt < DEFAULT_WARN_THROTTLE_MS) return
    this.lastWarnAt = now
    this.logger.warn(message)
  }

  /**
   * 读一次 Go 侧的快照 TTL，暴露到 status()，并在「心跳间隔不够快」时明确告警。
   *
   * 这是配置耦合的护栏：TTL 必须 ≥ 3 × pollIntervalMs（见 AGENTS.md「额度闸门」）。
   * 读不到（旧 Go / 桥断）就静默跳过——它只是观测，不能影响推送本身。
   */
  private async inspectGoTtl(): Promise<void> {
    try {
      const state = (await this.bridgeSeam().quotaStatus()) as { ttlMs?: unknown }
      const ttlMs = typeof state.ttlMs === 'number' && state.ttlMs > 0 ? state.ttlMs : null
      if (ttlMs === null) return
      this.goTtlMs = ttlMs
      if (heartbeatTooSlow(ttlMs, this.config.pollIntervalMs)) {
        this.logger.warn(
          `Go 侧快照 TTL=${String(ttlMs)}ms 小于 2 × 推送间隔 ${String(this.config.pollIntervalMs)}ms：` +
            '心跳可能来不及刷新，请把 -quota-snapshot-ttl-ms 提到 ≥ 3 倍推送间隔',
        )
      }
    } catch {
      // 观测失败不影响推送。
    }
  }

  private userSeam(): UserSeam {
    return this.ctx.get('user') as unknown as UserSeam
  }

  private bridgeSeam(): BridgeSeam {
    return this.ctx.get('accountPriority') as unknown as BridgeSeam
  }
}

function hashEntries(entries: readonly QuotaSnapshotEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 32)
}

/**
 * 判断 Go 侧 TTL 是否跟不上推送节奏（配置耦合护栏）。
 *
 * 心跳能刷新快照的前提是「两次推送之间的间隔明显小于 TTL」；经验值是 TTL ≥ 3 × 间隔，
 * 这里按 2 × 间隔做最低告警线（留一次网络抖动 / 事件循环延迟的余量）。
 */
export function heartbeatTooSlow(ttlMs: number, pollIntervalMs: number): boolean {
  if (ttlMs <= 0 || pollIntervalMs <= 0) return false
  return ttlMs < pollIntervalMs * 2
}

export type { QuotaConfig }
