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
}

/** 写价格的入参（`PUT /api/pricing/:model`，管理员）。单价接受字符串或数字。 */
export interface ModelPriceInputView {
  readonly inputPerMillion: string | number
  readonly outputPerMillion: string | number
  readonly cacheReadPerMillion?: string | number
  readonly cacheWritePerMillion?: string | number
}
