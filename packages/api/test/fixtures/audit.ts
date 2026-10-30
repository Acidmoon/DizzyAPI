/**
 * 审计与内容审核夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  AuditEntryLike,
  AuditPageLike,
  AuditPort,
  AuditQueryLike,
  AuditRecordLike,
  AuditStatsLike,
  ContentAuditHitsLike,
  ContentAuditPort,
  ContentAuditRuleInputLike,
  ContentAuditRuleLike,
  ContentAuditRulePatchLike,
  ContentAuditStatusLike,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

/** 审计服务的假实现：记录收到的写入、支持筛选与分页；可以让 record 抛错。 */
export class FakeAudit implements AuditPort {
  readonly calls: AuditEntryLike[] = []
  readonly reads: { readonly actor: string; readonly query?: AuditQueryLike }[] = []
  /** 置 true 后 `record` 抛错：用来验证「审计挂了业务照常成功」。 */
  failRecord = false
  private items: AuditRecordLike[] = []
  private nextId = 1

  record(entry: AuditEntryLike): AuditRecordLike {
    if (this.failRecord) throw new Error('审计库写入失败（测试注入）')
    const atMs = entry.atMs ?? Date.UTC(2026, 9, 19, 12, 0, 0)
    const stored: AuditRecordLike = {
      id: this.nextId++,
      at: new Date(atMs).toISOString(),
      atMs,
      actor: entry.actor,
      actorPlugin: entry.actorPlugin,
      action: entry.action,
      targetType: entry.targetType ?? '',
      targetId: entry.targetId ?? '',
      summary: entry.summary,
      metadata: entry.metadata ?? null,
      result: entry.result ?? 'ok',
      errorCode: entry.errorCode ?? null,
    }
    this.calls.push(entry)
    this.items.push(stored)
    return stored
  }

  list(actor: string, query: AuditQueryLike = {}): AuditPageLike {
    this.reads.push({ actor, query })
    const filtered = this.items.filter((item) => {
      if (query.actor !== undefined && item.actor !== query.actor) return false
      if (query.action !== undefined && item.action !== query.action) return false
      if (query.targetType !== undefined && item.targetType !== query.targetType) return false
      if (query.targetId !== undefined && item.targetId !== query.targetId) return false
      return true
    })
    const sorted = [...filtered].sort((a, b) => b.atMs - a.atMs || b.id - a.id)
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    return {
      items: sorted.slice(offset, offset + limit),
      total: sorted.length,
      offset,
      limit,
    }
  }

  stats(actor: string): AuditStatsLike {
    this.reads.push({ actor })
    const byAction = new Map<string, number>()
    const byActor = new Map<string, number>()
    for (const item of this.items) {
      byAction.set(item.action, (byAction.get(item.action) ?? 0) + 1)
      byActor.set(item.actor, (byActor.get(item.actor) ?? 0) + 1)
    }
    return {
      total: this.items.length,
      today: this.items.length,
      last24h: this.items.length,
      failed: this.items.filter((item) => item.result === 'failed').length,
      lastAt: this.items.length === 0 ? null : this.items[this.items.length - 1]!.at,
      byAction: [...byAction].map(([action, count]) => ({ action, count })),
      byActor: [...byActor].map(([actor, count]) => ({ actor, count })),
    }
  }

  /** 只给用例读：预置一条历史记录（模拟「昨天有人改过余额」）。 */
  seed(entry: AuditEntryLike): AuditRecordLike {
    return this.record(entry)
  }
}

/** 内容审核规则服务（`contentAudit`）的假实现：只覆盖 HTTP 层要观察的行为。 */
export class FakeContentAudit implements ContentAuditPort {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[] = []
  /** 设置后所有写方法抛出带这个 code 的 DomainError。 */
  failCode: string | undefined
  /** 置 true 后 `status()` 的 Go 侧字段全是 null（模拟桥断）。 */
  goOffline = false
  /** 命中统计；`goOffline` 为 true 时不会被读到。 */
  hits: ContentAuditHitsLike = {
    blocked: 7,
    logged: 3,
    allowedStale: 1,
    strictFailed: 0,
    parseFailed: 2,
    noText: 41,
    truncated: 1,
    ruleHitTotal: 10,
    byRule: { car_seed: 10 },
    staleStreak: 0,
  }

  private rules: ContentAuditRuleLike[] = [
    {
      id: 'car_seed',
      pattern: 'seed-word',
      action: 'block',
      category: 'abuse',
      enabled: true,
      note: '夹具里的种子规则',
      createdAt: '2026-10-20T08:00:00.000Z',
      updatedAt: '2026-10-20T08:00:00.000Z',
    },
  ]

  list(actor: string): readonly ContentAuditRuleLike[] {
    this.calls.push({ method: 'list', args: [actor] })
    return this.rules.map((rule) => ({ ...rule }))
  }

  get(actor: string, id: string): ContentAuditRuleLike | null {
    this.calls.push({ method: 'get', args: [actor, id] })
    const rule = this.rules.find((item) => item.id === id)
    return rule === undefined ? null : { ...rule }
  }

  async create(actor: string, input: ContentAuditRuleInputLike): Promise<ContentAuditRuleLike> {
    this.calls.push({ method: 'create', args: [actor, input] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：新增规则失败')
    const rule: ContentAuditRuleLike = {
      id: `car_${String(this.rules.length + 1)}`,
      pattern: input.pattern,
      action: input.action ?? 'block',
      ...(input.category === undefined ? {} : { category: input.category }),
      enabled: input.enabled ?? true,
      ...(input.note === undefined ? {} : { note: input.note }),
      createdAt: '2026-10-29T12:00:00.000Z',
      updatedAt: '2026-10-29T12:00:00.000Z',
    }
    this.rules = [...this.rules, rule]
    return { ...rule }
  }

  async update(actor: string, id: string, patch: ContentAuditRulePatchLike): Promise<ContentAuditRuleLike> {
    this.calls.push({ method: 'update', args: [actor, id, patch] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：修改规则失败')
    const current = this.rules.find((item) => item.id === id)
    if (current === undefined) throw new DomainError('CONTENT_AUDIT_RULE_NOT_FOUND', '规则不存在')
    const next: ContentAuditRuleLike = {
      id,
      pattern: patch.pattern ?? current.pattern,
      action: patch.action ?? current.action,
      ...(patch.category === null
        ? {}
        : { category: patch.category ?? current.category }),
      enabled: patch.enabled ?? current.enabled,
      ...(patch.note === null ? {} : { note: patch.note ?? current.note }),
      createdAt: current.createdAt,
      updatedAt: '2026-10-29T12:05:00.000Z',
    }
    this.rules = this.rules.map((item) => (item.id === id ? next : item))
    return { ...next }
  }

  async remove(actor: string, id: string): Promise<boolean> {
    this.calls.push({ method: 'remove', args: [actor, id] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：删除规则失败')
    const before = this.rules.length
    this.rules = this.rules.filter((item) => item.id !== id)
    return this.rules.length !== before
  }

  async status(): Promise<ContentAuditStatusLike> {
    return {
      enabled: true,
      pushIntervalMs: 5_000,
      ruleCount: this.rules.length,
      revision: 'rev-seed',
      generation: 42,
      ageMs: this.goOffline ? null : 1_200,
      ttlMs: this.goOffline ? null : 15_000,
      stale: this.goOffline ? null : false,
      goReady: this.goOffline ? null : true,
      lastPushAt: '2026-10-29T12:00:00.000Z',
      lastError: null,
      pushes: 11,
      heartbeats: 10,
      failureStreak: 0,
      goTtlMs: this.goOffline ? null : 15_000,
      heartbeatTooSlow: false,
      hits: this.goOffline ? null : { ...this.hits, byRule: { ...this.hits.byRule } },
    }
  }

  async pushNow(): Promise<string | null> {
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：推送失败')
    return 'rev-seed'
  }
}
