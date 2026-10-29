/**
 * 内容审核插件（@dizzyapi/plugin-content-audit）。
 *
 * 服务名 `contentAudit`：管理面维护关键词规则，心跳式推给 Go 的 pre 相位审核闸门；
 * 命中统计从 Go 读回。规则是 `dataPath` 的唯一写者，不含任何秘密。
 */
import { ContentAuditService } from './service.ts'

declare module 'cordis' {
  interface Context {
    contentAudit: ContentAuditService
  }

  interface Events {
    /** 规则被新增 / 修改 / 删除 / 启停（不含规则内容）。 */
    'contentaudit/changed'(ruleId: string, action: 'create' | 'update' | 'delete'): void
    /** Go 侧确认缓存了一版规则快照（不含规则内容）。 */
    'contentaudit/pushed'(revision: string, rules: number): void
    /** 规则快照推送失败（已按节流写日志）。 */
    'contentaudit/error'(code: string, message: string): void
  }
}

export { ContentAuditService, heartbeatTooSlow } from './service.ts'
export type {
  ContentAuditHits,
  ContentAuditRule,
  ContentAuditRuleInput,
  ContentAuditRulePatch,
  ContentAuditSnapshotPayload,
  ContentAuditStatus,
} from './types.ts'
export { ContentAuditError, isContentAuditError, type ContentAuditErrorCode } from './errors.ts'
export {
  CONTENT_AUDIT_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  CONTENT_AUDIT_CONFIG_SCHEMA as Config,
  CONTENT_AUDIT_DEFAULTS,
  validateContentAuditConfig,
  type ContentAuditConfig,
  type ResolvedContentAuditConfig,
} from './config.ts'

export default ContentAuditService
