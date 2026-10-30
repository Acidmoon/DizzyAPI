/**
 * 管理员面 · 用量 / 结算 / 审计 / 运维 / 内容审核端点。
 *
 * 这些路由都挂在 `/api/admin/*` 下，**都要管理员权限**。
 * 分页口径：用量是 keyset（`cursor`），其余是 offset / limit。
 */
import type { ApiClient } from '../client.ts'
import type {
  AdminAuditView,
  AdminBillingView,
  AdminContentAuditView,
  AdminObservabilityView,
  AdminRejectedPageView,
  AdminStatsView,
  AdminUsageView,
  CatalogModulesView,
  ContentAuditRuleView,
  HealthView,
  SettingsView,
} from '../types.ts'

// ───────────────────────────── 用量 ─────────────────────────────

/** 管理员用量的筛选条件。 */
export interface AdminUsageFilters {
  readonly range?: '7d' | '30d' | '90d'
  readonly userId?: number
  readonly apiKeyId?: string
  readonly model?: string
  /** 精确匹配的 HTTP 状态码（0..599）。 */
  readonly status?: number
  readonly cursor?: number
  readonly limit?: number
}

/** `GET /api/admin/usage`：全站用量（明细 + 汇总 + 隔离区前 20 条）。 */
export function fetchAdminUsage(
  client: ApiClient,
  filters: AdminUsageFilters = {},
): Promise<AdminUsageView> {
  return client.request<AdminUsageView>('/api/admin/usage', { query: { ...filters } })
}

/** `GET /api/admin/usage/export`：导出 CSV（响应是 `{ filename, content }`）。 */
export function exportAdminUsage(
  client: ApiClient,
  filters: AdminUsageFilters = {},
): Promise<{ readonly filename: string; readonly content: string }> {
  return client.request<{ readonly filename: string; readonly content: string }>(
    '/api/admin/usage/export',
    { query: { ...filters } },
  )
}

/** `GET /api/admin/usage/rejected`：隔离区（完整分页）。 */
export function fetchRejectedUsage(
  client: ApiClient,
  options: { readonly limit?: number; readonly offset?: number; readonly status?: string } = {},
): Promise<AdminRejectedPageView> {
  return client.request<AdminRejectedPageView>('/api/admin/usage/rejected', {
    query: { ...options },
  })
}

/**
 * `POST /api/admin/usage/rejected/:reqId/ignore`：忽略一条隔离记录。
 *
 * 忽略 = 承认这条记录不作数（不结算、不扣钱）。
 */
export function ignoreRejectedUsage(
  client: ApiClient,
  reqId: string,
): Promise<{ readonly reqId: string; readonly status: string }> {
  return client.request<{ readonly reqId: string; readonly status: string }>(
    `/api/admin/usage/rejected/${encodeURIComponent(reqId)}/ignore`,
    { method: 'POST' },
  )
}

/**
 * `POST /api/admin/usage/rejected/:reqId/replay`：重放一条隔离记录。
 *
 * 重放要补结算；结算插件缺席时回 503 `USAGE_SETTLE_UNAVAILABLE`（fail-closed）。
 */
export function replayRejectedUsage(
  client: ApiClient,
  reqId: string,
): Promise<{ readonly reqId: string; readonly status: string }> {
  return client.request<{ readonly reqId: string; readonly status: string }>(
    `/api/admin/usage/rejected/${encodeURIComponent(reqId)}/replay`,
    { method: 'POST' },
  )
}

// ───────────────────────────── 结算 ─────────────────────────────

/** `GET /api/admin/billing`：结算记录与汇总。 */
export function fetchBilling(
  client: ApiClient,
  options: { readonly status?: string; readonly limit?: number; readonly offset?: number } = {},
): Promise<AdminBillingView> {
  return client.request<AdminBillingView>('/api/admin/billing', { query: { ...options } })
}

// ───────────────────────────── 审计 ─────────────────────────────

/** 审计查询条件。 */
export interface AdminAuditFilters {
  readonly actor?: string
  readonly actorPlugin?: string
  readonly action?: string
  readonly targetType?: string
  readonly targetId?: string
  /** 时间窗（毫秒时间戳；0 = 不限）。 */
  readonly from?: number
  readonly to?: number
  readonly limit?: number
  readonly offset?: number
  /** 带 `1` 则附带汇总。 */
  readonly stats?: '1'
}

/** `GET /api/admin/audit`：操作审计。 */
export function fetchAudit(
  client: ApiClient,
  filters: AdminAuditFilters = {},
): Promise<AdminAuditView> {
  return client.request<AdminAuditView>('/api/admin/audit', { query: { ...filters } })
}

// ───────────────────────────── 运维总览 ─────────────────────────────

/** `GET /api/admin/observability`：运维总览（任一数据源缺失只降级那几块，HTTP 仍 200）。 */
export function fetchObservability(client: ApiClient): Promise<AdminObservabilityView> {
  return client.request<AdminObservabilityView>('/api/admin/observability')
}

// ───────────────────────────── 内容审核 ─────────────────────────────

/** `GET /api/admin/content-audit`：审核规则与状态。 */
export function fetchContentAudit(client: ApiClient): Promise<AdminContentAuditView> {
  return client.request<AdminContentAuditView>('/api/admin/content-audit')
}

/**
 * `POST /api/admin/content-audit`：新增一条规则（响应是 `{ rule }`）。
 *
 * `pattern` 是关键词（**子串匹配**，不区分大小写）；`action` 是 `block`（拒绝）
 * 或 `log`（只记日志），省略时由插件取默认值。
 */
export function createContentAuditRule(
  client: ApiClient,
  input: {
    readonly pattern: string
    readonly action: 'block' | 'log'
    readonly category?: string
    readonly enabled?: boolean
    readonly note?: string
  },
): Promise<{ readonly rule: ContentAuditRuleView }> {
  return client.request<{ readonly rule: ContentAuditRuleView }>('/api/admin/content-audit', {
    method: 'POST',
    body: input,
  })
}

/** `PATCH /api/admin/content-audit/:id`：改一条规则（响应是 `{ rule }`）。 */
export function updateContentAuditRule(
  client: ApiClient,
  id: string,
  input: {
    readonly pattern?: string
    readonly action?: 'block' | 'log'
    readonly category?: string | null
    readonly enabled?: boolean
    readonly note?: string | null
  },
): Promise<{ readonly rule: ContentAuditRuleView }> {
  return client.request<{ readonly rule: ContentAuditRuleView }>(
    `/api/admin/content-audit/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: input },
  )
}

/** `DELETE /api/admin/content-audit/:id`：删一条规则。 */
export function deleteContentAuditRule(
  client: ApiClient,
  id: string,
): Promise<{ readonly removed: boolean }> {
  return client.request<{ readonly removed: boolean }>(
    `/api/admin/content-audit/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

/** `POST /api/admin/content-audit/push`：立刻把规则推给 Go 一次。 */
export function pushContentAuditRules(
  client: ApiClient,
): Promise<{ readonly revision: number }> {
  return client.request<{ readonly revision: number }>('/api/admin/content-audit/push', {
    method: 'POST',
  })
}

// ───────────────────────────── 概览 / 设置 / 目录 / 健康 ─────────────────────────────

/** `GET /api/admin/stats`：管理概览（用户 / 账号 / key 计数 + 今日与累计）。 */
export function fetchAdminStats(client: ApiClient): Promise<AdminStatsView> {
  return client.request<AdminStatsView>('/api/admin/stats')
}

/** `GET /api/settings`：设置描述（按命名空间分组）。 */
export function fetchSettings(client: ApiClient): Promise<SettingsView> {
  return client.request<SettingsView>('/api/settings')
}

/**
 * `POST /api/settings/:ns`：改设置。
 *
 * `expectedRevision` 是乐观锁：服务端发现版本变了就回 409 `SETTINGS_CONFLICT`，
 * 前端应当重新拉一次再让人改。
 */
export function updateSettings(
  client: ApiClient,
  namespace: string,
  patch: Record<string, unknown>,
  expectedRevision?: string,
): Promise<unknown> {
  return client.request(`/api/settings/${encodeURIComponent(namespace)}`, {
    method: 'POST',
    body: {
      patch,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    },
  })
}

/** `DELETE /api/settings/:ns`：把某个命名空间重置成 `app.yml` 的基线。 */
export function resetSettings(client: ApiClient, namespace: string): Promise<unknown> {
  return client.request(`/api/settings/${encodeURIComponent(namespace)}`, { method: 'DELETE' })
}

/** `GET /api/catalog/modules`：插件目录（管理员）。 */
export function fetchCatalogModules(client: ApiClient): Promise<CatalogModulesView> {
  return client.request<CatalogModulesView>('/api/catalog/modules')
}

/** `GET /api/health`：健康（**公开**，不需要会话）。 */
export function fetchHealth(client: ApiClient): Promise<HealthView> {
  return client.request<HealthView>('/api/health')
}
