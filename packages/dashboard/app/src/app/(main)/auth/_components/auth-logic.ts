/**
 * 登录 / 注册 / 会话的**纯逻辑**（没有 React、没有 `@/` 别名、没有 DOM）。
 *
 * 为什么单独成文件：
 * - 这些是**契约翻译**（服务端稳定 `code` → 中文文案、角色 → 落地页），要能被 node 测试
 *   逐字断言；
 * - `.tsx` 里写纯函数会拖 React 进类型检查，根仓库的 `tsc` 没有 DOM lib。
 *
 * 纪律（和页面组件一起守）：
 * - 密码、验证码**只走 POST body**，不进 URL、不进 `localStorage` / `sessionStorage`、
 *   不进 `console`，提交后清空 state；
 * - 文案**不许直接把服务端原文弹给用户**（服务端 message 可能带内部细节），
 *   一律按稳定 `code` 翻中文，翻不到再按状态码兜底。
 */

/** 登录页路径（静态导出，路由段是 `(main)/auth/v2/login`）。 */
export const LOGIN_PATH = '/auth/v2/login'
/** 注册页路径。 */
export const REGISTER_PATH = '/auth/v2/register'
/** 管理员落地页。 */
export const ADMIN_HOME = '/dashboard'
/** 普通用户落地页。 */
export const USER_HOME = '/user'

/** 结构化的错误形状（`ApiError` 结构兼容，但这里不 import 它，保持纯逻辑可测）。 */
export interface AuthIssue {
  readonly code: string
  readonly status: number
}

/**
 * 稳定 `code` → 中文文案。
 *
 * 只覆盖**登录 / 注册 / 会话**这一条链路上的码（`packages/api/src/errors.ts` 与
 * `packages/auth` 里实际存在的那批）。注意服务端的码是 `AUTH_CREDENTIALS_INVALID`，
 * **不是** `AUTH_INVALID_CREDENTIALS`。
 */
const AUTH_ERROR_TEXT: Readonly<Record<string, string>> = {
  AUTH_CREDENTIALS_INVALID: '邮箱或密码不正确',
  AUTH_RATE_LIMITED: '尝试过于频繁，请稍后再试',
  AUTH_USER_BANNED: '这个账号已被停用，请联系站点管理员',
  AUTH_USER_MISSING: '这个账号不存在',
  AUTH_SESSION_INVALID: '登录状态已失效，请重新登录',
  AUTH_SESSION_EXPIRED: '登录状态已失效，请重新登录',
  AUTH_CODE_INVALID: '验证码不正确',
  AUTH_CODE_ATTEMPTS_EXCEEDED: '验证码错误次数过多，请重新获取',
  AUTH_EMAIL_TAKEN: '这个邮箱已经注册过了',
  AUTH_EMAIL_INVALID: '邮箱格式不正确',
  AUTH_PASSWORD_WEAK: '密码太简单，请换一个更复杂的',
  AUTH_NAME_UNAVAILABLE: '这个用户名已被占用',
  AUTH_MAIL_FAILED: '验证码发送失败，请稍后再试',
  AUTH_FIELDS: '请把必填项填写完整',
  API_TIMEOUT: '请求超时，请检查网络后重试',
  API_NETWORK_ERROR: '网络异常，请检查网络后重试',
}

/**
 * 把一次失败的提交翻成一句中文。
 *
 * 顺序是**刻意的**：先按稳定 `code`（最准），再按 HTTP 状态码兜底（防服务端加了新码），
 * 最后给一句通用文案。**任何情况下都不回显服务端原文**。
 */
export function authErrorTextOf(issue: AuthIssue): string {
  const known = AUTH_ERROR_TEXT[issue.code]
  if (known !== undefined) return known
  if (issue.status === 401) return '邮箱或密码不正确'
  if (issue.status === 403) return '当前账号没有这个操作权限'
  if (issue.status === 409) return '这个操作和当前状态冲突，请刷新后重试'
  if (issue.status === 429) return '尝试过于频繁，请稍后再试'
  if (issue.status === 503) return '相关服务暂时不可用，请稍后再试'
  if (issue.status === 0) return '网络异常，请检查网络后重试'
  return '操作失败，请稍后再试'
}

/**
 * 登录成功后的落地页：**管理员进 `/dashboard`，普通用户进 `/user`**。
 *
 * 入参由**调用方**算好，本函数只做映射、不看原始 DTO。两个调用方的判据不同，都来自服务端：
 * - 登录 / 注册成功后：`login()` / `confirmRegistration()` 的返回**不带** `permissions`，
 *   只能看 `result.user.role === 'admin'`；
 * - 会话闸门里：`fetchSession()` 带 `permissions`，用 `session.permissions.admin`。
 *
 * 两者服务端同源（`sessionResponse()` 的 `permissions.admin` 就是 `role === 'admin'`），
 * 但**别在前端自己从邮箱 / 名字猜角色**。
 */
export function homePathOf(admin: boolean | null | undefined): string {
  return admin === true ? ADMIN_HOME : USER_HOME
}

/**
 * 只接受**站内路径**的 `next` 参数（防开放重定向）。
 *
 * 拒绝：绝对 URL（`http://…`）、协议相对（`//evil`）、反斜杠（浏览器会当斜杠）、
 * 以及指回认证页自身（登录成功后又回登录页 = 死循环）。
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const value = raw.trim()
  if (value === '') return null
  if (!value.startsWith('/')) return null
  if (value.startsWith('//')) return null
  if (value.includes('\\')) return null
  if (value.startsWith('/auth/')) return null
  return value
}

/** 从 `location.search` 里取 `next`（已过白名单）。 */
export function nextPathOf(search: string | null | undefined): string | null {
  if (search === null || search === undefined || search === '') return null
  const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`)
  return safeNextPath(params.get('next'))
}

/**
 * 未登录被拦下时的跳转地址：带上当前页作为 `next`，登录后能回到原地。
 *
 * 认证页自身不参与（避免 `/auth/v2/login?next=/auth/v2/login`）。
 */
export function loginPathWithNext(pathname: string | null | undefined): string {
  const next = safeNextPath(pathname)
  if (next === null) return LOGIN_PATH
  return `${LOGIN_PATH}?next=${encodeURIComponent(next)}`
}

/**
 * 把任意异常收窄成 `AuthIssue`。
 *
 * **不 import `ApiError`**（结构兼容即可），这样本文件仍能被 node 测试直接 import——
 * 根仓库的 `tsc` 没有 DOM lib，`@/` 别名在 node 里也不存在。
 */
export function toAuthIssue(cause: unknown): AuthIssue {
  if (typeof cause === 'object' && cause !== null) {
    const record = cause as { code?: unknown; status?: unknown }
    if (typeof record.code === 'string' && record.code !== '') {
      return { code: record.code, status: typeof record.status === 'number' ? record.status : 0 }
    }
  }
  return { code: 'CLIENT_UNEXPECTED', status: 0 }
}

/**
 * 验证码的格式校验：服务端 `codeDigits` 是**可配的 4..10 位**（默认 6），
 * 所以前端别写死 6 位，否则改配置后用户根本提交不了。
 */
export function isVerificationCode(value: string): boolean {
  return /^\d{4,10}$/.test(value.trim())
}

/** 重发验证码的冷却秒数（服务端 `resendAfterMs`；向上取整，最少 1 秒）。 */
export function resendSecondsOf(resendAfterMs: number): number {
  if (!Number.isFinite(resendAfterMs) || resendAfterMs <= 0) return 1
  return Math.max(1, Math.ceil(resendAfterMs / 1000))
}

/**
 * 「验证码已发送」的说明文案。
 *
 * 生产上 `mailer` 可能配成 `log` 传输（验证码只进服务端日志、不发信），
 * 这时**不能**假装「邮件已发送」——照实说清楚去哪取码，否则用户会一直等一封不会来的邮件。
 */
export const CODE_SENT_NOTICE =
  '验证码已发送。若站点邮件走日志投递（未接真实 SMTP），验证码只在服务端日志里，请联系站点管理员获取。'

/** 注册流程的两步（第一步发码，第二步提交码 + 密码换会话）。 */
export type RegisterStep = 'request' | 'confirm'
