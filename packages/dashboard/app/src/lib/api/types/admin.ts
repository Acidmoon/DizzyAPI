/**
 * 管理面：用户 / 上游账号 / 审计 / 概览 / 内容审核 / 运维总览。
 *
 * 服务端来源：`views/session.ts`（`adminUserOf`）、`views/account.ts`（`accountOf`）、
 * `routes/admin_audit.ts`、`routes/admin_stats.ts`、`views/audit.ts`（`contentAuditRuleOf` /
 * `contentAuditStatusOf`）、`packages/observability/src/types.ts`（`ObservabilityReport`）。
 *
 * 路径注意：管理员的**用户**与**上游账号**挂在 `/api/users`、`/api/accounts`
 * （**不带 `admin` 前缀**），但都要管理员权限。
 */
import type { AccountViewLike, AdminUserView } from '@dizzyapi/plugin-api/types'

import type { UsageDailyView, UsageModelView, UsageTotalsView, UsageUserView } from './usage.ts'

export type { AccountViewLike, AdminUserView, UserStatusLike } from '@dizzyapi/plugin-api/types'

// ───────────────────────────── 用户 ─────────────────────────────

/** `GET /api/users` 的响应。 */
export interface AdminUserListView {
  readonly items: readonly AdminUserView[]
}

/** `POST /api/users/:id/balance` 的响应（余额是十进制字符串）。 */
export interface BalanceAdjustmentView {
  readonly balanceMinor: string
}

// ───────────────────────────── 上游账号 ─────────────────────────────

/** `GET /api/accounts` 的响应（游标是**偏移量的字符串**，不是 keyset）。 */
export interface AccountListView {
  readonly items: readonly AccountViewLike[]
  readonly nextCursor: string | null
}

// ───────────────────────────── 审计 ─────────────────────────────

/** 审计条目（`AuditRecordLike`；`metadata` 已脱敏）。 */
export interface AuditRecordView {
  readonly id: number
  readonly at: string
  readonly atMs: number
  readonly actor: string
  readonly actorPlugin: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly summary: string
  readonly metadata: Readonly<Record<string, unknown>> | null
  readonly result: 'ok' | 'failed'
  readonly errorCode: string | null
}

/** 审计汇总（只有 `?stats=1` 时才出现）。 */
export interface AuditStatsView {
  readonly total: number
  readonly today: number
  readonly last24h: number
  readonly failed: number
  readonly lastAt: string | null
  readonly byAction: readonly { readonly action: string; readonly count: number }[]
  readonly byActor: readonly { readonly actor: string; readonly count: number }[]
}

/** `GET /api/admin/audit` 的响应。 */
export interface AdminAuditView {
  readonly items: readonly AuditRecordView[]
  readonly total: number
  readonly offset: number
  readonly limit: number
  /** 带 `?stats=1` 才有。 */
  readonly stats?: AuditStatsView
}

// ───────────────────────────── 管理概览 ─────────────────────────────

/** `GET /api/admin/stats` 里的用量块；用量插件缺席时整块是 `null`。 */
export interface AdminStatsUsageView {
  readonly today: UsageTotalsView
  readonly total: UsageTotalsView
  readonly series: readonly UsageDailyView[]
  readonly models: readonly UsageModelView[]
  readonly topUsers: readonly UsageUserView[]
}

/** `GET /api/admin/stats` 的响应。 */
export interface AdminStatsView {
  readonly generatedAt: string
  readonly users: {
    readonly total: number
    readonly admins: number
    readonly enabled: number
    readonly banned: number
  }
  readonly accounts: {
    readonly total: number
    readonly enabled: number
    readonly disabled: number
    readonly needsReauth: number
  }
  readonly keys: {
    readonly total: number
    readonly enabled: number
    readonly disabled: number
  }
  readonly usage: AdminStatsUsageView | null
}

// ───────────────────────────── 内容审核 ─────────────────────────────

/** 一条审核规则（`contentAuditRuleOf()`）。**`pattern` 是关键词，子串匹配、不区分大小写。** */
export interface ContentAuditRuleView {
  readonly id: string
  readonly pattern: string
  readonly action: 'block' | 'log'
  readonly category: string | null
  readonly enabled: boolean
  readonly note: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * Go 侧命中统计（`packages/content-audit/src/types.ts` 的 `ContentAuditHits`）。
 *
 * 带一个 `readonly [key: string]: unknown` 索引签名：服务端把它当**白名单字典**发，
 * 有了它，下面的字段保留精确类型，同时「把整份 hits 当字典读」的调用点
 * （管理台 `contentAuditHitsOf(status.hits)` 那层运行时收窄）继续成立。
 * 等管理台把那层运行时收窄删掉之后，这个索引签名可以一并去掉。
 */
export interface ContentAuditHitsView {
  readonly [key: string]: unknown
  readonly blocked: number
  readonly logged: number
  readonly allowedStale: number
  readonly strictFailed: number
  readonly parseFailed: number
  readonly noText: number
  readonly truncated: number
  readonly ruleHitTotal: number
  /** 按规则 id 的命中次数。 */
  readonly byRule: Readonly<Record<string, number>>
  readonly staleStreak: number
}

/**
 * 审核快照状态（`contentAuditStatusOf()`；白名单键）。
 *
 * **形状依据服务端** `packages/content-audit/src/types.ts` 的 `ContentAuditStatus`：
 * 服务端把 `null` 原样透传（「读不到」与「读到了 false」是两件事），所以下面
 * 几个字段是 **可空**的：
 * - `revision`：还没成功推过是 `null`（不是 `0`）；
 * - `ageMs` / `ttlMs` / `stale` / `goReady`：Go 侧读不到是 `null`；
 * - `hits`：Go 侧读不到是 `null`。
 */
export interface ContentAuditStatusView {
  readonly enabled: boolean
  readonly pushIntervalMs: number
  readonly ruleCount: number
  /** 当前推给 Go 的 revision；还没成功推过为 `null`。 */
  readonly revision: string | null
  readonly generation: number
  /** Go 侧快照年龄 / TTL；读不到为 `null`。 */
  readonly ageMs: number | null
  readonly ttlMs: number | null
  /** Go 侧快照是否过期；读不到为 `null`。 */
  readonly stale: boolean | null
  readonly goReady: boolean | null
  readonly lastPushAt: string | null
  readonly lastError: string | null
  readonly pushes: number
  readonly heartbeats: number
  readonly failureStreak: number
  readonly goTtlMs: number | null
  readonly heartbeatTooSlow: boolean
  /** Go 侧命中统计；读不到是 `null`。 */
  readonly hits: ContentAuditHitsView | null
}

/** `GET /api/admin/content-audit` 的响应。 */
export interface AdminContentAuditView {
  readonly items: readonly ContentAuditRuleView[]
  readonly status: ContentAuditStatusView
}

// ───────────────────────────── 运维总览 ─────────────────────────────

/** 数据源健康（`ok` / `degraded` / `unavailable`）。 */
export interface SourceHealthView {
  readonly state: 'ok' | 'degraded' | 'unavailable'
  readonly detail: string
}

/**
 * `GET /api/admin/observability` 的响应。
 *
 * 服务端**直接透传** `ObservabilityReport`（已经 JSON 友好：金额是字符串、无 bigint、
 * 无账号 id / label / baseUrl / 秘密）。任一数据源缺席只降级那一块，HTTP 仍 200；
 * 只有聚合插件本身缺席才 503 `OBSERVABILITY_UNAVAILABLE`。
 */
export interface AdminObservabilityView {
  readonly generatedAt: string
  readonly usage: {
    readonly health: SourceHealthView
    readonly service: {
      readonly records: number
      readonly polling: boolean
      readonly consecutiveFailures: number
      readonly lastError: string | null
      readonly gapRecords: number
      readonly rejectedCount: number
      readonly rejectedPending: number
      readonly pricingAvailable: boolean
      readonly epoch: string | null
      readonly lastSeq: number
    } | null
    readonly gateway: {
      readonly epoch: string
      readonly capacity: number
      readonly size: number
      readonly firstSeq: number
      readonly lastSeq: number
      readonly dropped: number
      readonly gap: number
    } | null
    readonly gatewayHealth: SourceHealthView
  }
  readonly billing: {
    readonly health: SourceHealthView
    readonly totals: {
      readonly records: number
      readonly settled: number
      readonly pending: number
      readonly settling: number
      readonly noPrice: number
      readonly noUser: number
      readonly failed: number
      readonly review: number
      readonly overdrawn: number
    } | null
    readonly chargedMicros: string | null
    readonly today: {
      readonly date: string
      readonly settled: number
      readonly chargedMicros: string
    } | null
  }
  readonly quota: {
    readonly health: SourceHealthView
    readonly ready: boolean | null
    readonly revision: string | null
    readonly generation: number | null
    readonly size: number | null
    readonly ageMs: number | null
    readonly ttlMs: number | null
    readonly stale: boolean | null
  }
  readonly runtime: {
    readonly health: SourceHealthView
    readonly active: number | null
    readonly cooling: number | null
  }
  readonly audit: {
    readonly health: SourceHealthView
    readonly total: number
    readonly failed: number
    readonly lastAt: string | null
    readonly recentActions: readonly { readonly action: string; readonly count: number }[]
    readonly windowLimit: number
    readonly windowTruncated: boolean
    readonly latest: readonly {
      readonly at: string
      readonly actor: string
      readonly action: string
      readonly targetType: string
      readonly targetId: string
      readonly summary: string
      readonly result: 'ok' | 'failed'
      readonly errorCode: string | null
    }[]
  }
  readonly accounts: {
    readonly health: SourceHealthView
    readonly total: number
    readonly enabled: number
    readonly unknown: number
    readonly healthy: number
    readonly degraded: number
    readonly unhealthy: number
    readonly autoDisabled: number
    readonly lastPass: {
      readonly checked: number
      readonly healthy: number
      readonly failed: number
      readonly autoDisabled: number
      readonly autoEnabled: number
    } | null
    readonly lastPassAt: string | null
    readonly running: boolean | null
  }
  readonly warnings: readonly string[]
  readonly degraded: boolean
}
