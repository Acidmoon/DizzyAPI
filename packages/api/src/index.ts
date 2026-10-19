/**
 * 产品 HTTP 入口（`@dizzyapi/plugin-api`）。
 *
 * 服务名是 `api`。它只受 `app.yml` 的启用 / 禁用控制（D5）：
 * 禁用时监听器、路由与静态字节一起消失，但前端宿主自己的文件仍在磁盘上。
 *
 * 浏览器入口是 `http://127.0.0.1:7791/console`；`/` 303 到 `/console/usage`。
 * 静态资源从 frontend 服务读盘，`/api/*` 在进程内调用控制面服务，不走控制桥。
 */
import { ApiService } from './service.ts'

declare module 'cordis' {
  interface Context {
    api: ApiService
  }
}

export { ApiService }
export {
  API_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  API_CONFIG_SCHEMA as Config,
  API_DEFAULTS,
  BALANCE_MINOR_UNITS_PER_CENT,
  validateApiConfig,
  type ApiConfig,
  type ResolvedApiConfig,
} from './config.ts'
export { ApiError, isApiError, statusOfCode, toApiError, type ApiErrorCode } from './errors.ts'
export {
  API_ACTOR,
  API_REQUEST_HEADER,
  API_VERSION,
  ApiServer,
} from './http.ts'
export type {
  AccountAdminPort,
  AccountPriorityPort,
  AccountViewLike,
  AdminUserView,
  ApiKeyPort,
  ApiKeySummaryView,
  ApiRuntime,
  AuthPort,
  CatalogModuleView,
  CatalogPort,
  FrontendPageLike,
  FrontendPort,
  GatewayComponentHealth,
  GatewayHealthState,
  GatewayHealthView,
  LoginResultLike,
  SessionInfoView,
  SessionRole,
  SessionUserView,
  SessionViewLike,
  SettingsPort,
  TicketLike,
  UserLike,
  UserPort,
  UserStatusLike,
} from './types.ts'

export default ApiService
