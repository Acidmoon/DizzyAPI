/**
 * 结算插件（@dizzyapi/plugin-billing）。
 *
 * 服务名是 `billing`：真实扣费的唯一执行者。消费者用 `ctx.inject(['billing'], ...)`
 * 拿到它；`usage` 不 inject 本插件（D5：禁用本插件只关掉结算，不影响用量落库），
 * 它在轮询里按需解析、缺席即不结算。
 *
 * 钱只经 `user.adjustBalance(...)` 变动，价格只经 `pricing` 读取；本插件是
 * `data/billing.db` 的唯一写者。
 */
import { BillingService } from './service.ts'

declare module 'cordis' {
  interface Context {
    billing: BillingService
  }
}

export { BillingService }
export { BillingError, isBillingError, type BillingErrorCode } from './errors.ts'
export {
  BILLING_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  BILLING_CONFIG_SCHEMA as Config,
  BILLING_DEFAULTS,
  validateBillingConfig,
  type BillingConfig,
  type ResolvedBillingConfig,
} from './config.ts'
export {
  BILLING_SCHEMA,
  BILLING_SCHEMA_VERSION,
  BillingStore,
  isSettleStatus,
  openBillingDatabase,
} from './db.ts'
export {
  BILLING_ACTOR,
  SETTLE_LIST_DEFAULT_LIMIT,
  SETTLE_LIST_MAX_LIMIT,
  type BillingServiceLike,
  type SettleBatchResult,
  type SettleCandidate,
  type SettleDailyPoint,
  type SettleFilter,
  type SettleModelPoint,
  type SettlePage,
  type SettleQuery,
  type SettleRecordView,
  type SettleStatus,
  type SettleSummary,
  type SettleTotals,
} from './types.ts'

export default BillingService
