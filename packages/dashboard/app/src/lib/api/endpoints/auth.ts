/**
 * 鉴权与会话端点。
 *
 * 纪律：
 * - **密码、验证码只走 POST body**，绝不进 URL（URL 会进浏览器历史 / 日志 / Referer）。
 * - 登录 / 注册成功后服务端 `Set-Cookie`（HttpOnly），**前端拿不到也不该存**它。
 * - 登出是幂等的（服务端 token 无效也算成功）。
 */
import type { ApiClient } from '../client.ts'
import type { LoginView, RegisterTicketView, SessionView } from '../types.ts'

/** `GET /api/session`：当前会话。未登录时服务端回 401（客户端抛 `ApiError`）。 */
export function fetchSession(client: ApiClient): Promise<SessionView> {
  return client.request<SessionView>('/api/session')
}

/** `POST /api/auth/login`：邮箱 + 密码。 */
export function login(
  client: ApiClient,
  input: { readonly email: string; readonly password: string },
): Promise<LoginView> {
  return client.request<LoginView>('/api/auth/login', { method: 'POST', body: input })
}

/** `POST /api/auth/logout`：幂等。 */
export function logout(client: ApiClient): Promise<{ readonly ok: boolean }> {
  return client.request<{ readonly ok: boolean }>('/api/auth/logout', { method: 'POST' })
}

/** `POST /api/auth/register/request`：申请验证码。 */
export function requestRegistration(
  client: ApiClient,
  input: { readonly email: string; readonly password: string; readonly name?: string },
): Promise<RegisterTicketView> {
  return client.request<RegisterTicketView>('/api/auth/register/request', { method: 'POST', body: input })
}

/** `POST /api/auth/register/confirm`：邮箱 + 验证码；成功后建立会话。 */
export function confirmRegistration(
  client: ApiClient,
  input: { readonly email: string; readonly code: string },
): Promise<LoginView> {
  return client.request<LoginView>('/api/auth/register/confirm', { method: 'POST', body: input })
}

/** `POST /api/auth/password/reset/request`：申请重置验证码。 */
export function requestPasswordReset(
  client: ApiClient,
  input: { readonly email: string },
): Promise<unknown> {
  return client.request('/api/auth/password/reset/request', { method: 'POST', body: input })
}

/** `POST /api/auth/password/reset/confirm`：邮箱 + 验证码 + 新密码。 */
export function confirmPasswordReset(
  client: ApiClient,
  input: { readonly email: string; readonly code: string; readonly password: string },
): Promise<unknown> {
  return client.request('/api/auth/password/reset/confirm', { method: 'POST', body: input })
}
