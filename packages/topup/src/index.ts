/**
 * 充值订单插件（@dizzyapi/plugin-topup）。
 *
 * 服务名是 `topup`：充值订单的唯一写者。消费者用 `ctx.inject(['topup'], ...)` 拿到它；
 * 到账只经 `user.adjustBalance(...)`，支付通道只留 provider seam（本批只有人工确认）。
 *
 * 插件被禁用或卸载时，订单库连接与过期清扫定时器一起回收（AGENTS.md D5）。
 */
import { TopupService } from './service.ts'

declare module 'cordis' {
  interface Context {
    topup: TopupService
  }
}

export { TopupService }
export { TopupError, isTopupError, type TopupErrorCode } from './errors.ts'
export {
  TOPUP_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  TOPUP_CONFIG_SCHEMA as Config,
  TOPUP_DEFAULTS,
  validateTopupConfig,
  type ResolvedTopupConfig,
  type TopupConfig,
} from './config.ts'
export { MICROS_PER_YUAN, formatMicrosAsYuan, parseYuanToMicros } from './money.ts'
export {
  PAYMENT_PROVIDERS,
  findProvider,
  providerIds,
  type ChargeResult,
  type PaymentCallbackInput,
  type PaymentCallbackResult,
  type PaymentOrderRef,
  type PaymentProvider,
} from './providers.ts'
export {
  TOPUP_SCHEMA,
  TOPUP_SCHEMA_VERSION,
  TopupStore,
  isOrderStatus,
  openTopupDatabase,
} from './db.ts'
export {
  TOPUP_ACTOR,
  TOPUP_LIST_DEFAULT_LIMIT,
  TOPUP_LIST_MAX_LIMIT,
  TOPUP_NOTE_MAX_LENGTH,
  type ConfirmTopupResult,
  type CreateTopupOrderInput,
  type CreateTopupOrderResult,
  type TopupOptions,
  type TopupOrderPage,
  type TopupOrderQuery,
  type TopupOrderStatus,
  type TopupOrderView,
  type TopupServiceLike,
  type TopupStats,
} from './types.ts'

export default TopupService
