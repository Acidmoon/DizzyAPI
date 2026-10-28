/**
 * 账号健康检查插件（@dizzyapi/plugin-account-health）。
 *
 * 服务名 `accountHealth`：定时对有对 enabled 的账号做连通性测试，连续失败自动停用、
 * 连续成功自动恢复，并把健康状态写回 identity（**只经 `accountAdmin` 门面**）。
 *
 * 它自己不存任何数据，也没有 HTTP 路由与桥命令：禁用即只剩「服务消失」，
 * 定时器随 `ctx.effect` 一起回收（D5）。
 */
import { AccountHealthService } from './service.ts'

declare module 'cordis' {
  interface Context {
    accountHealth: AccountHealthService
  }
}

export { AccountHealthService, ACCOUNT_HEALTH_ACTOR } from './service.ts'
export type { AccountHealthPass, AccountHealthStatus } from './service.ts'
export {
  AccountHealthError,
  isAccountHealthError,
  type AccountHealthErrorCode,
} from './errors.ts'
export {
  ACCOUNT_HEALTH_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  ACCOUNT_HEALTH_CONFIG_SCHEMA as Config,
  ACCOUNT_HEALTH_DEFAULTS,
  validateAccountHealthConfig,
  type AccountHealthConfig,
  type ResolvedAccountHealthConfig,
} from './config.ts'

export default AccountHealthService
