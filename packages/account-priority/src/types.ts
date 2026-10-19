/**
 * 账号优先级模块的跨进程类型。
 *
 * 这些形状与 Go 侧 `modules/accountpriority` 和 `contracts` 中的 JSON 一一对应。
 * 两边各有校验：TS 在写盘前拒绝坏配置，Go 在应用前再校验一次（绝不部分应用）。
 */

export type AccountPriorityHealth = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
export type StrategySelection = 'rank' | 'weighted-random'
export type StrategyHealthPolicy = 'exclude_unhealthy' | 'require_healthy' | 'allow_all'
export type StrategyDirection = 'asc' | 'desc'

export interface FactorRule {
  /** 0 表示不启用该因子。 */
  readonly weight: number
  /** 只对 min-max 因子有效：desc（默认）/ asc。 */
  readonly direction?: StrategyDirection
  /** 原始值未知时的归一化分数，默认 0.5。 */
  readonly unknown?: number
}

export interface StrategyFilter {
  readonly providers?: readonly string[]
  readonly kinds?: readonly string[]
  readonly tags?: Readonly<Record<string, string>>
  readonly health?: StrategyHealthPolicy
  readonly excludeCooling?: boolean
  readonly excludeSaturated?: boolean
}

/** 与 Go 侧 StrategyGroup 同形。 */
export interface StrategyGroup {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly enabled?: boolean
  readonly filter?: StrategyFilter
  readonly factors: Readonly<Record<string, FactorRule>>
  readonly selection?: StrategySelection
  readonly tieBreaker?: readonly string[]
  readonly maxCandidates?: number
}

/**
 * 一个候选账号的快照。可空字段表达「未知」，不要用 0 冒充未知
 * （AGENTS.md D17：未知必须是一等状态）。
 */
export interface AccountCandidate {
  readonly accountId: string
  readonly provider: string
  readonly kind?: string
  readonly disabled?: boolean
  readonly priority?: number
  readonly weight?: number
  readonly health?: AccountPriorityHealth
  readonly tags?: Readonly<Record<string, string>>
  /** RFC3339 时间字符串。 */
  readonly cooldownUntil?: string
  readonly quotaRatio?: number
  readonly rateLimitRatio?: number
  readonly inFlight?: number
  readonly concurrency?: number
  /** RFC3339 时间字符串。 */
  readonly lastUsedAt?: string
  readonly successRate?: number
  readonly latencyP95Ms?: number
  readonly costMultiplier?: number
}

export interface ScoreRequest {
  readonly strategy?: string
  readonly candidates: readonly AccountCandidate[]
  /** 只收窄返回列表，0 表示不额外限制。 */
  readonly limit?: number
  /** RFC3339；为空取 Go 侧当前时间。 */
  readonly now?: string
  /** weighted-random 的可复现种子；必须是安全整数。 */
  readonly seed?: number
}

export interface ScoreFactor {
  readonly name: string
  readonly raw: number | null
  readonly normalized: number
  readonly weight: number
  readonly contribution: number
}

export interface ScoredAccount {
  readonly accountId: string
  readonly score: number
  readonly breakdown: readonly ScoreFactor[]
}

export interface ExcludedAccount {
  readonly accountId: string
  readonly reason: string
}

export interface ScoreResult {
  readonly strategy: string
  readonly revision: string
  readonly evaluatedAt: string
  readonly ranked: readonly ScoredAccount[]
  readonly excluded?: readonly ExcludedAccount[]
}

export interface RemoteStatus {
  readonly ready: boolean
  readonly revision: string
  readonly defaultStrategy: string
  readonly strategies: number
  readonly startedAt: string
  readonly scored: number
  readonly picked: number
  readonly candidatesMax: number
  /** Go 侧缓存的账号快照数量（不含任何令牌）。 */
  readonly accounts?: number
}

/**
 * identity → Go 的只读账号/令牌快照。
 *
 * 帧里含访问令牌，因此它只走控制桥；响应、日志、状态查询都不得回显 accounts。
 * 权威数据仍在 TS 的 identity 与 credentials 里。
 */
export interface GatewayAccountSnapshot {
  readonly version: 1
  readonly generation: string
  readonly accounts: readonly GatewayAccount[]
}

export interface GatewayAccount {
  readonly accountId: string
  readonly provider: string
  readonly kind: string
  /** 上游 OpenAI 兼容 base URL（不含 /chat/completions）。 */
  readonly baseUrl: string
  readonly token: string
  readonly expiresAt?: string
  readonly priority?: number
  readonly tags?: Readonly<Record<string, string>>
}

export interface GatewayAccountsResult {
  readonly revision: string
  readonly accounts: number
  readonly updatedAt: string
}

/**
 * api-key → Go 的只读哈希快照。
 *
 * 帧里只有 sha256 哈希，没有明文或掩码；响应、日志与状态查询都不得回显 keys。
 * 权威数据仍在 TS 的 api-key 插件（SQLite）里。
 */
export interface GatewayKeySnapshot {
  readonly version: 1
  readonly generation: number
  readonly keys: readonly GatewayKey[]
}

export interface GatewayKey {
  readonly keyId: string
  readonly userId: number
  readonly keyHash: string
  readonly profile: string
  readonly name: string
}

/** Go 对 keys.replace 的确认：只有 revision / 计数 / 时间。 */
export interface GatewayKeysResult {
  readonly revision: string
  readonly keys: number
  readonly updatedAt: string
}

/** Go 的 keys.status 响应；同样不含哈希。 */
export interface GatewayKeysStatus {
  readonly revision: string
  readonly keys: number
  readonly updatedAt: string
}

export interface StrategyListResult {
  readonly revision: string
  readonly defaultStrategy: string
  readonly strategies: readonly StrategyGroup[]
}

export interface ReplaceStrategiesResult {
  readonly revision: string
  readonly strategies: number
  readonly defaultStrategy: string
}

/**
 * TS 管理面看到的监管状态。它与 Go 的 RemoteStatus 不同：
 * 前者描述「进程/桥接得怎么样」，后者描述「Go 模块内部的计数」。
 */
export type ChildState = 'stopped' | 'starting' | 'ready' | 'degraded' | 'stopping' | 'failed'

export interface AccountPriorityStatus {
  readonly state: ChildState
  readonly pid: number | null
  readonly transport: 'unix' | 'tcp' | null
  readonly address: string | null
  readonly bridgeConnected: boolean
  readonly revision: string | null
  readonly defaultStrategy: string | null
  readonly strategies: number
  /** 最近一次成功推送给 Go 的账号数量。 */
  readonly accounts: number
  /** Go 侧账号快照的 revision（内容哈希）。 */
  readonly accountsRevision: string | null
  /** 最近一次成功推送给 Go 的 API key 数量。 */
  readonly keys: number
  /** Go 侧 API key 快照的 revision（内容哈希）。 */
  readonly keysRevision: string | null
  readonly restarts: number
  readonly lastError: string | null
  readonly startedAt: string | null
}

export interface StrategyListSnapshot {
  readonly revision: string | null
  readonly defaultStrategy: string | null
  readonly strategies: readonly StrategyGroup[]
}

/** 与 Go 侧 DefaultStrategy 保持一致的内置策略。 */
export const DEFAULT_STRATEGY: StrategyGroup = {
  id: 'default',
  name: '默认',
  enabled: true,
  filter: {
    health: 'exclude_unhealthy',
    excludeCooling: true,
    excludeSaturated: true,
  },
  factors: {
    health: { weight: 30, unknown: 0.3 },
    quota: { weight: 20 },
    rateLimit: { weight: 10 },
    headroom: { weight: 10 },
    priority: { weight: 10 },
    capacity: { weight: 10 },
    success: { weight: 5 },
    latency: { weight: 3, direction: 'asc' },
    cost: { weight: 2, direction: 'asc' },
  },
  selection: 'rank',
  tieBreaker: ['priority', 'accountId'],
}
