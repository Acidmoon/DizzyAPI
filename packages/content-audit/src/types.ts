/** 一条审核规则。 */
export interface ContentAuditRule {
  readonly id: string
  /** 关键词（大小写不敏感的子串匹配；这一批不支持正则）。 */
  readonly pattern: string
  /** `block` = 命中即拒绝；`log` = 命中只记日志与计数。 */
  readonly action: 'block' | 'log'
  readonly category?: string
  readonly enabled: boolean
  readonly note?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** 新建规则的入参。 */
export interface ContentAuditRuleInput {
  readonly pattern: string
  readonly action?: 'block' | 'log'
  readonly category?: string
  readonly enabled?: boolean
  readonly note?: string
}

/** 修改规则的入参（未给的字段保持不变）。 */
export interface ContentAuditRulePatch {
  readonly pattern?: string
  readonly action?: 'block' | 'log'
  readonly category?: string
  readonly enabled?: boolean
  readonly note?: string
}

/** 推给 Go 的规则快照（桥命令 contentaudit.replace）。 */
export interface ContentAuditSnapshotPayload {
  readonly version: 1
  readonly generation: number
  readonly revision: string
  readonly enabled: boolean
  readonly rules: readonly {
    readonly id: string
    readonly pattern: string
    readonly action: 'block' | 'log'
    readonly category?: string
  }[]
}

/** Go 侧命中统计（来自 contentaudit.status 的 gate 字段）。 */
export interface ContentAuditHits {
  readonly blocked: number
  readonly logged: number
  readonly allowedStale: number
  readonly strictFailed: number
  readonly parseFailed: number
  readonly noText: number
  readonly truncated: number
  readonly ruleHitTotal: number
  readonly byRule: Readonly<Record<string, number>>
  readonly staleStreak: number
}

/** 插件状态：本地推送状态 + Go 侧健康度与命中统计。 */
export interface ContentAuditStatus {
  readonly enabled: boolean
  readonly pushIntervalMs: number
  readonly ruleCount: number
  /** 当前推给 Go 的 revision；还没成功推过为 null。 */
  readonly revision: string | null
  readonly generation: number
  /** Go 侧快照年龄 / TTL；读不到为 null。 */
  readonly ageMs: number | null
  readonly ttlMs: number | null
  /** Go 侧快照是否过期；读不到为 null。 */
  readonly stale: boolean | null
  readonly goReady: boolean | null
  readonly lastPushAt: string | null
  readonly lastError: string | null
  readonly pushes: number
  readonly heartbeats: number
  readonly failureStreak: number
  readonly goTtlMs: number | null
  readonly heartbeatTooSlow: boolean
  readonly hits: ContentAuditHits | null
}
