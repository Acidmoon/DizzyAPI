/**
 * 模型价格表插件（@dizzyapi/plugin-pricing）。
 *
 * 服务名是 `pricing`：管理员维护「每百万 token 的单价」，用量插件在读取时据此把
 * token 用量换算成费用。它不参与 LLM 请求链路，也不碰余额（D1 / §2.1）。
 *
 * 金额一律是十进制字符串（元），内部换成 BigInt 微元；1 元 = 1_000_000 微元，
 * 与余额的最小单位同量纲。
 */
import { PricingService } from './service.ts'

declare module 'cordis' {
  interface Context {
    pricing: PricingService
  }

  interface Events {
    /** 价格表被写入或删除；`action` 是 upsert / remove。 */
    'pricing/changed'(model: string, action: 'upsert' | 'remove'): void
  }
}

export { PricingService }
export { PricingError, isPricingError, type PricingErrorCode } from './errors.ts'
export {
  PRICING_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  PRICING_CONFIG_SCHEMA as Config,
  PRICING_DEFAULTS,
  validatePricingConfig,
  type PricingConfig,
  type ResolvedPricingConfig,
} from './config.ts'
export {
  MICROS_PER_YUAN,
  TOKENS_PER_PRICE_UNIT,
  formatMicrosAsYuan,
  normalizeYuan,
  parseYuanToMicros,
  priceMicrosOf,
  priceOfModel,
  quoteMicrosOf,
  quoteMicrosOfPrice,
  type PriceMicros,
} from './money.ts'
export type {
  ModelPrice,
  ModelPriceInput,
  PriceCurrency,
  PricingServiceLike,
  PricingSnapshot,
  TokenCounts,
} from './types.ts'

export default PricingService
