/**
 * 账号管理门面的公开契约（供服务消费者与将来的前端 / HTTP 层使用）。
 *
 * 这些类型**没有秘密字段**：`AccountView` 只包含 identity 的账号元数据与
 * 「凭据配没配」。access / refresh token 与 API key 永远留在这层之下，
 * 由 identity → credentials 独占写入与读取（AGENTS.md D8）。
 */

/** 与 identity 的 provider 保持一致。 */
export type AccountProvider = 'claude' | 'openai' | 'custom'

/** 与 identity 的 protocol 保持一致：上游端点说哪种协议。 */
export type AccountProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'

/** 订阅账号（OAuth，可刷新）与静态 API key。 */
export type AccountKind = 'oauth' | 'api_key'

/** `active` 正常；`needs_reauth` 需要重新导入凭据。停用是独立的 `enabled` 开关。 */
export type AccountStatus = 'active' | 'needs_reauth'

/** identity 账号记录的结构性视图（刻意不含任何令牌字段）。 */
export interface AccountRecord {
  readonly id: string
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly label: string
  readonly enabled: boolean
  readonly status: AccountStatus
  /** 秘密所在的 credentials 引用名——只是名字，不是秘密。 */
  readonly credentialRef: string
  readonly email: string | null
  readonly subject: string | null
  /** 账号自己的 OpenAI 兼容 base URL；null = 用 provider 默认映射。 */
  readonly baseUrl: string | null
  /** 上游端点协议；null = 未声明（走旧行为）。 */
  readonly protocol: AccountProtocol | null
  /** 这个账号服务的对外模型名；null / 空 = 未声明（不参与按模型过滤）。 */
  readonly models: string[] | null
  /** 对外模型名 → 上游真实模型名；null / 空 = 不改写模型名。 */
  readonly modelMap: Record<string, string> | null
  readonly priority: number
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 管理面看到的账号：元数据 + 「凭据配没配」。 */
export interface AccountView extends AccountRecord {
  /** true = identity 的 credentials 引用下已有令牌 / API key；false = 尚未导入。 */
  readonly credentialConfigured: boolean
}

/** 列表过滤条件；全部可选，多个条件取交集。 */
export interface AccountListQuery {
  readonly provider?: AccountProvider
  readonly kind?: AccountKind
  readonly enabled?: boolean
  readonly status?: AccountStatus
  /** 不区分大小写，匹配 id / label / email / subject。 */
  readonly search?: string
}

/** 凭据格式。`auto` 会按 payload 的形状推断。 */
export type CredentialImportFormat =
  | 'auto'
  | 'claude-oauth'
  | 'openai-codex'
  | 'api-key'
  | 'identity-bundle'

/** JSON 文本、纯 API key 文本，或已经解析好的对象。 */
export type CredentialPayload = string | Record<string, unknown>

/** 一段待导入的凭据。 */
export interface CredentialImportInput {
  readonly format?: CredentialImportFormat
  readonly payload: CredentialPayload
  /** 覆盖 / 补充格式推断出的 provider；与格式冲突会明确报错。 */
  readonly provider?: AccountProvider
  /** 覆盖 / 补充格式推断出的账号类型；与格式冲突会明确报错。 */
  readonly kind?: AccountKind
}

/** 导入预检结果。**没有令牌本体**，只回答「识别成了什么、有哪些字段」。 */
export interface CredentialImportPreview {
  readonly format: Exclude<CredentialImportFormat, 'auto'>
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly email: string | null
  readonly subject: string | null
  readonly expiresAt: string | null
  readonly hasAccessToken: boolean
  readonly hasRefreshToken: boolean
  readonly hasApiKey: boolean
}

/** 新建账号。`credential` 省略时创建「尚未导入凭据」的账号。 */
export interface CreateAccountInput {
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly label: string
  readonly email?: string
  readonly subject?: string
  readonly baseUrl?: string
  readonly protocol?: AccountProtocol
  /** 这个账号服务的对外模型名；空数组与未声明等价。 */
  readonly models?: string[]
  /** 对外模型名 → 上游真实模型名；空对象与未声明等价。 */
  readonly modelMap?: Record<string, string>
  readonly priority?: number
  readonly enabled?: boolean
  /** 可选的凭据；解析后的值只交给 identity，永不回显。 */
  readonly credential?: CredentialImportInput
}

/** 只改非秘密元数据。启用 / 停用走独立的 enable / disable。 */
export interface UpdateAccountInput {
  readonly label?: string
  readonly email?: string | null
  readonly subject?: string | null
  readonly baseUrl?: string | null
  /** `undefined` = 不改；`null` = 清空为未声明。 */
  readonly protocol?: AccountProtocol | null
  /** `undefined` = 不改；`null` 或空数组 = 清空为未声明。 */
  readonly models?: string[] | null
  /** `undefined` = 不改；`null` 或空对象 = 清空为不改写。 */
  readonly modelMap?: Record<string, string> | null
  readonly priority?: number
}

/** 向已有账号导入 / 重新授权一份凭据。 */
export interface ImportCredentialsInput {
  readonly format?: CredentialImportFormat
  readonly payload: CredentialPayload
}

/** 批量导入的默认值，item 上的同名字段优先。 */
export interface BulkImportDefaults {
  readonly format?: CredentialImportFormat
  readonly provider?: AccountProvider
  readonly kind?: AccountKind
  readonly enabled?: boolean
  /** 给了它就用 `<prefix> #<序号>` 作默认 label，避免批量导入全叫同一个名字。 */
  readonly labelPrefix?: string
}

/** 批量导入的一项。每一项独立成功或失败，互不阻塞。 */
export interface BulkImportItem extends CredentialImportInput {
  readonly label?: string
  readonly email?: string
  readonly subject?: string
  readonly enabled?: boolean
}

export interface BulkImportInput {
  readonly defaults?: BulkImportDefaults
  readonly items: readonly BulkImportItem[]
}

export interface BulkImportFailure {
  /** AccountAdminErrorCode 或 identity / credentials 的稳定错误码。 */
  readonly code: string
  readonly message: string
}

export interface BulkImportItemResult {
  /** 在 items 里的下标（0 起）。 */
  readonly index: number
  readonly ok: boolean
  readonly account: AccountView | null
  readonly error: BulkImportFailure | null
}

/** 批量导入结果。允许部分成功：坏条目只影响它自己。 */
export interface BulkImportResult {
  readonly total: number
  readonly created: number
  readonly failed: number
  readonly items: readonly BulkImportItemResult[]
}
