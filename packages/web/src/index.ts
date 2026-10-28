/**
 * 服务端渲染前端（@dizzyapi/plugin-web）。
 *
 * 替代原来的 SPA + manifest：每个页面一个文件（`pages/*.ts`），
 * 数据直接调进程内服务，写操作是表单 POST + 303。
 */
import { WebService } from './service.ts'

declare module 'cordis' {
  interface Context {
    web: WebService
  }
}

export { WebService }
export default WebService

export {
  WEB_DEFAULTS,
  validateWebConfig,
  type ResolvedWebConfig,
  type WebConfig,
} from './config.ts'

export type {
  AccountAdminLike,
  AccountView,
  ApiKeyLike,
  ApiKeyView,
  AuthLike,
  CatalogLike,
  CatalogPlugin,
  CatalogSnapshot,
  LoginResult,
  ModelPrice,
  PricingLike,
  SessionView,
  SettingsField,
  SettingsLike,
  SettingsNamespaceView,
  Ticket,
  UsageLike,
  UsageQuery,
  UsageRejectedPage,
  UsageRejectedQuery,
  UsageRejectedRow,
  UsageRow,
  UsageStats,
  UsageSummary,
  UserLike,
  UserView,
  WebRuntime,
} from './runtime.ts'

export { WEB_ACTOR } from './runtime.ts'
