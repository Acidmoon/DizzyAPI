/**
 * 用量插件（@dizzyapi/plugin-usage）。
 *
 * 服务名是 `usage`：LLM 请求用量明细的唯一存储者与查询口。
 *
 * - 数据来源：Go 的 `usage.since` 控制桥方法（轮询），不是事件推送——断线可补拉。
 * - 一轮的顺序固定为「拉取 → 落库 → 结算 → 推进游标」：先落明细，再调 `billing.settle(records)`
 *   结算（reqId 幂等，只结算真正落库的记录），结算失败不推进游标，下一轮带同一 afterSeq 重放。
 * - 只存 token 事实；查询侧费用按 `pricing` 的价格表现算。
 * - 查询面分用户 / 管理员两种口径，权限判定在 HTTP 层（普通用户强制 userId=自己）。
 */
import { UsageService } from './service.ts'

declare module 'cordis' {
  interface Context {
    usage: UsageService
  }

  interface Events {
    /**
     * 一轮用量落库后，报告「这些上游账号刚被用过」。
     *
     * 集合化而不是每行一个事件：一轮轮询可能带几百条记录，逐条发事件会把监听方
     * （account-admin 的节流汇报）压垮。`at` 是这一轮落库的时间（ISO）。
     *
     * 写者边界：usage 不直接写 identity；account-admin 收到后节流，再经 identity 写回
     * `lastUsedAt`（AGENTS.md 2.4：一个数据一个写者）。
     */
    'usage/account-used'(payload: { readonly accountIds: readonly string[]; readonly at: string }): void
  }
}

export { UsageService }
export { UsageError, isUsageError, type UsageErrorCode } from './errors.ts'
export {
  USAGE_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  USAGE_CONFIG_SCHEMA as Config,
  USAGE_DEFAULTS,
  validateUsageConfig,
  type ResolvedUsageConfig,
  type UsageConfig,
} from './config.ts'
export { USAGE_SCHEMA, openUsageDatabase } from './db.ts'
export {
  USAGE_CSV_HEADER,
  usageCsv,
  usageCsvExport,
  usageCsvFilename,
  type UsageCsvExport,
} from './csv.ts'
export { clampLimit, queryWhere, PROBE_KEY_PREFIX } from './query.ts'
export { PIE_MAX_NAMED, PIE_MAX_SLICES, PIE_OTHER_LABEL, topWithOther, sumTotals } from './breakdown.ts'
export type { BreakdownTotals } from './breakdown.ts'
export type { UsagePollOutcome } from './service.ts'
export type {
  BillingPort,
  PricingPort,
  SettleBatchOutcomeLike,
  SettleCandidateLike,
  TokenCountsLike,
  UsageApiKeyBreakdown,
  UsageDailyPoint,
  UsageEntry,
  UsageListPage,
  UsageModelBreakdown,
  UsageQuery,
  UsageRow,
  UsageServiceLike,
  UsageStats,
  UsageStatus,
  UsageSummary,
  UsageTokenTotals,
  UsageTotals,
  UsageUserBreakdown,
} from './types.ts'

export default UsageService
