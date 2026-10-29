/**
 * 余额只读快照推送插件（@dizzyapi/plugin-quota）。
 *
 * 服务名 `quota`：周期把 `user` 的全量余额（只读）推给 Go 的额度闸门，
 * 余额变更后 debounce 补推。它自己不存数据、不做判断，也不拥有控制桥。
 */
import { QuotaService } from './service.ts'

declare module 'cordis' {
  interface Context {
    quota: QuotaService
  }

  interface Events {
    /** Go 侧确认缓存了一版余额快照（不含任何余额值）。 */
    'quota/pushed'(revision: string, entries: number): void
    /** 余额快照推送失败（已按节流写日志）。 */
    'quota/error'(code: string, message: string): void
  }
}

export {
  QuotaService,
  heartbeatTooSlow,
  type QuotaSnapshotEntry,
  type QuotaSnapshotPayload,
  type QuotaStatus,
} from './service.ts'
export { QuotaError, isQuotaError, type QuotaErrorCode } from './errors.ts'
export {
  QUOTA_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  QUOTA_CONFIG_SCHEMA as Config,
  QUOTA_DEFAULTS,
  validateQuotaConfig,
  type QuotaConfig,
  type ResolvedQuotaConfig,
} from './config.ts'

export default QuotaService
