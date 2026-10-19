/**
 * 前端宿主（`@dizzyapi/plugin-frontend`）。
 *
 * 包名取 `frontend` 而不是 `console`：D13 把它定位成「前端插件」，
 * 而 `console` 在本项目里已经有 `/console` 用户站与开发者面板两层含义。
 * 目录仍叫 `packages/console`，因为它是两块路由区（/console、/admin）的宿主。
 *
 * 服务名是 `frontend`。它是控制面插件：不进 LLM 请求链路、不进描述符，
 * 只受 `app.yml` 的启用 / 禁用控制。禁用时清单停止刷新、状态文件标记为 disabled；
 * 已安装的静态字节仍在磁盘上，由 Go / 反代决定是否继续发（见 DESIGN.md）。
 */
import { FrontendService } from './service.ts'

declare module 'cordis' {
  interface Context {
    frontend: FrontendService
  }
}

export { FrontendService }
export type { FrontendAssetsView, FrontendDescription } from './service.ts'
export {
  AssetStore,
  contentTypeOf,
  normalizeAssetPath,
  type AssetBundle,
  type AssetFile,
  type AssetPointer,
  type AssetStoreOptions,
  type AssetVersionRecord,
  type InstalledAssetSet,
} from './assets.ts'
export {
  BUNDLED_ASSETS_DIR,
  bundledAssetVersion,
  configSource,
  prepareBundledFiles,
  readAssetDirectory,
} from './bundle.ts'
export {
  FRONTEND_CONFIG_SCHEMA,
  FRONTEND_CONFIG_SCHEMA as Config,
  FRONTEND_DEFAULTS,
  normalizeMountPath,
  validateFrontendConfig,
  type FrontendConfig,
  type ResolvedFrontendConfig,
} from './config.ts'
export type {
  AccountKind,
  AccountListQuery,
  AccountListResponse,
  AccountProvider,
  AccountStatus,
  AccountSummary,
  AccountUpdateInput,
  AccountsApi,
  AdminBalanceInput,
  AdminUserListResponse,
  AdminUserSummary,
  AdminUsersApi,
  AdminUserUpdateInput,
  ApiKeyListResponse,
  ApiKeySummary,
  ApiKeysApi,
  AuthTicket,
  LoginResponse,
  PasswordChangeInput,
  PasswordResetConfirmInput,
  ProfileUpdateInput,
  RegisterRequestInput,
  SessionApi,
  SessionInfo,
  SessionResponse,
  SessionRole,
  SessionUser,
  CatalogApi,
  CatalogModule,
  CatalogModuleKind,
  CatalogModuleState,
  CatalogResponse,
  ConsoleApi,
  ConsoleManifestResponse,
  FrontendApis,
  GatewayComponentHealth,
  GatewayHealth,
  GatewayHealthState,
  HealthApi,
  CreatedApiKey,
  CreateApiKeyInput,
  ManifestCard,
  ManifestPageView,
  ManifestSlot,
  SettingsApi,
  SettingsDescribeResponse,
  SettingsFieldKind,
  SettingsFieldView,
  SettingsNamespaceView,
  SettingsPatch,
  PaymentMethod,
  TopupApi,
  TopupMethod,
  TopupOptions,
  TopupOrder,
  TopupOrderInput,
  UpdateApiKeyInput,
  UsageApi,
  UsageBalances,
  UsageDailyPoint,
  UsageMetric,
  UsageModelBreakdown,
  UsageQuery,
  UsageRange,
  UsageResponse,
  UsageTotals,
} from './contracts.ts'
export { collectEnabledPlugins, type LoaderEntryLike } from './enabled.ts'
export { FrontendError, isFrontendError, type FrontendErrorCode } from './errors.ts'
export {
  BUILT_IN_CONTRIBUTIONS,
  CORE_OWNER,
  FRONTEND_AREAS,
  MANIFEST_SCHEMA_VERSION,
  ManifestRegistry,
  isFrontendManifestError,
  type ContributionBundle,
  type FrontendArea,
  type FrontendAreaInfo,
  type FrontendManifest,
  type FrontendPage,
  type FrontendSettingsCard,
  type FrontendSlot,
  type ManifestRegistryOptions,
  type PageView,
} from './manifest.ts'

export default FrontendService
