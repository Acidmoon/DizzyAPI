/**
 * 账号管理插件（@dizzyapi/plugin-account-admin）。
 *
 * 服务名是 `accountAdmin`：管理员导入 / 新建 / 修改 / 停用 / 删除上游账号的进程内门面。
 *
 * 它**不持有任何数据**：
 * - 账号记录与令牌刷新仍由 identity 独占（D8 / D17 / D18）；
 * - 秘密仍由 credentials 独占；
 * - 因此禁用本插件不会影响账号与刷新调度，只是拿掉管理入口（D5）。
 *
 * 写操作要求 actor 在 `adminPlugins` 白名单里；读操作不限权。
 * 未来接 HTTP 时，路由层只应调用本服务的公开方法，并把认证后的管理员身份映射成
 * 白名单里的 actor 名；`identity.getAccessToken` / `credentials.resolve` 仍不得进路由。
 */
import { AccountAdminService } from './service.ts'

declare module 'cordis' {
  interface Context {
    accountAdmin: AccountAdminService
  }
}

export { AccountAdminService }
export { AccountAdminError, isAccountAdminError, errorCodeOf, type AccountAdminErrorCode } from './errors.ts'
export {
  ACCOUNT_ADMIN_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  ACCOUNT_ADMIN_CONFIG_SCHEMA as Config,
  ACCOUNT_ADMIN_DEFAULTS,
  validateAccountAdminConfig,
  type AccountAdminConfig,
  type ResolvedAccountAdminConfig,
} from './config.ts'
export { previewCredentialImport } from './importers.ts'
export type {
  AccountKind,
  AccountListQuery,
  AccountProvider,
  AccountRecord,
  AccountStatus,
  AccountView,
  BulkImportDefaults,
  BulkImportFailure,
  BulkImportInput,
  BulkImportItem,
  BulkImportItemResult,
  BulkImportResult,
  CreateAccountInput,
  CredentialImportFormat,
  CredentialImportInput,
  CredentialImportPreview,
  CredentialPayload,
  ImportCredentialsInput,
  UpdateAccountInput,
} from './types.ts'

export default AccountAdminService
