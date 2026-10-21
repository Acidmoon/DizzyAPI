/**
 * 价格表的对外形状。
 *
 * 金额一律用**十进制字符串**表示「元 / 百万 token」，绝不出现浮点数：
 * `"3.75"` 是精确的 3 元 7 角 5 分，换算成整数微元后参与计算（AGENTS.md §2.4.3）。
 *
 * 微元与余额的最小单位同量纲：1 元 = 1_000_000 微元。
 */

export type PriceCurrency = 'CNY'

/** 一个模型的单价。空串/缺省表示该项不计费。 */
export interface ModelPrice {
  readonly model: string
  /** 输入（不含缓存命中）每百万 token 的价格，元。 */
  readonly inputPerMillion: string
  /** 输出每百万 token 的价格，元。 */
  readonly outputPerMillion: string
  /** 缓存读取每百万 token 的价格，元。 */
  readonly cacheReadPerMillion: string
  /** 缓存创建每百万 token 的价格，元。 */
  readonly cacheWritePerMillion: string
  readonly currency: PriceCurrency
  readonly updatedAt: string
}

/** 写入价格时的输入；数字也接受，但会按十进制字符串规范化。 */
export interface ModelPriceInput {
  readonly inputPerMillion: string | number
  readonly outputPerMillion: string | number
  readonly cacheReadPerMillion?: string | number
  readonly cacheWritePerMillion?: string | number
}

/** 一次请求的四个 token 桶（互不重叠；input 不含缓存）。 */
export interface TokenCounts {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * 价格表快照：`model → 单价`。`'*'` 是兜底条目。
 *
 * 读取方（用量插件）在**一次查询开始时**取一份快照，然后在内存里算完所有费用；
 * 不要每行都回查服务，也不要跨查询缓存（价格改了要立刻生效）。
 */
export type PricingSnapshot = ReadonlyMap<string, ModelPrice>

/** 价格表服务的结构面：别的插件只依赖这些方法，不 import 实现类。 */
export interface PricingServiceLike {
  list(): readonly ModelPrice[]
  get(model: string): ModelPrice | null
  set(actor: string, model: string, input: ModelPriceInput): Promise<ModelPrice>
  remove(actor: string, model: string): Promise<boolean>
  snapshot(): PricingSnapshot
  /** 按当前价格表算一次请求的应扣费用，返回整数微元（十进制字符串，避免 JSON 大整数）。 */
  quote(model: string, tokens: TokenCounts): string
}
