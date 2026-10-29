/**
 * 闸门快照推送插件的**类型面**：快照载荷、可观察状态与外部服务的结构面。
 *
 * 这个文件只放类型，不放实现：
 * - 快照怎么算 → `snapshot.ts`
 * - 推送怎么跑 → `service.ts`
 *
 * 结构面（Seam）只声明用到的方法，**不 import 别的插件的实现类**（AGENTS.md §2.2）。
 */

/** 价格服务的一条价格记录（`pricing` 的只读投影）。 */
export interface PricingPrice {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
}

/** 价格服务的结构面：只声明用到的方法，不 import 实现类。 */
export interface PricingSeam {
  list(): readonly PricingPrice[]
}

/** api-key 服务的结构面：只要 key 的 id 与金额上限（不要秘密）。 */
export interface ApiKeySeam {
  listAll(): Promise<readonly { readonly id: string; readonly spendingLimitMicros: string | null }[]>
}

/**
 * 用量服务的结构面：按 key 汇总费用（读取时按当前价格表算）。
 *
 * `status` 是**本地**服务调用（不过桥），只用来拿「用量游标」：游标没变就说明
 * 没有新记录，消费总额也不必重算。这是 gate-feed 的成本护栏——
 * `summary()` 每次都是全历史聚合（N 个 key × 2 次扫描），在 40 万行量级上实测
 * 906ms / 轮；心跳必须 5s 一轮（Go 按 TTL 判新鲜度），不能每轮都这么算。
 */
export interface UsageSeam {
  summary(query: {
    readonly fromMs: number
    readonly toMs: number
    readonly apiKeyId?: string
  }): { readonly totals: { readonly costMicros: string } }
  status?(): { readonly epoch: string | null; readonly lastSeq: number }
}

/** Go 侧一份快照的健康度（pricing.status / keyspend.status 的最小子集）。 */
export interface GoSnapshotState {
  readonly ready: boolean
  readonly stale: boolean
  readonly ageMs: number
  readonly ttlMs: number
}

/** 控制桥的持有者（account-priority）暴露给本插件的那一小块。 */
export interface BridgeSeam {
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
  /**
   * Go 侧两份快照的健康度。**闸门开着但快照 stale 就是全站 503**，
   * 所以这两个字段必须在管理面能看到，不能只留在日志里。
   */
  readonly goPricing: GoSnapshotState | null
  readonly goSpend: GoSnapshotState | null
  /** 消费快照的重算 / 复用次数（心跳成本护栏的观察口）。 */
  readonly spendRecomputes: number
  readonly spendReuses: number
}
