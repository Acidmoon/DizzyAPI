/**
 * 用量插件（@dizzyapi/plugin-usage）。
 *
 * 服务名是 `usage`：LLM 请求用量明细的唯一存储者与查询口。
 *
 * - 数据来源：Go 的 `usage.since` 控制桥方法（轮询），不是事件推送——断线可补拉。
 * - 只存 token 事实；费用在读取时按 `pricing` 服务的价格表计算。
 * - 查询面分用户 / 管理员两种口径，权限判定在 HTTP 层（普通用户强制 userId=自己）。
 */
import { UsageService } from './service.ts'

declare module 'cordis' {
  interface Context {
    usage: UsageService
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
export type {
  PricingPort,
  TokenCountsLike,
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
