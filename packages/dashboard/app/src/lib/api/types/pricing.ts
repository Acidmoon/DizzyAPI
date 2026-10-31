/**
 * 模型价格与模型广场。
 *
 * 服务端来源：
 * - `routes/pricing.ts` 的 `viewOf()`（含 `model`，`currency` 恒为 `'CNY'`）→ `ModelPriceView`；
 * - `views/catalog.ts` 的 `modelPriceViewOf()`（**不含 `model`**，是嵌在模型目录里的那个）、
 *   `modelEntryOf()`、`modelCatalogOf()` → 模型广场。
 *
 * 单价口径：**每百万 token 的元数**，十进制字符串（`inputPerMillion` 等），
 * 前端只格式化、不参与运算。
 */

/** 一个模型的价格（`GET /api/pricing` 的条目；`viewOf()`）。 */
export interface ModelPriceView {
  readonly model: string
  /** 每百万 token 输入的价格（元，十进制字符串）。 */
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: 'CNY'
  readonly updatedAt: string
}

/** 嵌在模型目录里的价格（`modelPriceViewOf()`）：**没有 `model` 字段**，模型名在外层。 */
export type NestedModelPriceView = Omit<ModelPriceView, 'model'>

/** `GET /api/pricing` 的响应。 */
export interface PricingListView {
  readonly items: readonly ModelPriceView[]
}

// ───────────────────────────────── 主动探测（增量字段） ─────────────────────────────────

/**
 * 一次探测的结论（服务端四态，`packages/model-probe` 分类）。
 *
 * `probe-error` 是**探测自己**没测出来（余额不足 / key 失效 / 连不上网关），
 * **不是模型挂了** —— 页面必须把它和 `failed` 分开画，否则就是「假红」。
 */
export type ModelProbePointStatus = 'ok' | 'degraded' | 'failed' | 'probe-error'

/** 一个模型的探测健康度：判定归 `modelhub`（阈值是它的配置），前端只展示。 */
export type ModelProbeHealth = 'up' | 'degraded' | 'down' | 'unknown'

/** 小柱状图的一个点。**只有稳定原因码，没有上游响应正文。** */
export interface ModelProbePointView {
  readonly status: ModelProbePointStatus
  readonly latencyMs: number
  readonly httpStatus: number | null
  readonly errorCode: string | null
  readonly testedAtMs: number
}

/**
 * 一个模型的探测视图。**没有探测数据时整个 `probe` 键不出现**（不是 `null`）：
 * 没接探测服务时 `/api/models` 的响应与改造前逐字一致。
 */
export interface ModelProbeView {
  /** 有没有探测历史。`false` = 从没探过（不是「挂了」）。 */
  readonly probed: boolean
  readonly health: ModelProbeHealth
  /** 连续 `failed` 条数（`probe-error` 不计入）。 */
  readonly consecutiveFailures: number
  readonly lastOkAtMs: number | null
  readonly lastTestedAtMs: number | null
  /** 最近若干个点，**最新在前**。 */
  readonly points: readonly ModelProbePointView[]
}

/**
 * 探测的总体状态。`blockedReason` 非空 = 探测停摆，**页面必须显示**：
 * 停摆时所有模型都没有新数据，但模型可能一个都没挂。
 */
export interface ModelProbeSummaryView {
  readonly enabled: boolean
  readonly running: boolean
  /** 停摆原因码；`null` = 正常。未知码原样显示，不猜。 */
  readonly blockedReason: string | null
  readonly blockedDetail: string | null
  readonly lastPassAt: string | null
  /** `modelhub` 判 `down` 用的连续失败阈值。 */
  readonly failureThreshold: number
  readonly downCount: number
}

/** 模型广场里一个可用模型（`modelEntryOf()`）。 */
export interface ModelEntryView {
  readonly model: string
  readonly priced: boolean
  readonly price: NestedModelPriceView | null
  readonly accountCount: number
  readonly healthyAccountCount: number
  readonly protocols: readonly string[]
  readonly upstreamModels: readonly string[]
  readonly mapped: boolean
  /** **增量字段**：主动探测的结果。没有数据时这个键不出现。 */
  readonly probe?: ModelProbeView
}

/** 模型广场里一个不可用模型（带原因与人话细节）。 */
export interface ModelUnavailableView {
  readonly model: string
  /** 稳定英文原因码。 */
  readonly reason: string
  /** 给用户看的人话解释。 */
  readonly detail: string
  readonly accountCount: number
  readonly priced: boolean
  readonly price: NestedModelPriceView | null
  /** **增量字段**：探测历史（排障有用：账号在但不健康，上游真的通吗）。 */
  readonly probe?: ModelProbeView
}

/**
 * 模型广场的汇总。
 *
 * 注意键名：服务端是 `availableCount` / `unavailableCount` / `pricedCount`
 * （**带 Count 后缀**），不是 `available` / `unavailable`。
 */
export interface ModelCatalogSummaryView {
  readonly total: number
  readonly availableCount: number
  readonly unavailableCount: number
  readonly pricedCount: number
  readonly accountCount: number
}

/** `GET /api/models` 的响应（`modelCatalogOf()`）。 */
export interface ModelCatalogView {
  readonly available: readonly ModelEntryView[]
  readonly unavailable: readonly ModelUnavailableView[]
  readonly summary: ModelCatalogSummaryView
  /**
   * **增量字段**：探测总体状态。`modelhub` 没接探测插件时这个键不出现
   * （响应与改造前逐字一致，老用例逐字钉着）。
   */
  readonly probe?: ModelProbeSummaryView
}

/** 写价格的入参（`PUT /api/pricing/:model`，管理员）。单价接受字符串或数字。 */
export interface ModelPriceInputView {
  readonly inputPerMillion: string | number
  readonly outputPerMillion: string | number
  readonly cacheReadPerMillion?: string | number
  readonly cacheWritePerMillion?: string | number
}
