/**
 * 前端用到的接口类型（**桶文件**，按域拆在 `types/` 下）。
 *
 * **一个数据一个写者，类型也是共享的、不是复制的**：
 * `packages/api/src/types.ts` 是纯类型文件（零 import、零运行时依赖），
 * 所以凡是有名字的类型（`ApiKeySummaryView` / `SessionUserView` / `AdminUserView` /
 * `AccountViewLike` / `GatewayHealthView` / `CatalogModuleView` …）**直接 `import type` 复用**。
 *
 * 只有一类类型留在本地：**HTTP 响应 DTO**。服务端那些是 `views/*.ts` 里函数的
 * **匿名返回类型**（例如 `usageRowOf()` 直接返回对象字面量，没有命名类型），没法 import。
 * 本目录下每个形状都注明了对应的服务端来源函数，逐字照抄；
 * 后端若把它们提成命名类型，这里改成 import 即可。
 *
 * 金额纪律：余额 / 费用 / 单价一律是**整数最小单位或十进制字符串**
 * （微元，1 元 = 1_000_000 微元；价格是每百万 token 的元数），
 * **前端不做浮点运算**，要算就用 `BigInt`；显示用 `money.ts`。
 */
export type {
  ApiErrorEnvelope,
  CatalogModuleView,
  CatalogModulesView,
  GatewayComponentHealth,
  GatewayHealthState,
  HealthView,
  SettingsFieldView,
  SettingsNamespaceView,
  SettingsView,
} from './types/common.ts'

export type {
  LoginView,
  ProfileView,
  RegisterTicketView,
  SessionInfoView,
  SessionRole,
  SessionUserView,
  SessionView,
} from './types/session.ts'

export type { ApiKeySummaryView, CreatedApiKeyView, KeyListView } from './types/keys.ts'

export type {
  AdminRejectedPageView,
  AdminRejectedRowView,
  AdminUsageRowView,
  AdminUsageView,
  UsageDailyView,
  UsageDetailRowView,
  UsageDetailView,
  UsageExportView,
  UsageModelView,
  UsageRowView,
  UsageTotalsView,
  UsageUserView,
  UsageView,
} from './types/usage.ts'

export type {
  ModelCatalogSummaryView,
  ModelCatalogView,
  ModelEntryView,
  ModelPriceInputView,
  ModelPriceView,
  ModelProbeHealth,
  ModelProbePointStatus,
  ModelProbePointView,
  ModelProbeSummaryView,
  ModelProbeView,
  ModelUnavailableView,
  NestedModelPriceView,
  PricingListView,
} from './types/pricing.ts'

export type {
  AdminBillingView,
  AdminRedeemBatchesView,
  AdminRedeemCodesView,
  AdminTopupOrderListView,
  ConfirmTopupView,
  CreatedRedeemBatchView,
  RedeemBatchView,
  RedeemCodeView,
  RedeemDeletionView,
  RedeemResultView,
  RedeemStatsView,
  RedemptionView,
  SettleDailyView,
  SettleModelView,
  SettleRecordView,
  SettleTotalsView,
  TopupCreateView,
  TopupOptionsView,
  TopupOrderListView,
  TopupOrderView,
  TopupStatsView,
} from './types/commerce.ts'

export type {
  AccountListView,
  AccountViewLike,
  AdminAuditView,
  AdminContentAuditView,
  AdminObservabilityView,
  AdminStatsUsageView,
  AdminStatsView,
  AdminUserListView,
  AdminUserView,
  AuditRecordView,
  AuditStatsView,
  BalanceAdjustmentView,
  ContentAuditRuleView,
  ContentAuditStatusView,
  SourceHealthView,
  UserStatusLike,
} from './types/admin.ts'
