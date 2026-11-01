/**
 * 账号记录的**对外视图**（从 `service.ts` 搬出，§5.6：那个文件已超 500 行）。
 *
 * 逐字段显式复制、**不 spread** identity 的记录：这样将来 identity 多出一个字段
 * （尤其是凭据引用名之类），也不会自动漏到管理面。
 */
import type { AccountRecord, AccountView } from './types.ts'

export function toView(account: AccountRecord, credentialConfigured: boolean): AccountView {
  return {
    id: account.id,
    provider: account.provider,
    kind: account.kind,
    label: account.label,
    enabled: account.enabled,
    status: account.status,
    credentialRef: account.credentialRef,
    email: account.email,
    subject: account.subject,
    baseUrl: account.baseUrl,
    protocol: account.protocol,
    models: account.models,
    modelMap: account.modelMap,
    clientProfile: account.clientProfile,
    priority: account.priority,
    labels: [...account.labels],
    weight: account.weight,
    concurrency: account.concurrency,
    health: account.health,
    autoDisabledAt: account.autoDisabledAt,
    autoDisabledReason: account.autoDisabledReason,
    lastUsedAt: account.lastUsedAt,
    accessExpiresAt: account.accessExpiresAt,
    refreshDueAt: account.refreshDueAt,
    lastRefreshAt: account.lastRefreshAt,
    lastError: account.lastError,
    failureCount: account.failureCount,
    backoffUntil: account.backoffUntil,
    lastTestAt: account.lastTestAt,
    lastTestOk: account.lastTestOk,
    lastTestError: account.lastTestError,
    lastTestLatencyMs: account.lastTestLatencyMs,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    credentialConfigured,
  }
}
