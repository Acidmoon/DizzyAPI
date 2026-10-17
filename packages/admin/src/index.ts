/**
 * 开发者控制面板（@dizzyapi/plugin-admin）。
 *
 * 服务名是 `admin`。它是**控制面**插件（AGENTS.md §2.1、§4）：
 * 不进 LLM 请求链路、不进描述符，只受 `app.yml` 的启用 / 禁用控制。
 * 面板被禁用或卸载时，HTTP 监听、SSE 连接、采样定时器随 effect 一起回收（D5）。
 *
 * 三件事：看（插件 / 服务 / 静态依赖图 / 运行期概览）、改（设置项）、收（退出进程）。
 */
import { AdminService } from './service.ts'

declare module 'cordis' {
  interface Context {
    admin: AdminService
  }
}

export {
  AdminService,
  ADMIN_ACTOR,
  type AdminOverview,
  type AdminRestartResult,
} from './service.ts'
export { PanelServer, type PanelHandlers, type PanelOptions } from './http.ts'
export { AdminError, isAdminError, statusOfSettingsCode, type AdminErrorCode } from './errors.ts'
export {
  collectGraph,
  collectMethods,
  pluginCounts,
  type AdminConsumer,
  type AdminGraph,
  type AdminInjectEdge,
  type AdminPluginNode,
  type AdminPluginState,
  type AdminServiceNode,
  type CollectOptions,
} from './introspect.ts'
export {
  ADMIN_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  ADMIN_CONFIG_SCHEMA as Config,
  ADMIN_DEFAULTS,
  validateAdminConfig,
  type AdminConfig,
  type ResolvedAdminConfig,
} from './config.ts'

export default AdminService
