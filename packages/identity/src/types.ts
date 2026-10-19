/**
 * 账号与令牌的形状。
 *
 * 分工是硬的（AGENTS.md §4、D8）：
 * - 这里的 `IdentityAccount` **不含任何秘密**，可以出现在日志、面板、桥消息里；
 * - 秘密（access / refresh token、API key）只存在 `credentials` 插件里，
 *   引用名是 `<credentialPrefix>/<account.id>`，账号记录只持有这个引用名。
 */

/**
 * 上游。`claude` / `openai` 有 RT 交换适配器；`custom` 只能用于 api_key 账号
 * （没有可刷新的订阅令牌）。
 */
export type IdentityProvider = 'claude' | 'openai' | 'custom'

/** 订阅账号（OAuth，可以刷新）与外部 API（只有静态 key）。 */
export type IdentityAccountKind = 'oauth' | 'api_key'

/**
 * `active`：正常参与调度；`needs_reauth`：RT 已失效或被撤销，等人工重新导入。
 * 「停用」是独立的 `enabled` 开关，不占用状态——停用是人的决定，不是故障。
 */
export type IdentityAccountStatus = 'active' | 'needs_reauth'

/** 放进 credentials 的令牌包。永远不落地到账号文件。 */
export interface IdentityTokenBundle {
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly tokenType?: string
  readonly scope?: string
  /** ISO 时间；访问令牌过期时间。 */
  readonly expiresAt?: string
  /** OpenAI/Codex 刷新时随请求带上的 client_id；缺省用官方 CLI 的值。 */
  readonly clientId?: string
  /** `api_key` 账号只存这一个字段。 */
  readonly apiKey?: string
}

/** 可以安全外露的账号记录（没有秘密字段）。 */
export interface IdentityAccount {
  readonly id: string
  readonly provider: IdentityProvider
  readonly kind: IdentityAccountKind
  readonly label: string
  readonly enabled: boolean
  readonly status: IdentityAccountStatus
  /** 秘密所在的 credentials 引用名。 */
  readonly credentialRef: string
  readonly email: string | null
  /** 上游侧主体标识（如 ChatGPT account_id、Claude account_uuid）。 */
  readonly subject: string | null
  /** 访问令牌过期时间（ISO）；`null` = 尚未导入令牌。 */
  readonly accessExpiresAt: string | null
  /** 下一次应该尝试刷新的时间；`null` = 不需要刷新（api_key）。 */
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  /** 退避截止时间；在此之前调度器不碰它。 */
  readonly backoffUntil: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 新建账号的输入。secret 会写进 credentials，不会进账号文件。 */
export interface CreateIdentityAccountInput {
  readonly provider: IdentityProvider
  readonly kind: IdentityAccountKind
  readonly label: string
  readonly email?: string
  readonly subject?: string
  readonly enabled?: boolean
  readonly secret?: IdentityTokenBundle
}

/** 可运行期修改的非秘密元数据。 */
export interface UpdateIdentityAccountInput {
  readonly label?: string
  readonly email?: string | null
  readonly subject?: string | null
  readonly enabled?: boolean
}

/** 一次刷新尝试的结果，供服务内部与测试使用。 */
export interface IdentityRefreshResult {
  readonly account: IdentityAccount
  readonly refreshed: boolean
}
