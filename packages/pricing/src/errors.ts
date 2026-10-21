/** 价格表的稳定错误码；HTTP 层只做状态码映射，不复用内部消息。 */
export type PricingErrorCode =
  | 'PRICING_CONFIG_INVALID'
  | 'PRICING_FORBIDDEN'
  | 'PRICING_MODEL_INVALID'
  | 'PRICING_PRICE_INVALID'
  | 'PRICING_NOT_FOUND'
  | 'PRICING_STORE_FAILED'

export class PricingError extends Error {
  readonly code: PricingErrorCode

  constructor(code: PricingErrorCode, message: string) {
    super(message)
    this.name = 'PricingError'
    this.code = code
  }
}

export function isPricingError(error: unknown): error is PricingError {
  return error instanceof PricingError
}
