/**
 * 账号保管插件（@dizzyapi/plugin-identity）。
 *
 * 服务名是 `identity`：上游账号的唯一写者，也是**唯一**用 refresh_token 换新令牌的地方
 * （AGENTS.md D17 / D18）。它不转发任何模型请求，不进描述符，只受 app.yml 的启用/禁用控制。
 *
 * 秘密边界：账号记录里没有令牌；令牌在 credentials 插件的引用下。面板/日志/桥消息
 * 只能看到 `get` / `list` 返回的账号元数据。
 */
import { IdentityService } from './service.ts'

declare module 'cordis' {
  interface Context {
    identity: IdentityService
  }

  interface Events {
    /** 账号记录或凭据发生写入。`reason`：created / updated / credentials / removed。 */
    'identity/account-updated'(id: string, reason: string): void
    /** 一次成功的 RT 交换，令牌已经落盘。 */
    'identity/account-refreshed'(id: string): void
    /** 一次失败的刷新尝试；`code` 是 IdentityErrorCode 或 PROVIDER_ERROR。 */
    'identity/account-failed'(id: string, code: string): void
  }
}

export { IdentityService }
export { IdentityError, isIdentityError, type IdentityErrorCode } from './errors.ts'
export {
  IDENTITY_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  IDENTITY_CONFIG_SCHEMA as Config,
  IDENTITY_DEFAULTS,
  validateIdentityConfig,
  type IdentityConfig,
  type ResolvedIdentityConfig,
} from './config.ts'
export {
  createIdentityStore,
  identityCodec,
  emptySnapshot,
  SNAPSHOT_VERSION,
  type IdentitySnapshot,
} from './store.ts'
export type {
  CreateIdentityAccountInput,
  IdentityAccount,
  IdentityAccountKind,
  IdentityAccountStatus,
  IdentityProvider,
  IdentityProtocol,
  IdentityRefreshResult,
  IdentityTokenBundle,
  UpdateIdentityAccountInput,
} from './types.ts'
export { ProviderExchangeError, supportsRefresh } from './providers.ts'

export default IdentityService
