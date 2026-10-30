/**
 * 个人资料端点（用户侧自助）。
 *
 * **密码只走 POST body**：不进 URL、不进 localStorage、不进 console。
 * 头像只接受 http(s) 链接（服务端校验，`http://` 不收）。
 */
import type { ApiClient } from '../client.ts'
import type { ProfileView } from '../types.ts'

/** `PATCH /api/profile`：改用户名 / 头像。至少要有一个字段。 */
export function updateProfile(
  client: ApiClient,
  patch: { readonly name?: string; readonly avatar?: string | null },
): Promise<ProfileView> {
  return client.request<ProfileView>('/api/profile', { method: 'PATCH', body: patch })
}

/** `POST /api/profile/password`：改密码（要当前密码）。 */
export function changePassword(
  client: ApiClient,
  input: { readonly currentPassword: string; readonly newPassword: string },
): Promise<unknown> {
  return client.request('/api/profile/password', { method: 'POST', body: input })
}
