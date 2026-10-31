/**
 * 未登录落点与 401 判定（用户侧页面私有，**不是传输层**）。
 *
 * 传输层只有一份：`@/lib/api`（`X-Requested-With` / cookie / 错误信封都在那里做一次）。
 * 本文件只回答两个问题——「哪种错误算没登录」与「没登录去哪」，**不发任何请求**。
 *
 * 落点是静态导出的登录页；`trailingSlash: true` 所以带尾斜杠。
 */

import { ApiError } from "@/lib/api";

/** 未登录 / 会话过期时的落点。 */
export const LOGIN_PATH = "/auth/v2/login/";

/** 401 = 没登录 / 会话过期；别的错误照常显示在页面上，不跳转（跳了会让人以为是自己输错了）。 */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.isUnauthorized;
}

/** 整页跳登录页；`replace` 不留返回历史（回去还是 401）。 */
export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  window.location.replace(LOGIN_PATH);
}
