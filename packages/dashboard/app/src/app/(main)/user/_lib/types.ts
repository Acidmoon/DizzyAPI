/**
 * 用户侧页面用到的 DTO 类型 —— **契约来源是 `packages/api/src/views/*.ts` 与 `routes/*.ts`**，
 * 字段名与顺序逐字对齐，别在这里「顺手改名」。
 *
 * 为什么现在是一份手抄：Next 工程（`packages/dashboard/app/`）是独立 npm 工程，
 * 拿不到 `packages/api` 的 workspace 包；`交互` 的阶段 2 数据层（`packages/dashboard/src/lib/api/`）
 * 落地后，这些类型应当改成从他那边 re-export，本地只留页面私有的视图模型。
 *
 * TODO(契约): 等 `packages/dashboard/src/lib/api/types.ts` 合进来后，删掉本文件的 DTO 定义，
 * 改成 `export type { ... } from "@dizzyapi/plugin-dashboard/lib/api/types"`（或等价的别名）。
 */

// ───────────────────────────────── 会话 ─────────────────────────────────

/** `GET /api/session` → `user`（`views/session.ts` 的 `sessionUserOf`）。 */
export interface SessionUser {
  readonly id: number
  readonly name: string
  readonly status: string
  readonly role: 'admin' | 'user'
  /** 管理员永远 true；普通用户由后台开关决定，关掉时 `balanceCents` 为 null。 */
  readonly balanceEnabled: boolean
  readonly balanceCents: number | null
  readonly avatar: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface SessionInfo {
  readonly id: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
}

export interface SessionResponse {
  readonly user: SessionUser
  readonly email: string | null
  readonly session: SessionInfo
  readonly permissions: { readonly admin: boolean }
}

// ───────────────────────────────── 用量 ─────────────────────────────────

/** `views/usage.ts` 的 `usageTotalsOf`：`costMicros` 是精确值，`costCents` 只给图表的粗口径。 */
export interface UsageTotals {
  readonly requests: number
  readonly tokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costCents: number
  readonly costMicros: string
}

export interface UsageDailyPoint extends UsageTotals {
  readonly date: string
}

export interface UsageModelRow extends UsageTotals {
  readonly model: string
}

/** 列表行（`usageRowOf`）：用户面拿不到 account / profile / attempts。 */
export interface UsageRecord {
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

/** 单条详情（`usageDetailOf`）：比列表多四个字段，`ttftMs` 旧记录是 null。 */
export interface UsageDetail extends Omit<UsageRecord, 'totalTokens'> {
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly usagePresent: boolean
  readonly usageComplete: boolean
  readonly ttftMs: number | null
}

export interface UsageResponse {
  readonly range: UsageRange
  readonly from: string
  readonly to: string
  readonly apiKeyId: string | null
  /** 余额只按当前用户换算；`spentCents` 恒 0（历史消费看明细）。 */
  readonly balances: {
    readonly paidCents: number
    readonly grantedCents: number
    readonly spentCents: number
  }
  readonly totals: UsageTotals
  readonly daily: readonly UsageDailyPoint[]
  readonly models: readonly UsageModelRow[]
  readonly records: { readonly items: readonly UsageRecord[]; readonly nextCursor: number | null }
  readonly pricingAvailable: boolean
  readonly generatedAt: string
}

/** `USAGE_RANGE_DAYS` 只有这三档（网页上的「今天 / 昨天」旧口径不在 API 里）。 */
export type UsageRange = '7d' | '30d' | '90d'

export interface UsageQuery {
  readonly range: UsageRange
  readonly apiKeyId?: string
  readonly model?: string
  readonly cursor?: number
  readonly limit?: number
}

// ───────────────────────────────── API key ─────────────────────────────────

/** `views/account.ts` 的 `normalizeKeySummary`。 */
export interface ApiKeySummary {
  readonly id: string
  readonly name: string
  readonly trackingId: string
  /** 只有 create / rotate 的响应当次带明文，其余恒 null。 */
  readonly secret: string | null
  readonly maskedKey: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly appManaged: boolean
  readonly enabled: boolean
  readonly expiresAt: string | null
  readonly spendingLimitMicros: string | null
  readonly concurrencyLimit: number | null
}

export type ApiKeyWithSecret = ApiKeySummary & { readonly secret: string }

export interface ApiKeyPatch {
  readonly name?: string
  readonly enabled?: boolean
  readonly expiresAt?: string | null
  readonly spendingLimitMicros?: string | null
  readonly concurrencyLimit?: number | null
}

// ───────────────────────────────── 价格 ─────────────────────────────────

/**
 * `GET /api/pricing` 的一项（`routes/pricing.ts` 的 `viewOf`）。
 *
 * 单价是**每百万 token 的「元」**，服务端给十进制字符串；页面**只读展示**，
 * 不做任何换算（要展示成别的口径就得乘除，那属于管理台与后端的事）。
 */
export interface ModelPrice {
  readonly model: string
  readonly inputPerMillion: string | number
  readonly outputPerMillion: string | number
  readonly cacheReadPerMillion: string | number
  readonly cacheWritePerMillion: string | number
  readonly currency: 'CNY'
  readonly updatedAt: string
}

export interface PricingResponse {
  readonly items: readonly ModelPrice[]
}
