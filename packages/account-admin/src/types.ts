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

/**
 * `active` 正常；`needs_reauth` 需要重新导入凭据；
 * `auto_disabled` 是健康检查连续失败后的系统自动停用（一次成功即恢复）。
 * 人的停用是独立的 `enabled` 开关，自动化不会覆盖它。
 */
export type AccountStatus = 'active' | 'needs_reauth' | 'auto_disabled'

/** 健康状态；与 Go 侧 `contracts.HealthState` 对齐，未知是一等状态。 */
export type AccountHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'

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
  /** 多标签数组；空数组 = 未打标签。 */
  readonly labels: readonly string[]
  /** 权重（> 0）；`null` = 未声明。 */
  readonly weight: number | null
  /** 并发上限（>= 1）；`null` = 未声明。 */
  readonly concurrency: number | null
  /** 健康状态；未知是一等状态，默认 `unknown`。 */
  readonly health: AccountHealth
  /** 自动停用时间（ISO）；未自动停用时为 `null`。 */
  readonly autoDisabledAt: string | null
  /** 自动停用原因（已脱敏）；未自动停用时为 `null`。 */
  readonly autoDisabledReason: string | null
  /** 最近一次被 LLM 请求使用的时间（ISO）；`null` = 还没有用量的回报。 */
  readonly lastUsedAt: string | null
  readonly accessExpiresAt: string | null
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  readonly backoffUntil: string | null
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
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
  /** 多标签过滤：**AND** 语义，账号必须包含列出的每一个标签。 */
  readonly labels?: readonly string[]
  /** 只返回这个健康状态的账号。 */
  readonly health?: AccountHealth
}

/**
 * 列表精简视图（`list(query, { view: 'lite' })`）。
 *
 * 列表只放「一眼要看、点一下要用」的字段；详情字段（baseUrl / models / modelMap /
 * 凭据时间线等）走 `get()`。字段变多之后列表页不该被撑爆（参考 sub2api 的 lite DTO）。
 */
export interface AccountListItem {
  readonly id: string
  readonly label: string
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly enabled: boolean
  readonly status: AccountStatus
  readonly credentialConfigured: boolean
  readonly priority: number
  readonly labels: readonly string[]
  readonly weight: number | null
  readonly concurrency: number | null
  readonly health: AccountHealth
  readonly autoDisabledAt: string | null
  readonly autoDisabledReason: string | null
  readonly lastUsedAt: string | null
  readonly lastTestAt: string | null
  readonly lastTestOk: boolean | null
  readonly lastTestError: string | null
  readonly lastTestLatencyMs: number | null
}

/** `list()` 的视图选择；默认 `full`（不破坏既有页面与测试）。 */
export interface AccountListOptions {
  readonly view?: 'lite' | 'full'
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
  /** `undefined` = 不改；`null` 或空数组 = 清空标签。 */
  readonly labels?: string[] | null
  /** `undefined` = 不改；`null` = 清空为未声明。 */
  readonly weight?: number | null
  /** `undefined` = 不改；`null` = 清空为未声明。 */
  readonly concurrency?: number | null
}

// ───────────────────────────── 批量操作 ─────────────────────────────

/** 批量操作单项失败：稳定 code + 可读消息（不含秘密）。 */
export interface BulkFailure {
  readonly code: string
  readonly message: string
}

/** 批量操作的一项结果：逐项成功或失败，互不阻塞。 */
export interface BulkOperationItemResult {
  readonly id: string
  readonly ok: boolean
  readonly account: AccountView | null
  readonly error: BulkFailure | null
}

/** 批量启用 / 停用 / 改字段的统一结果。 */
export interface BulkOperationResult {
  readonly total: number
  readonly succeeded: number
  readonly failed: number
  readonly items: readonly BulkOperationItemResult[]
}

/**
 * 批量改字段的输入：与单条 `update` 同形，**只提交声明过的字段**。
 * 关闭类字段用显式的 `null`（而不是省略键）。
 */
export type BulkUpdateInput = UpdateAccountInput

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
  /** 账号自己的上游地址；省略 = 用 provider 默认映射。 */
  readonly baseUrl?: string
  /** 上游端点协议；省略 = 未声明。 */
  readonly protocol?: AccountProtocol
  /** 这个账号服务的对外模型名。 */
  readonly models?: string[]
  /** 对外模型名 → 上游真实模型名。 */
  readonly modelMap?: Record<string, string>
  /** 优先级（0–1000）；省略 = identity 默认 0。 */
  readonly priority?: number
}

// ───────────────────────────── 连通性测试 ─────────────────────────────

/** 连通性测试参数；两者都可省略，省略时按账号自身声明推断。 */
export interface AccountTestInput {
  readonly model?: string
  readonly protocol?: string
}

/**
 * 一次连通性测试的结果。**没有凭据**：只有状态码、耗时与脱敏后的错误文本。
 * `status` 为 `null` 表示请求根本没拿到 HTTP 响应（网络错误 / 超时）。
 */
export interface AccountTestResult {
  readonly ok: boolean
  readonly status: number | null
  readonly latencyMs: number
  readonly model: string | null
  readonly protocol: AccountProtocol | null
  readonly error: string | null
  readonly testedAt: string
}

// ───────────────────────────── 导入来源 ─────────────────────────────

/** 支持的导入来源。`auto` 按 payload 形状推断。 */
export type AccountImportSourceFormat = 'auto' | 'new-api' | 'sub2api' | 'plain-keys'

/** 导入来源的默认值；目前只作用于 plain-keys（new-api / sub2api 自带字段）。 */
export interface AccountImportDefaults {
  readonly provider?: AccountProvider
  readonly kind?: AccountKind
  readonly baseUrl?: string
  readonly protocol?: AccountProtocol
  readonly enabled?: boolean
  readonly labelPrefix?: string
}

/** 导入来源的输入。`payload` 是原始文本；秘密只在其中，绝不进入任何返回值。 */
export interface AccountImportSourceInput {
  readonly source: AccountImportSourceFormat
  readonly payload: string
  readonly defaults?: AccountImportDefaults
}

/** 归一化后的一条待导入账号（内部形状；`payload` 是凭据，只交给 identity）。 */
export interface ParsedImportItem {
  /** 在本次解析结果里的位置（0 起，含失败项占位）。 */
  readonly index: number
  /** 在原始来源里的位置（渠道 / 账号 / 行号，0 起），用于错误信息。 */
  readonly sourceIndex: number
  readonly label?: string
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly baseUrl?: string
  readonly protocol?: AccountProtocol
  readonly models?: string[]
  readonly modelMap?: Record<string, string>
  readonly priority?: number
  readonly enabled?: boolean
  /** 凭据文本；可能是纯 key，也可能是 JSON。永不回显。 */
  readonly payload: string
  /** 被忽略的字段等非致命提示。 */
  readonly warnings: readonly string[]
}

/** 解析时某个来源项失败（不影响其它项）。 */
export interface ParsedImportIssue {
  readonly index: number
  readonly sourceIndex: number
  readonly code: string
  readonly message: string
}

/** `parseImportSource` 的结果：成功项与逐项失败分开，互不阻塞。 */
export interface ParsedImportSource {
  readonly source: Exclude<AccountImportSourceFormat, 'auto'>
  readonly items: readonly ParsedImportItem[]
  readonly issues: readonly ParsedImportIssue[]
  readonly warnings: readonly string[]
}

/** 导入来源预览的一条结果；不含凭据。 */
export interface AccountImportPreviewItem {
  readonly index: number
  readonly ok: boolean
  readonly label: string | null
  readonly provider: AccountProvider | null
  readonly kind: AccountKind | null
  readonly baseUrl: string | null
  readonly models: readonly string[] | null
  readonly error: string | null
}

/** 导入来源预览。 */
export interface AccountImportPreview {
  readonly source: Exclude<AccountImportSourceFormat, 'auto'>
  readonly total: number
  readonly items: readonly AccountImportPreviewItem[]
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
