/**
 * 兑换码插件的稳定错误码。
 *
 * 调用方按 code 分支；message 只给人看，**永远不含明文码、哈希或掩码以外的信息**。
 * 码相关的拒绝一律不回显用户输入的码本身（否则错误信息会变成枚举侧信道）。
 *
 * 命名与 HTTP 状态码的关系见 packages/api/src/errors.ts 的 `statusOfCode`：
 * 带 `_INVALID` / `_FORBIDDEN` / `_NOT_FOUND` / `_CONFLICT` 后缀的走后缀兜底规则，
 * 其余（USED / DISABLED / EXPIRED / REDEEMING / BALANCE_FAILED）在显式表里登记。
 */
export type RedeemErrorCode =
  | 'REDEEM_INVALID_INPUT'
  | 'REDEEM_ACTOR_FORBIDDEN'
  | 'REDEEM_NOT_FOUND'
  | 'REDEEM_CODE_INVALID'
  | 'REDEEM_CODE_NOT_FOUND'
  | 'REDEEM_CODE_DISABLED'
  | 'REDEEM_CODE_EXPIRED'
  | 'REDEEM_CODE_USED'
  | 'REDEEM_CODE_REDEEMING'
  | 'REDEEM_CODE_CONFLICT'
  | 'REDEEM_CODE_BALANCE_FAILED'
  | 'REDEEM_USER_FORBIDDEN'
  | 'REDEEM_STORE_CORRUPT'

export class RedeemError extends Error {
  readonly code: RedeemErrorCode

  constructor(code: RedeemErrorCode, message: string) {
    super(message)
    this.name = 'RedeemError'
    this.code = code
  }
}

export function isRedeemError(value: unknown): value is RedeemError {
  return value instanceof RedeemError
}
