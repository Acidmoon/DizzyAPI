/**
 * 用量（用户侧 + 管理面）。
 *
 * 服务端来源：`views/usage.ts` 的 `usageTotalsOf()` / `usageRowOf()` /
 * `usageDetailOf()` / `adminUsageRowOf()` / `rejectedRowOf()`，
 * 以及 `routes/usage.ts`（`GET /api/usage`）与 `routes/admin_usage.ts` 的响应装配。
 *
 * 三条必须记住的口径：
 * 1. **金额一律是十进制字符串**（`costMicros`），前端不做浮点运算。
 * 2. `costCents` 是给图表的**粗口径**（服务端已把微元整除成整数分），精确值只看 `costMicros`。
 * 3. 用户侧列表行**没有** `ttftMs` / `reasoningTokens` / `usagePresent` —— 只有详情行有；
 *    用户侧也**永远拿不到** `accountId` / `profile` / `attempts`（那是管理面字段）。
 */

/** 用量汇总（`usageTotalsOf()`）。 */
export interface UsageTotalsView {
  readonly requests: number
  /** 四个桶之和。 */
  readonly tokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  /** 粗口径费用（整数分），只给图表用。 */
  readonly costCents: number
  /** 精确费用（整数微元的十进制字符串，1 元 = 1_000_000 微元）。 */
  readonly costMicros: string
}

/** 按天聚合（`usageDailyOf()`）。 */
export interface UsageDailyView extends UsageTotalsView {
  readonly date: string
}

/** 按模型聚合（`usageModelOf()`）。 */
export interface UsageModelView extends UsageTotalsView {
  readonly model: string
}

/** 按用户聚合（`usageUserOf()`，只出现在管理概览的 Top 用户里）。 */
export interface UsageUserView extends UsageTotalsView {
  readonly userId: number
  readonly name: string | null
}

/** 用户侧用量明细一行（`usageRowOf()`）。 */
export interface UsageRowView {
  readonly id: number
  readonly reqId: string
  readonly userId: number
  readonly apiKeyId: string
  readonly apiKeyName: string
  readonly model: string
  readonly upstreamModel: string | null
  readonly protocol: string
  readonly upstreamProtocol: string | null
  readonly stream: boolean
  readonly status: number
  readonly errorCode: string | null
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly durationMs: number
  readonly clientIp: string | null
  readonly startedAt: string
  readonly costMicros: string
}

/** 单条详情（`usageDetailOf()`）：列表行 + 这四个字段。 */
export interface UsageDetailRowView extends UsageRowView {
  readonly reasoningTokens: number
  readonly usagePresent: boolean
  readonly usageComplete: boolean
  /** 首字延迟；**没采集到时是 `null`，不是 0**。 */
  readonly ttftMs: number | null
}

/** `GET /api/usage/:reqId` 的响应。 */
export interface UsageDetailView {
  readonly record: UsageDetailRowView
}

/** `GET /api/usage` 的响应（概览 + 明细第一页）。 */
export interface UsageView {
  readonly range: string
  readonly from: string
  readonly to: string
  readonly apiKeyId: string | null
  readonly balances: {
    /** 当前余额（整数分）。 */
    readonly paidCents: number
    /** 服务端目前恒为 0（历史消费由明细体现，不伪造）。 */
    readonly grantedCents: number
    /** 同上，恒为 0。 */
    readonly spentCents: number
  }
  readonly totals: UsageTotalsView
  readonly daily: readonly UsageDailyView[]
  readonly models: readonly UsageModelView[]
  readonly records: {
    readonly items: readonly UsageRowView[]
    /** **keyset 游标**：下一页就把这个值当 `cursor` 传回去；`null` = 没有下一页。 */
    readonly nextCursor: number | null
  }
  readonly pricingAvailable: boolean
  readonly generatedAt: string
}

/** `GET /api/usage/export` 与 `/api/admin/usage/export` 的响应（浏览器自己拼 Blob）。 */
export interface UsageExportView {
  readonly filename: string
  readonly content: string
}

/** 管理面明细行（`adminUsageRowOf()`）：用户侧字段 + 这三个。 */
export interface AdminUsageRowView extends UsageRowView {
  readonly userName: string | null
  readonly accountId: string
  readonly attempts: number
}

/** 用量隔离区一行（`rejectedRowOf()`）。被隔离的记录**不结算、不扣钱**。 */
export interface AdminRejectedRowView {
  readonly reqId: string
  readonly epoch: string
  readonly seq: number
  readonly payload: string
  readonly error: string
  readonly failures: number
  readonly status: string
  readonly firstFailedAt: string
  readonly updatedAt: string
}

/** `GET /api/admin/usage` 的响应。 */
export interface AdminUsageView {
  readonly range: string
  readonly from: string
  readonly to: string
  readonly totals: UsageTotalsView
  readonly daily: readonly UsageDailyView[]
  readonly models: readonly UsageModelView[]
  readonly records: {
    readonly items: readonly AdminUsageRowView[]
    readonly nextCursor: number | null
  }
  /** 主接口只给隔离区第一页 + 计数；完整分页在 `/api/admin/usage/rejected`。 */
  readonly rejected: {
    readonly items: readonly AdminRejectedRowView[]
    readonly total: number
    readonly pending: number
  }
  readonly pricingAvailable: boolean
  readonly generatedAt: string
}

/** `GET /api/admin/usage/rejected` 的响应。 */
export interface AdminRejectedPageView {
  readonly items: readonly AdminRejectedRowView[]
  readonly total: number
  readonly pending: number
}
