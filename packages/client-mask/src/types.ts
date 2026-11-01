/**
 * 客户端指纹档案的形状。
 *
 * 「客户端伪装」这件事只有一种数据：**一组要贴到上游请求上的头 + 一个 User-Agent**。
 * 本文件只声明形状，不含任何逻辑（校验在 `template.ts`，持久化在 `store.ts`）。
 *
 * ## 为什么值里可以有占位符
 *
 * opencode 那种上游要的不是「某个固定字符串」，而是**会话亲和**：同一段对话要带同一个
 * `x-opencode-session`，否则它没法把请求路由到同一个会话上（owner 2026-11-01 撞到的
 * `HTTP 400: Request is missing x-opencode-session and cannot be routed efficiently`）。
 * 所以值里支持三种占位，**由 Go 在发请求前替换**（TS 侧不生成这些值：它不知道请求体，
 * 也不知道每个账号的 id）：
 *
 * - `{{uuid}}` —— 每次请求一个随机 UUID（指纹类头的常见要求）
 * - `{{session}}` —— **稳定会话 id**：按「账号 id + 首条 user 消息内容」算，同一段对话重复
 *   请求得到同一个值
 * - `{{timestamp}}` —— 毫秒时间戳
 *
 * ## 秘密边界
 *
 * 档案里**不许出现秘密值**（这是一个会被推到 Go、会显示在管理页、会进快照的数据面）。
 * 值只能是普通常量加上述占位符 —— 校验在 `template.ts` 里拦。
 */

/** 一个要贴到上游请求上的头。 */
export interface ClientHeader {
  /** HTTP 头名（大小写不敏感，落库保留原样）。 */
  readonly name: string
  /** 头值；可以含 `{{uuid}}` / `{{session}}` / `{{timestamp}}`。 */
  readonly value: string
}

/** 一套客户端指纹档案。 */
export interface ClientProfile {
  /** 稳定 id（账号记录里存的就是它）。 */
  readonly id: string
  /** 展示名（管理页用）。 */
  readonly label: string
  /** 这个档案在模仿什么、什么时候用它。 */
  readonly description: string | null
  /** 停用后账号挂在这个档案上等于「不伪装」。 */
  readonly enabled: boolean
  /** User-Agent；`null` = 不改（沿用网关默认）。 */
  readonly userAgent: string | null
  readonly headers: readonly ClientHeader[]
  /** 是否内置预置（内置的可以改、可以停用，但 `reset` 能还原）。 */
  readonly builtin: boolean
}

/** 改档案时的入参（只给要改的键；`null` 表示清空）。 */
export interface ClientProfilePatch {
  readonly label?: string
  readonly description?: string | null
  readonly enabled?: boolean
  readonly userAgent?: string | null
  readonly headers?: readonly ClientHeader[]
}

/** 账号快照里推给 Go 的那一小段。**不含任何秘密**，也不含模板（模板在 Go 侧展开）。 */
export interface ResolvedClientMask {
  readonly profileId: string
  readonly userAgent: string | null
  readonly headers: readonly ClientHeader[]
}

/** `status()` 的只读视图（排障用）。 */
export interface ClientMaskStatus {
  readonly enabled: boolean
  readonly profiles: number
  readonly enabledProfiles: number
  readonly builtin: number
  readonly custom: number
  /** 存储描述（文件路径或 memory），不含内容。 */
  readonly storage: string
}
