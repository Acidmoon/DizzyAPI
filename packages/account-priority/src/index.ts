/**
 * 账号请求优先级插件（@dizzyapi/plugin-account-priority）。
 *
 * 服务名是 `accountPriority`：策略组的唯一写者、gatewayd 的监管者。
 * 真正的打分发生在 Go 侧；本插件提供管理面与进程生命周期（D1 / D3）。
 */
import { AccountPriorityService } from './service.ts'
import type { ChildState } from './types.ts'

declare module 'cordis' {
  interface Context {
    accountPriority: AccountPriorityService
  }

  interface Events {
    /** gatewayd 监管状态变化；`detail` 是失败原因或 null。 */
    'account-priority/child-state'(state: ChildState, detail: string | null): void
    /** 策略组被写入或删除。 */
    'account-priority/strategies-updated'(id: string, action: 'upsert' | 'remove'): void
    /** Go 侧确认应用了一版策略；`revision` 由 Go 计算。 */
    'account-priority/applied'(revision: string): void
    /** Go 侧确认缓存了一版账号/令牌快照；不含秘密。 */
    'account-priority/accounts-applied'(revision: string, accounts: number): void
    /** 子进程、桥或策略推送失败。 */
    'account-priority/error'(code: string, message: string): void
  }
}

export { AccountPriorityService }
export {
  AccountPriorityError,
  isAccountPriorityError,
  type AccountPriorityErrorCode,
} from './errors.ts'
export {
  ACCOUNT_PRIORITY_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  ACCOUNT_PRIORITY_CONFIG_SCHEMA as Config,
  ACCOUNT_PRIORITY_DEFAULTS,
  validateAccountPriorityConfig,
  type AccountPriorityConfig,
  type ResolvedAccountPriorityConfig,
} from './config.ts'
export {
  accountPriorityCodec,
  createAccountPriorityStore,
  emptySnapshot,
  SNAPSHOT_VERSION,
  type AccountPrioritySnapshot,
} from './store.ts'
export {
  DEFAULT_STRATEGY,
  type AccountCandidate,
  type AccountPriorityHealth,
  type AccountPriorityStatus,
  type ChildState,
  type ExcludedAccount,
  type FactorRule,
  type GatewayAccount,
  type GatewayAccountSnapshot,
  type GatewayAccountsResult,
  type RemoteStatus,
  type ScoreFactor,
  type ScoreRequest,
  type ScoreResult,
  type ScoredAccount,
  type StrategyDirection,
  type StrategyFilter,
  type StrategyGroup,
  type StrategyHealthPolicy,
  type StrategyListResult,
  type StrategyListSnapshot,
  type StrategySelection,
} from './types.ts'
export {
  MAX_CANDIDATES,
  MAX_STRATEGIES,
  validateScoreRequest,
  validateStrategyCollection,
  validateStrategyGroup,
  type StrategyCollection,
} from './validate.ts'
export {
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_PROTOCOL_VERSION,
  BridgeClient,
  type BridgeClientOptions,
  type BridgeNotification,
} from './bridge.ts'
export {
  GatewayProcess,
  type GatewayProcessOptions,
  type GatewayReadyInfo,
  type StartedGateway,
} from './supervisor.ts'

export default AccountPriorityService
