/**
 * 鉴权插件（@dizzyapi/plugin-auth）。
 *
 * 服务名是 `auth`，字段名是 `user` / `mailer`（`inject` 声明）。
 * 它服务的是**界面请求**：注册、登录、会话校验。
 * **LLM 请求的身份不经过这里**——那是 API key 的活，由 Go 的 key-auth 阶段解析（D20）。
 */
import { AuthService } from './service.ts'

declare module 'cordis' {
  interface Context {
    auth: AuthService
  }
}

/** 依赖：用户表 + 外部通讯模块。见 AuthService 上的 `static inject`。 */

export { AuthService }
export { AuthError, isAuthError, type AuthErrorCode } from './errors.ts'
export {
  AUTH_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  AUTH_CONFIG_SCHEMA as Config,
  validateAuthConfig,
  type AuthConfig,
  type ResolvedAuthConfig,
} from './config.ts'
export {
  emptySnapshot,
  snapshotCodec,
  SNAPSHOT_VERSION,
  createAuthStore,
} from './store.ts'
export type {
  AuthSnapshot,
  Credential,
  DeviceMeta,
  LoginResult,
  PendingCode,
  PendingPurpose,
  RateCounter,
  Session,
  SessionSummary,
  SessionView,
  Ticket,
} from './model.ts'

export default AuthService
