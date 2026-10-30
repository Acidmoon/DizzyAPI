/**
 * 管理员面 · 用户 / 上游账号端点。
 *
 * 路径注意：管理员的**用户**与**上游账号**路由挂在 `/api/users` 与 `/api/accounts`
 * （不带 `admin` 前缀），但**都要管理员权限**（服务端 `requireAdmin`）。
 * 而 `/api/admin/*` 下那些（用量 / 结算 / 审计…）才是管理台页面。
 *
 * 审计纪律：这些写操作在服务端**成功后**都会记一条审计，前端不需要额外做什么。
 */
import type { ApiClient } from '../client.ts'
import type { AccountListView, AccountViewLike, AdminUserListView, AdminUserView } from '../types.ts'

// ───────────────────────────── 用户 ─────────────────────────────

/** 用户列表的筛选条件。 */
export interface AdminUserFilters {
  readonly status?: 'enabled' | 'banned'
  readonly offset?: number
  readonly limit?: number
}

/** `GET /api/users`：用户列表（管理员）。 */
export function listUsers(
  client: ApiClient,
  filters: AdminUserFilters = {},
): Promise<AdminUserListView> {
  return client.request<AdminUserListView>('/api/users', { query: { ...filters } })
}

/** `GET /api/users/:id`：单个用户（管理员）。 */
export function fetchUser(client: ApiClient, id: number): Promise<AdminUserView> {
  return client.request<AdminUserView>(`/api/users/${encodeURIComponent(String(id))}`)
}

/**
 * `PATCH /api/users/:id`：改用户。
 *
 * 可改字段：名字 / 角色 / 状态 / 余额开关 / 并发上限。
 * **并发上限 null = 不限**；服务端会按字段逐项 diff，没变的字段不写、不留审计。
 */
export function updateUser(
  client: ApiClient,
  id: number,
  patch: {
    readonly name?: string
    readonly role?: 'admin' | 'user'
    readonly status?: 'enabled' | 'banned'
    readonly balanceEnabled?: boolean
    readonly concurrencyLimit?: number | null
  },
): Promise<AdminUserView> {
  return client.request<AdminUserView>(`/api/users/${encodeURIComponent(String(id))}`, {
    method: 'PATCH',
    body: patch,
  })
}

/**
 * `POST /api/users/:id/balance`：调整余额。
 *
 * `delta` 是**整数微元的十进制字符串**（可负）——**不能传 JSON number**
 * （微元可能超过 2^53，传 number 会丢精度）。
 * 余额允许为负（后付费）。
 */
export function adjustBalance(
  client: ApiClient,
  id: number,
  input: { readonly delta: string; readonly reason: string },
): Promise<{ readonly balanceMinor: string }> {
  return client.request<{ readonly balanceMinor: string }>(
    `/api/users/${encodeURIComponent(String(id))}/balance`,
    { method: 'POST', body: input },
  )
}

/** `DELETE /api/users/:id`：删除用户（管理员）。 */
export function deleteUser(
  client: ApiClient,
  id: number,
): Promise<{ readonly removed: boolean }> {
  return client.request<{ readonly removed: boolean }>(
    `/api/users/${encodeURIComponent(String(id))}`,
    { method: 'DELETE' },
  )
}

// ───────────────────────────── 上游账号 ─────────────────────────────

/** 上游账号列表的筛选条件。 */
export interface AdminAccountFilters {
  readonly provider?: string
  readonly status?: string
  /** 偏移游标（服务端内部叫 cursor，其实就是 offset）。 */
  readonly cursor?: number
  readonly limit?: number
}

/** `GET /api/accounts`：上游账号列表（管理员）。 */
export function listAccounts(
  client: ApiClient,
  filters: AdminAccountFilters = {},
): Promise<AccountListView> {
  return client.request<AccountListView>('/api/accounts', { query: { ...filters } })
}

/** `GET /api/accounts/:id`：单个上游账号（管理员）。 */
export function fetchAccount(client: ApiClient, id: string): Promise<AccountViewLike> {
  return client.request<AccountViewLike>(`/api/accounts/${encodeURIComponent(id)}`)
}

/**
 * `POST /api/accounts`：新建上游账号（管理员）。
 *
 * `credential` 是凭据（可含上游 key）——**只走 body，绝不进 URL**；
 * 服务端把它写进 `credentials` 存储，响应里**不回显凭据**。
 */
export function createAccount(
  client: ApiClient,
  input: {
    readonly provider: string
    readonly kind: string
    readonly label: string
    readonly email?: string
    readonly subject?: string
    readonly baseUrl?: string
    readonly protocol?: string
    readonly models?: readonly string[]
    readonly modelMap?: Readonly<Record<string, string>>
    readonly priority?: number
    readonly enabled?: boolean
    readonly credential?: unknown
  },
): Promise<AccountViewLike> {
  return client.request<AccountViewLike>('/api/accounts', { method: 'POST', body: input })
}

/**
 * `PATCH /api/accounts/:id`：改上游账号（管理员）。
 *
 * 字段变化与启停是**两笔独立的审计**，服务端分开写。
 */
export function updateAccount(
  client: ApiClient,
  id: string,
  patch: {
    readonly label?: string
    readonly email?: string | null
    readonly subject?: string | null
    readonly baseUrl?: string | null
    readonly protocol?: string | null
    readonly models?: readonly string[] | null
    readonly modelMap?: Readonly<Record<string, string>> | null
    readonly priority?: number
    readonly enabled?: boolean
  },
): Promise<AccountViewLike> {
  return client.request<AccountViewLike>(`/api/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  })
}

/** `DELETE /api/accounts/:id`：删除上游账号（管理员）。 */
export function deleteAccount(
  client: ApiClient,
  id: string,
): Promise<{ readonly removed: boolean }> {
  return client.request<{ readonly removed: boolean }>(
    `/api/accounts/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  )
}

/** `POST /api/accounts/:id/test`：连通性测试（管理员，发一条最小真实请求）。 */
export function testAccount(
  client: ApiClient,
  id: string,
  input: { readonly model?: string; readonly protocol?: string } = {},
): Promise<unknown> {
  return client.request(`/api/accounts/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: input,
  })
}

/**
 * `POST /api/accounts/:id/credentials`：导入凭据（管理员）。
 *
 * `payload` 是凭据内容——**只走 body**，不进 URL、不进日志。
 * 服务端审计**只记格式**，绝不记 payload。
 */
export function importAccountCredentials(
  client: ApiClient,
  id: string,
  input: { readonly payload: string | Record<string, unknown>; readonly format?: string },
): Promise<AccountViewLike> {
  return client.request<AccountViewLike>(
    `/api/accounts/${encodeURIComponent(id)}/credentials`,
    { method: 'POST', body: input },
  )
}

/**
 * `POST /api/accounts/import`：批量导入上游账号（管理员）。
 *
 * `source` 决定格式（new-api Channel JSON / sub2api 导出 / 纯 key 列表）；
 * 不给 `source` 就是逐项格式。**payload 里是凭据，绝不进 URL**。
 */
export function importAccounts(
  client: ApiClient,
  input:
    | { readonly source: string; readonly payload: string; readonly defaults?: unknown }
    | Record<string, unknown>,
): Promise<unknown> {
  return client.request('/api/accounts/import', { method: 'POST', body: input })
}

/** `POST /api/accounts/import/preview`：批量导入预检（管理员）。 */
export function previewAccountImport(
  client: ApiClient,
  input:
    | { readonly source: string; readonly payload: string; readonly defaults?: unknown }
    | Record<string, unknown>,
): Promise<unknown> {
  return client.request('/api/accounts/import/preview', { method: 'POST', body: input })
}
