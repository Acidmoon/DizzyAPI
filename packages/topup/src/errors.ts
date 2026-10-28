/**
 * 充值订单插件的稳定错误码。
 *
 * 调用方（api / web / 测试）按 code 分支；message 只给人看。
 * 与 HTTP 状态码的关系见 packages/api/src/errors.ts 的 `statusOfCode`：
 * `_INVALID` / `_UNKNOWN` → 400，`_FORBIDDEN` → 403，`_NOT_FOUND` → 404，
 * `_STATE` → 409，`_BALANCE_FAILED` / `_PROVIDER_FAILED` / `_NOT_READY` → 5xx。
 */
export type TopupErrorCode =
  | 'TOPUP_CONFIG_INVALID'
  | 'TOPUP_INPUT_INVALID'
  | 'TOPUP_AMOUNT_INVALID'
  | 'TOPUP_AMOUNT_OUT_OF_RANGE'
  | 'TOPUP_PROVIDER_UNKNOWN'
  | 'TOPUP_PROVIDER_FAILED'
  | 'TOPUP_ACTOR_FORBIDDEN'
  | 'TOPUP_ORDER_NOT_FOUND'
  | 'TOPUP_ORDER_STATE'
  | 'TOPUP_BALANCE_FAILED'
  | 'TOPUP_NOT_READY'
  | 'TOPUP_STORE_CORRUPT'
  | 'TOPUP_STORE_FAILED'

export class TopupError extends Error {
  readonly code: TopupErrorCode

  constructor(code: TopupErrorCode, message: string) {
    super(message)
    this.name = 'TopupError'
    this.code = code
  }
}

export function isTopupError(value: unknown): value is TopupError {
  return value instanceof TopupError
}
