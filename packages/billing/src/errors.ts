/**
 * 结算插件的稳定错误码。
 *
 * 调用方（usage 的结算钩子、api / web 的管理读接口）按 code 分支；message 只给人看，
 * 不含 token 明细之外的用户数据，也绝不回显余额数值以外的内部状态。
 *
 * 与 HTTP 状态码的关系见 packages/api/src/errors.ts 的 `statusOfCode`：
 * `_INVALID` → 400、`_FORBIDDEN` → 403、`_NOT_READY` / `_UNAVAILABLE` → 503，
 * 其余（STORE_* / SETTLE_FAILED / PRICE_INVALID）落到 500——结算是内部链路，
 * 坏账与价格错误不能伪装成用户输入问题。
 */
export type BillingErrorCode =
  | 'BILLING_CONFIG_INVALID'
  | 'BILLING_INPUT_INVALID'
  | 'BILLING_ACTOR_FORBIDDEN'
  | 'BILLING_NOT_READY'
  | 'BILLING_STORE_CORRUPT'
  | 'BILLING_STORE_FAILED'
  | 'BILLING_PRICE_INVALID'
  | 'BILLING_SETTLE_FAILED'

export class BillingError extends Error {
  readonly code: BillingErrorCode

  constructor(code: BillingErrorCode, message: string) {
    super(message)
    this.name = 'BillingError'
    this.code = code
  }
}

export function isBillingError(value: unknown): value is BillingError {
  return value instanceof BillingError
}
