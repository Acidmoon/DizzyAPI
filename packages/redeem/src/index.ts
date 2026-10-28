/**
 * 兑换码插件（@dizzyapi/plugin-redeem）。
 *
 * 服务名是 `redeem`：消费者用 `ctx.inject(['redeem'], (ctx) => { ... })` 拿到它。
 * 它是批次表与兑换码表的唯一写者；加余额只经 `user.adjustBalance(...)`。
 * 插件被禁用或卸载时，服务与数据库连接一起回收（AGENTS.md D5）。
 */
import { RedeemService } from './service.ts'
import type { RedeemChangedEvent } from './types.ts'

declare module 'cordis' {
  interface Context {
    redeem: RedeemService
  }

  interface Events {
    /** 批次 / 兑换码变化或兑换成功；载荷不含明文、哈希与掩码。 */
    'redeem/changed'(event: RedeemChangedEvent): void
  }
}

export { RedeemService }
export { RedeemError, isRedeemError, type RedeemErrorCode } from './errors.ts'
export {
  REDEEM_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  REDEEM_CONFIG_SCHEMA as Config,
  validateRedeemConfig,
  type RedeemConfig,
  type ResolvedRedeemConfig,
} from './config.ts'
export {
  codeDigest,
  codeMask,
  formatCodeForDisplay,
  generateCode,
  normalizeCode,
} from './code.ts'
export {
  REDEEM_ACTOR,
  REDEEM_AMOUNT_MAX_MICROS,
  REDEEM_BATCH_COUNT_MAX,
  REDEEM_BATCH_COUNT_MIN,
  REDEEM_BATCH_NAME_MAX_LENGTH,
  REDEEM_BATCH_NOTES_MAX_LENGTH,
  REDEEM_CODE_ALPHABET,
  REDEEM_CODE_GROUP,
  REDEEM_CODE_LENGTH,
  REDEEM_DELETE_MAX_BATCH,
  REDEEM_LIST_DEFAULT_LIMIT,
  REDEEM_LIST_MAX_LIMIT,
  REDEEM_MY_LIST_DEFAULT_LIMIT,
  REDEEM_MY_LIST_MAX_LIMIT,
  type RedeemBatchQuery,
  type RedeemBatchView,
  type RedeemChangedEvent,
  type RedeemCodeFilter,
  type RedeemCodePage,
  type RedeemCodeQuery,
  type RedeemCodeStatus,
  type RedeemCodeView,
  type RedeemDeletionRejection,
  type RedeemDeletionResult,
  type RedeemKind,
  type RedeemResolveOutcome,
  type RedeemResult,
  type RedeemStats,
  type RedemptionView,
} from './types.ts'
export {
  type CreateBatchInput,
  type CreateBatchResult,
  type RedeemInput,
} from './service.ts'

export default RedeemService
