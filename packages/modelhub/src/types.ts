/**
 * 模型广场（服务名 `modelhub`）的对外形状。
 *
 * 它是**纯聚合**：不落盘、不写任何数据，只把三份只读事实拼成一份「我们卖什么」：
 * - `pricing` 的价格表（有价的模型）；
 * - 账号快照里每个账号声明的 `models` / `modelMap`（谁提供这个对外模型名）；
 * - 账号的协议 / 健康度 / 凭据状态（这个模型现在能不能用）。
 *
 * 金额口径：价格是「元 / 百万 token」，**十进制字符串**，与 `pricing` 一致；
 * 页面把它换算成整数微元再显示，全程不经浮点（AGENTS.md §2.4.3）。
 */

/** 一个对外模型在广场里的完整视图。 */
export interface ModelEntry {
  /** 对外模型名（客户端在请求里用的那个）。 */
  readonly model: string
  /** 是否有精确价格。`false` = 价目表里没有这一条（也没有 `'*'` 兜底）。 */
  readonly priced: boolean
  /**
   * 四档单价（元 / 百万 token，十进制字符串）。
   * `null` = 该模型没有价格；此时四个字段都为 `null`。
   */
  readonly price: ModelPriceView | null
  /** 提供这个模型的账号数（含停用 / 不健康的）。 */
  readonly accountCount: number
  /** **当前健康可用**的账号数（启用 + active + 有凭据 + 未过期 + 健康非 unhealthy）。 */
  readonly healthyAccountCount: number
  /** 这个模型覆盖的上游协议（去重、排序）。空数组 = 没有账号声明过协议。 */
  readonly protocols: readonly string[]
  /**
   * 这个模型被映射到哪些上游模型名（`modelMap` 的值，去重、排序）。
   * 空数组 = 没有账号对它做模型名改写。
   */
  readonly upstreamModels: readonly string[]
  /** 是否被映射：只要有任一账号对它做了 `modelMap` 就是 true。 */
  readonly mapped: boolean
  /**
   * **主动探测**的结果（增量字段）。**没有探测数据时不出现这个键**（不是 `null`）。
   *
   * 与上面的账号事实是**两条独立证据**：账号「声明了且健康」不代表上游真的能推理，
   * 探测才是端到端的那一条。
   *
   * 为什么用可选键而不是 `null`：`/api/models` 的既有形状一个字节都不该变 ——
   * 没接探测服务时响应必须与改造前逐字一致（有用例逐字钉着）。
   */
  readonly probe?: ModelProbeView
}

// ───────────────────────────────── 探测（增量） ─────────────────────────────────

/** 探测健康度：`up` 正常、`degraded` 抖动/偏慢、`down` 连续失败到阈值、`unknown` 无法断言。 */
export type ModelProbeHealth = 'up' | 'degraded' | 'down' | 'unknown'

/** 一个小柱状图的点。**只有稳定原因码，没有上游响应正文。** */
export interface ModelProbePointView {
  readonly status: 'ok' | 'degraded' | 'failed' | 'probe-error'
  readonly latencyMs: number
  readonly httpStatus: number | null
  readonly errorCode: string | null
  readonly testedAtMs: number
}

/** 一个模型的探测视图（最新在前，够前端画小柱状图）。 */
export interface ModelProbeView {
  /** 有没有探测历史。`false` = 这个模型从没被探过（不是「挂了」）。 */
  readonly probed: boolean
  readonly health: ModelProbeHealth
  /** 连续 `failed` 的条数（探测插件给的纯事实；`probe-error` 不计入）。 */
  readonly consecutiveFailures: number
  /** 最近一次成功的时刻（`ok` / `degraded`）；`null` = 从没成功过。 */
  readonly lastOkAtMs: number | null
  /** 最近一次探测的时刻；`null` = 从没探过。 */
  readonly lastTestedAtMs: number | null
  /** 最近若干个点，最新在前。 */
  readonly points: readonly ModelProbePointView[]
}

/** 探测的总体状态（给页面显示「探测停摆」用）。 */
export interface ModelProbeSummaryView {
  readonly enabled: boolean
  readonly running: boolean
  /**
   * 探测停摆的原因码；`null` = 正常。
   * 典型值：`probe_user_balance_exhausted`（余额不足）、`probe_key_rejected`、
   * `gateway_unreachable`。**页面必须显示它并说明「这不是模型故障」。**
   */
  readonly blockedReason: string | null
  readonly blockedDetail: string | null
  readonly lastPassAt: string | null
  /** 判 `down` 用的连续失败阈值（本插件的配置）。 */
  readonly failureThreshold: number
  /** 被探测判为 `down` 的模型数。 */
  readonly downCount: number
}

/** 四档单价（元 / 百万 token）。 */
export interface ModelPriceView {
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: string
  readonly updatedAt: string
}

/** 不可用原因（稳定英文串，用户面显示中文）。 */
export type ModelUnavailableReason =
  /** 没有账号声明这个模型。 */
  | 'no_account'
  /** 有账号声明，但当前没有一个是健康可用的。 */
  | 'no_healthy_account'

/** 不可用模型的条目：带明确原因，不静默不列。 */
export interface ModelUnavailableEntry {
  readonly model: string
  readonly reason: ModelUnavailableReason
  /** 原因的人话说明（中文）。 */
  readonly detail: string
  /** 提供这个模型的账号数（含不可用的）。 */
  readonly accountCount: number
  readonly price: ModelPriceView | null
  readonly priced: boolean
  /** **主动探测**的结果（增量字段，没有数据就不出现）。不可用的模型也可能有探测历史，便于排障。 */
  readonly probe?: ModelProbeView
}

/** 一次查询的结果。 */
export interface ModelCatalog {
  /** 当前可用（至少一个健康账号提供）的模型。 */
  readonly available: readonly ModelEntry[]
  /** 有名字但当前不可用的模型，带原因。 */
  readonly unavailable: readonly ModelUnavailableEntry[]
  /** 统计口径，供页面显示。 */
  readonly summary: ModelCatalogSummary
  /**
   * 探测的总体状态（增量字段）。
   *
   * **页面必须显示 `blockedReason`**：探测停摆（探测用户余额不足 / key 失效 / 连不上网关）
   * 会让所有模型都没有新数据，但模型可能一个都没挂。不显示它 = 让人以为数据是新鲜的。
   */
  readonly probe: ModelProbeSummaryView
}

export interface ModelCatalogSummary {
  /** 目录里的模型总数（可用 + 不可用）。 */
  readonly total: number
  readonly availableCount: number
  readonly unavailableCount: number
  /** 配了精确价格的模型数。 */
  readonly pricedCount: number
  /** 参与统计的账号数。 */
  readonly accountCount: number
}

/** 查询过滤条件（全部可选）。 */
export interface ModelCatalogQuery {
  /** 按名字过滤（不区分大小写，子串匹配）。 */
  readonly search?: string
  /** 只要可用 / 只要不可用 / 都要。 */
  readonly availability?: 'all' | 'available' | 'unavailable'
  /** 只要有精确价的 / 不要没价的。 */
  readonly priced?: 'all' | 'priced' | 'unpriced'
}

/** 服务结构面：别的插件只依赖这些方法，不 import 实现类。 */
export interface ModelHubServiceLike {
  catalog(query?: ModelCatalogQuery): ModelCatalog
}
