/** 闸门快照推送的稳定错误码。文案里绝不出现价格明细或 key id。 */
export type GateFeedErrorCode =
  | 'GATE_FEED_SNAPSHOT_INVALID'
  | 'GATE_FEED_PRICE_INVALID'
  | 'GATE_FEED_SPEND_INVALID'

export class GateFeedError extends Error {
  readonly code: GateFeedErrorCode

  constructor(code: GateFeedErrorCode, message: string) {
    super(message)
    this.name = 'GateFeedError'
    this.code = code
  }
}

export function isGateFeedError(value: unknown): value is GateFeedError {
  return value instanceof GateFeedError
}
