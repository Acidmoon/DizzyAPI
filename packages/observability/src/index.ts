/**
 * 运维总览插件（@dizzyapi/plugin-observability）。
 *
 * 服务名是 `observability`：**纯只读聚合**，不落盘、不发事件、不挂 HTTP、不起定时器。
 *
 * 谁用它：
 * - `api` 的 `GET /api/admin/observability`（管理员鉴权）；
 * - `web` 的 `/admin/observability` 页面。
 *
 * 两者都运行期解析本服务（**不 inject**）：它不在运行时只让那条路由 503，
 * 入口与其它页面照常（D5）。
 */
import { ObservabilityService } from './service.ts'

declare module 'cordis' {
  interface Context {
    observability: ObservabilityService
  }
}

export { ObservabilityService }
export { ObservabilityError, isObservabilityError, type ObservabilityErrorCode } from './errors.ts'
export {
  OBSERVABILITY_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  OBSERVABILITY_CONFIG_SCHEMA as Config,
  OBSERVABILITY_DEFAULTS,
  validateObservabilityConfig,
  type ObservabilityConfig,
  type ResolvedObservabilityConfig,
} from './config.ts'
export { OBSERVABILITY_ACTOR } from './service.ts'
export type {
  AccountsView,
  AuditItemView,
  AuditView,
  BillingView,
  ObservabilityReport,
  ObservabilityServiceLike,
  QuotaView,
  RuntimeView,
  SourceHealth,
  SourceState,
  UsageChainView,
} from './types.ts'

export default ObservabilityService
