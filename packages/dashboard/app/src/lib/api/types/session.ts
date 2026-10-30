/**
 * 会话与鉴权。
 *
 * 服务端来源：`http_session.ts` 的 `sessionResponse()` / `loginResponse()`、
 * `views/session.ts` 的 `sessionUserOf()`（= `SessionUserView`）。
 *
 * **cookie 名是 `dizzyapi_session`，HttpOnly**：前端读不到也不需要读，
 * 一律靠 `credentials: 'include'` 让浏览器带上。
 */
import type { SessionInfoView, SessionUserView } from '@dizzyapi/plugin-api/types'

export type { SessionInfoView, SessionRole, SessionUserView } from '@dizzyapi/plugin-api/types'

/** `GET /api/session` 的响应（`sessionResponse()`）。 */
export interface SessionView {
  readonly user: SessionUserView
  /** 邮箱；登录用户才有，取不到是 `null`。 */
  readonly email: string | null
  readonly session: SessionInfoView
  readonly permissions: { readonly admin: boolean }
}

/**
 * `POST /api/auth/login` 与 `POST /api/auth/register/confirm` 的响应
 * （`loginResponse()`；比 `SessionView` **少** `email` 与 `permissions`）。
 */
export interface LoginView {
  readonly user: SessionUserView
  readonly session: SessionInfoView
}

/** `POST /api/auth/register/request` 的响应（服务端原样回 `TicketLike`）。 */
export interface RegisterTicketView {
  readonly email: string
  readonly expiresAt: string
  /** 多久之后才允许重发验证码（毫秒）。 */
  readonly resendAfterMs: number
}

/** `PATCH /api/profile` 的响应：更新后的会话用户。 */
export type ProfileView = SessionUserView
