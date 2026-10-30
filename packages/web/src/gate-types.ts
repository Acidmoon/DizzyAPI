/**
 * 定价闸门的**只读状态面**（从 `runtime.ts` 拆出来，与 `usage-types.ts` 同一套做法）。
 *
 * 为什么需要它：owner 第 10 条要「未定价的模型不可请求」，实现是 Go 的 `-pricing-gate`
 * （默认**关**）。价格页原来写死一句「闸门默认关，现在仍可请求」——运维打开闸门那天
 * 这句话就变成假话，而这一页正是「未定价到底会不会被拒」的唯一解释处。
 *
 * 结构面只声明用到的方法，**不 import 别的插件的实现类**（AGENTS.md §2.2）；
 * 服务名是 `gateFeed`（`packages/gate-feed`），运行期解析，缺席即页面降级。
 */

/** Go 侧一份快照的健康度（`pricing.status` 的最小子集）。 */
export interface GateSnapshotView {
  readonly ready: boolean
  readonly stale: boolean
  readonly ageMs: number
  readonly ttlMs: number
}

/** 价格页要的那几个事实；`null` 一律表示「读不到」，不冒充 `false`。 */
export interface GateFeedStatusView {
  /** 推送插件自己开着没有（`enabled=false` 时它什么都不推）。 */
  readonly enabled: boolean
  /** Go 侧价格快照健康度；读不到为 null。 */
  readonly goPricing: GateSnapshotView | null
  /** 定价闸门阶段装没装（= `-pricing-gate` 开没开）；读不到为 null。 */
  readonly pricingGateEnabled: boolean | null
  /** 最近一次推送失败的原因（成功时为 null）。 */
  readonly lastError: string | null
  readonly failureStreak: number
}

export interface GateFeedLike {
  status(): GateFeedStatusView
}
