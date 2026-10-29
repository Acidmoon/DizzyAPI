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

/**
 * Go 侧账号运行时的**全站聚合**计数（`accounts.status` 的只增字段 `runtime`）。
 *
 * 只有两个整数：正在处理的请求数、处于短期冷却的账号数。**没有账号级明细、没有秘密**，
 * 也不适合进一步下钻——它存在的意义是给运维页看一眼「现在堵不堵」。
 */
export interface AccountsRuntimeSummary {
  readonly active: number
  readonly cooling: number
}

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
 * 余额只读快照的一条（额度闸门用）。
 *
 * 余额用十进制最小单位字符串：JSON 承载不了 bigint，也不经过浮点；允许为负
 * （后付费透支）。它只在桥帧里流动，不进日志、不进状态查询。
 */
export interface GatewayQuotaEntry {
  readonly userId: string
  readonly balanceMicros: string
}

/** `user` 插件推给 Go 的只读余额快照。 */
export interface GatewayQuotaSnapshot {
  readonly version: 1
  /** 单调递增的推送序号：Go 用它拒绝回退，旧快照绝不能覆盖新余额。 */
  readonly generation: number
  /** entries 的内容哈希，用于日志与幂等重试识别。 */
  readonly revision: string
  readonly entries: readonly GatewayQuotaEntry[]
}

/** `quota.replace` 的响应：只有版本与计数，不含任何余额。 */
export interface GatewayQuotaResult {
  readonly ready: boolean
  readonly revision: string
  readonly generation: number
  readonly entries: number
  readonly updatedAt: string
}

/** `quota.status` 的响应：只给健康度，不给账号级余额明细。 */
export interface GatewayQuotaStatus {
  readonly ready: boolean
  readonly revision?: string
  readonly generation?: number
  readonly size: number
  readonly updatedAt?: string
  readonly ageMs: number
  readonly ttlMs: number
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
  /** 上游端点协议；账号没声明时不带这个键，保持旧快照形状。 */
  readonly protocol?: string
  /** 这个账号服务的对外模型名；账号没声明时不带这个键，保持旧快照形状。 */
  readonly models?: readonly string[]
  /** 对外模型名 → 上游真实模型名；账号没声明时不带这个键。 */
  readonly modelMap?: Readonly<Record<string, string>>
  readonly token: string
  readonly expiresAt?: string
  readonly priority?: number
  /** 账号标签转成的 Go tags（`map<string,string>`，精确匹配）；账号没打标签时不带这个键。 */
  readonly tags?: Readonly<Record<string, string>>
  /** 权重（> 0）；账号没声明时不带这个键，Go 侧按「未知」处理。 */
  readonly weight?: number
  /** 并发上限（>= 1）；账号没声明时不带这个键。 */
  readonly concurrency?: number
  /** 健康状态；账号没声明时不带这个键，Go 侧按 unknown 处理。 */
  readonly health?: AccountPriorityHealth
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

// ───────────────────────────────── 用量上行 ─────────────────────────────────

/**
 * Go 环形缓冲里的一条用量记录（控制消息载荷）。
 *
 * 字段与 `contracts/usage.go` 的 `UsageRecord` 一一对应；这里只声明形状，
 * 真正的校验与落库在 usage 插件里做（桥只负责搬运）。
 */
export interface UsageSinceRecord {
  readonly seq: number
  readonly epoch: string
  readonly requestId: string
  readonly userId: string
  readonly keyId: string
  readonly keyName: string
  readonly profile?: string
  readonly accountId?: string
  readonly model: string
  readonly upstreamModel?: string
  readonly protocol?: string
  readonly upstreamProtocol?: string
  readonly stream: boolean
  readonly status: number
  readonly errorCode?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly usagePresent: boolean
  readonly usageComplete: boolean
  readonly durationMs: number
  readonly clientIp?: string
  readonly attempts?: number
  readonly startedAt: string
}

/** `usage.since` 的返回：一段连续记录 + 当前 epoch 与序号边界。 */
export interface UsageSinceResult {
  readonly epoch: string
  readonly firstSeq: number
  readonly lastSeq: number
  /** 因环形缓冲回绕而丢弃的累计条数；调用方据此记 gap 警告。 */
  readonly dropped: number
  readonly records: readonly UsageSinceRecord[]
}

/**
 * `usage.stats` 的返回：Go 环形缓冲的容量与投递健康度（都是整数）。
 *
 * `dropped` 是回绕覆盖的累计条数（含已被取走的 churn）；
 * `gap` 只统计「覆盖时还没有任何 reader 取走」的记录——那才是真正读不回来的数据。
 * 调用方用 `gap` 的增长做告警，用 `size/capacity` 判断缓冲是否太小。
 */
export interface UsageStatsResult {
  readonly epoch: string
  readonly capacity: number
  readonly size: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly dropped: number
  readonly gap: number
}

/**
 * 内容审核规则快照（TS → Go，桥命令 `contentaudit.replace`）。
 *
 * 规则是控制面数据、不含秘密；Go 侧只读、预编译成小写后做子串匹配。
 * `enabled:false` 表示审核整体关闭：rules 必须为空，Go 侧立刻回到全放行。
 */
export interface GatewayContentAuditRule {
  readonly id: string
  readonly pattern: string
  readonly action: 'block' | 'log'
  readonly category?: string
}

export interface GatewayContentAuditSnapshot {
  readonly version: 1
  readonly generation: number
  readonly revision: string
  readonly enabled: boolean
  readonly rules: readonly GatewayContentAuditRule[]
}

/** `contentaudit.replace` 的响应（不含规则内容）。 */
export interface GatewayContentAuditResult {
  readonly ready: boolean
  readonly revision: string
  readonly generation: number
  readonly rules: number
  readonly enabled: boolean
  readonly updatedAt: string
}

/** `contentaudit.status` 的响应：缓存健康度 + 闸门计数与命中统计（无被审文本）。 */
export interface GatewayContentAuditStatus {
  readonly ready: boolean
  readonly revision?: string
  readonly generation?: number
  readonly size: number
  readonly enabled: boolean
  readonly updatedAt?: string
  readonly ageMs: number
  readonly ttlMs: number
  readonly stale?: boolean
  readonly gate?: {
    readonly blocked?: number
    readonly logged?: number
    readonly allowedStale?: number
    readonly strictFailed?: number
    readonly parseFailed?: number
    readonly noText?: number
    readonly truncated?: number
    readonly staleStreak?: number
    readonly staleReason?: string
    readonly staleForMs?: number
    readonly ruleHitTotal?: number
    readonly ruleHits?: Readonly<Record<string, number>>
  }
}
