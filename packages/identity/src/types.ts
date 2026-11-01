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

/**
 * 上游端点说哪种协议；协议转换中间件按它决定怎么翻译请求。
 * `null` = 未声明，走旧行为（兼容存量账号）。
 */
export type IdentityProtocol = 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'

/** 订阅账号（OAuth，可以刷新）与外部 API（只有静态 key）。 */
export type IdentityAccountKind = 'oauth' | 'api_key'

/**
 * `active`：正常参与调度；`needs_reauth`：RT 已失效或被撤销，等人工重新导入；
 * `auto_disabled`：健康检查连续失败后由系统自动停用，一次成功即恢复。
 *
 * 三种语义是分开的：人的停用是 `enabled = false`，凭据失效是 `needs_reauth`，
 * 系统自动停用是 `auto_disabled`。自动化只碰 `auto_disabled`，绝不覆盖人的开关。
 */
export type IdentityAccountStatus = 'active' | 'needs_reauth' | 'auto_disabled'

/**
 * 健康状态。取值与 Go 侧 `contracts.HealthState` 一一对应：
 * `unknown` / `healthy` / `degraded` / `unhealthy`。**未知是一等状态，不是「默认健康」**。
 */
export type IdentityHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'

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
  /** 该账号自己的 OpenAI 兼容 base URL；`null` = 用 account-priority 的 provider 默认值。 */
  readonly baseUrl: string | null
  /** 上游端点的协议；`null` = 未声明（走旧行为）。 */
  readonly protocol: IdentityProtocol | null
  /** 这个账号服务的**对外**模型名。`null` / 空 = 未声明（不参与按模型过滤，任何模型都可能落到它）。 */
  readonly models: string[] | null
  /** 对外模型名 → 上游真实模型名。`null` / 空 = 不改写模型名。 */
  readonly modelMap: Record<string, string> | null
  /**
   * 客户端指纹档案 id（`clientMask` 插件里的一档，如 `opencode`）。
   * `null` = 不伪装（等价于没挂档案）。**这里存 id，不存头**：
   * 头由 `account-priority` 在推快照时向 `clientMask` 解析，账号文件里不复制一份（防两处漂移）。
   */
  readonly clientProfile: string | null
  /** 该账号在 account-priority 评分里的 priority 因子；默认 0。 */
  readonly priority: number
  /**
   * 多标签数组（取代「分组实体」）。空数组 = 未打标签。
   * Go 侧 `Filter.Tags` 是精确匹配的 `map<string, string>`，由 account-priority
   * 按约定把 label 转成 tag（见该插件的 `labelsToTags`）。
   */
  readonly labels: string[]
  /** 权重（> 0）；`null` = 未声明，Go 侧按「未知」处理。 */
  readonly weight: number | null
  /** 并发上限（>= 1）；`null` = 未声明。 */
  readonly concurrency: number | null
  /** 健康状态；未知是一等状态，默认 `unknown`。 */
  readonly health: IdentityHealth
  /** 自动停用的时间（ISO）；未自动停用时为 `null`。 */
  readonly autoDisabledAt: string | null
  /** 自动停用的原因（已脱敏）；未自动停用时为 `null`。 */
  readonly autoDisabledReason: string | null
  /** 最近一次被 LLM 请求使用的时间（ISO）；由 usage 事件节流回报。 */
  readonly lastUsedAt: string | null
  /** 访问令牌过期时间（ISO）；`null` = 尚未导入令牌。 */
  readonly accessExpiresAt: string | null
  /** 下一次应该尝试刷新的时间；`null` = 不需要刷新（api_key）。 */
  readonly refreshDueAt: string | null
  readonly lastRefreshAt: string | null
  readonly lastError: string | null
  readonly failureCount: number
  /** 退避截止时间；在此之前调度器不碰它。 */
  readonly backoffUntil: string | null
  /** 最近一次连通性测试的时间（ISO）；`null` = 从未测试。 */
  readonly lastTestAt: string | null
  /** 最近一次测试是否成功；`null` = 从未测试。 */
  readonly lastTestOk: boolean | null
  /** 最近一次测试的失败原因（已脱敏）；成功或从未测试时为 `null`。 */
  readonly lastTestError: string | null
  /** 最近一次测试的耗时（毫秒）；`null` = 从未测试。 */
  readonly lastTestLatencyMs: number | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** 一次连通性测试的结果；只落「有没有通、多久、为什么失败」，不含任何凭据。 */
export interface IdentityTestResult {
  readonly ok: boolean
  readonly latencyMs: number
  readonly error: string | null
  /** ISO 时间；缺失时由 identity 用当前时间补齐。 */
  readonly testedAt?: string
}

/** 新建账号的输入。secret 会写进 credentials，不会进账号文件。 */
export interface CreateIdentityAccountInput {
  readonly provider: IdentityProvider
  readonly kind: IdentityAccountKind
  readonly label: string
  readonly email?: string
  readonly subject?: string
  readonly baseUrl?: string
  readonly protocol?: IdentityProtocol
  /** 这个账号服务的对外模型名；空数组与未声明等价。 */
  readonly models?: string[]
  /** 对外模型名 → 上游真实模型名；空对象与未声明等价。 */
  readonly modelMap?: Record<string, string>
  /** 客户端指纹档案 id（`clientMask` 里的一档）；不传 = 不伪装。 */
  readonly clientProfile?: string
  readonly priority?: number
  readonly enabled?: boolean
  readonly secret?: IdentityTokenBundle
}

/** 可运行期修改的非秘密元数据。 */
export interface UpdateIdentityAccountInput {
  readonly label?: string
  readonly email?: string | null
  readonly subject?: string | null
  readonly baseUrl?: string | null
  /** `undefined` = 不改；`null` = 清空为未声明。 */
  readonly protocol?: IdentityProtocol | null
  /** `undefined` = 不改；`null` 或空数组 = 清空为未声明。 */
  readonly models?: string[] | null
  /** `undefined` = 不改；`null` 或空对象 = 清空为不改写。 */
  readonly modelMap?: Record<string, string> | null
  /** `undefined` = 不改；`null` 或空串 = 清空为「不伪装」。 */
  readonly clientProfile?: string | null
  readonly priority?: number
  /** `undefined` = 不改；`null` 或空数组 = 清空标签。 */
  readonly labels?: string[] | null
  /** `undefined` = 不改；`null` = 清空为未声明。 */
  readonly weight?: number | null
  /** `undefined` = 不改；`null` = 清空为未声明。 */
  readonly concurrency?: number | null
  readonly enabled?: boolean
}

/** 一次刷新尝试的结果，供服务内部与测试使用。 */
export interface IdentityRefreshResult {
  readonly account: IdentityAccount
  readonly refreshed: boolean
}
