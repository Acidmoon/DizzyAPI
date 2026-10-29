/**
 * 审计插件（@dizzyapi/plugin-audit）。
 *
 * 服务名是 `audit`：管理员操作审计记录的**唯一写者**，存储 `data/audit.db`。
 *
 * 谁用它：
 * - `api` / `web` 在**管理员写操作成功之后**调 `audit.record(...)`（运行期解析本服务，
 *   不 inject）：审计是旁路，absent 或抛错时业务照常成功，只记一条警告日志。
 * - `api` 的 `GET /api/admin/audit` 与 `web` 的 `/admin/audit` 调 `list` / `stats`。
 *
 * 它不挂 HTTP，不发事件，不读别的插件的数据：审计记录的事实由调用方在写操作的位置给出
 * （谁、对谁、做了什么、结果），本插件只负责**落库 + 脱敏 + 保留期**。
 */
import { AuditService } from './service.ts'

declare module 'cordis' {
  interface Context {
    audit: AuditService
  }
}

export { AuditService }
export { AuditError, isAuditError, type AuditErrorCode } from './errors.ts'
export {
  AUDIT_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  AUDIT_CONFIG_SCHEMA as Config,
  AUDIT_DEFAULTS,
  validateAuditConfig,
  type AuditConfig,
  type ResolvedAuditConfig,
} from './config.ts'
export { AUDIT_SCHEMA, openAuditDatabase } from './db.ts'
export { REDACTED, isSecretKey, redactText, sanitizeMetadata } from './redact.ts'
export type {
  AuditEntry,
  AuditPage,
  AuditQuery,
  AuditRecord,
  AuditResult,
  AuditServiceLike,
  AuditStats,
} from './types.ts'

export default AuditService
