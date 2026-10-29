/**
 * 运维总览插件的测试。
 *
 * 局面用一个 `boot()` 组装：七个源都是 `ctx.provide` 的假对象（不拉起真插件），
 * 这样能精确控制每个源的返回值与抛错行为，盯住六件事：
 * 1. 六块都聚合得出来，字段与整数 / 金额字符串口径正确；
 * 2. 任一源缺失或抛错只让那一块降级，其余块照常（页面不白屏）；
 * 3. 异常摘要（gap / review / 冷却 / 快照过期）真的会进 warnings；
 * 4. `pending` 是算出来的（billing 没有单独字段）；
 * 5. 审计窗口分组与「截断」标记；
 * 6. **不泄漏**：账号 id / label / baseUrl 塞进去也不会出现在报告里；
 * 7. 非法配置让插件装载失败。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'
import ObservabilityService, {
  validateObservabilityConfig,
  type ObservabilityReport,
} from '../src/index.ts'

const ACTOR = '@dizzyapi/plugin-observability'
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0)

interface FakeOptions {
  readonly usage?: Record<string, unknown> | null
  readonly usageThrows?: boolean
  readonly priority?: boolean
  readonly usageStats?: Record<string, unknown> | null
  readonly usageStatsThrows?: boolean
  readonly quota?: Record<string, unknown> | null
  readonly quotaThrows?: boolean
  readonly runtime?: Record<string, unknown> | undefined | null
  readonly runtimeThrows?: boolean
  readonly billing?: Record<string, unknown> | null
  readonly billingThrows?: boolean
  readonly audit?: Record<string, unknown> | null
  readonly auditThrows?: boolean
  readonly accountHealth?: Record<string, unknown> | null
  readonly accounts?: readonly Record<string, unknown>[] | null
  readonly accountsThrows?: boolean
}

interface World {
  readonly service: ObservabilityService
  readonly report: ObservabilityReport
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, options: FakeOptions = {}): Promise<World> {
  const ctx = new Context()

  if (options.usage !== null) {
    ctx.provide('usage', {
      status() {
        if (options.usageThrows === true) throw new Error('用量库锁住了')
        return options.usage ?? defaultUsageStatus()
      },
    })
  }

  if (options.priority !== false) {
    const priority: Record<string, unknown> = {}
    priority.usageStats = async () => {
      if (options.usageStatsThrows === true) throw new Error('桥没连上')
      return options.usageStats ?? defaultUsageStats()
    }
    priority.quotaStatus = async () => {
      if (options.quotaThrows === true) throw new Error('桥没连上（quota）')
      return options.quota ?? defaultQuota()
    }
    priority.accountsRuntime = async () => {
      if (options.runtimeThrows === true) throw new Error('桥没连上（runtime）')
      return options.runtime === undefined ? defaultRuntime() : (options.runtime ?? undefined)
    }
    ctx.provide('accountPriority', priority)
  }

  if (options.billing !== null) {
    ctx.provide('billing', {
      summary(actor: string) {
        if (actor !== ACTOR) throw new Error(`读白名单不对：${actor}`)
        if (options.billingThrows === true) throw new Error('结算库锁住了')
        return options.billing ?? defaultBilling()
      },
    })
  }

  if (options.audit !== null) {
    ctx.provide('audit', {
      list(actor: string, query: { limit?: number; offset?: number; fromMs?: number; toMs?: number } = {}) {
        if (actor !== ACTOR) throw new Error(`读白名单不对：${actor}`)
        if (options.auditThrows === true) throw new Error('审计库锁住了')
        const fixture = options.audit ?? defaultAudit()
        const items = fixture.items as readonly Record<string, unknown>[]
        // 最近 5 条：不带时间范围；24h 窗口：带 fromMs。
        const filtered = query.fromMs === undefined ? items : items.filter((item) => Number(item.atMs) >= query.fromMs!)
        const limit = query.limit ?? 50
        return { items: filtered.slice(0, limit), total: filtered.length }
      },
      stats(actor: string) {
        if (actor !== ACTOR) throw new Error(`读白名单不对：${actor}`)
        const fixture = (options.audit ?? defaultAudit()) as Record<string, unknown>
        if (options.auditThrows === true) throw new Error('审计库锁住了')
        return fixture.stats
      },
    })
  }

  if (options.accountHealth !== null) {
    ctx.provide('accountHealth', {
      status() {
        return options.accountHealth ?? defaultAccountHealth()
      },
    })
  }

  if (options.accounts !== null) {
    ctx.provide('accountAdmin', {
      list() {
        if (options.accountsThrows === true) throw new Error('账号库锁住了')
        return options.accounts ?? defaultAccounts()
      },
    })
  }

  const fiber = await ctx.plugin(ObservabilityService, {})
  const service = ctx.get('observability') as ObservabilityService
  const report = await service.observe(NOW)
  const dispose = async (): Promise<void> => {
    await fiber.dispose()
  }
  t.after(async () => {
    try {
      await dispose()
    } catch {
      // fiber.dispose() 返回 void；测试清理忽略异常。
    }
  })
  return { service, report, dispose }
}

function defaultUsageStatus(): Record<string, unknown> {
  return {
    records: 1234,
    epoch: 'epoch-1',
    lastSeq: 900,
    polling: true,
    pricingAvailable: true,
    consecutiveFailures: 0,
    lastError: null,
    gapRecords: 0,
    rejectedCount: 2,
    rejectedPending: 0,
  }
}

function defaultUsageStats(): Record<string, unknown> {
  return { epoch: 'epoch-1', capacity: 32768, size: 120, firstSeq: 781, lastSeq: 900, dropped: 0, gap: 0 }
}

function defaultQuota(): Record<string, unknown> {
  return { ready: true, revision: 'rev-1', generation: 7, size: 3, ageMs: 1200, ttlMs: 15000 }
}

function defaultRuntime(): Record<string, unknown> {
  return { active: 4, cooling: 1 }
}

function defaultBilling(): Record<string, unknown> {
  return {
    totals: {
      records: 100,
      settled: 90,
      noPrice: 3,
      noUser: 1,
      failed: 2,
      review: 1,
      settling: 0,
      overdrawn: 2,
      chargedMicros: 12_345_678n,
      todayChargedMicros: 100_000n,
    },
    daily: [
      { date: '2026-10-28', records: 10, settled: 10, chargedMicros: 50_000n },
      { date: '2026-10-29', records: 25, settled: 24, chargedMicros: 900_000n },
    ],
    models: [],
  }
}

function defaultAudit(): Record<string, unknown> {
  return {
    items: [
      {
        id: 3,
        at: '2026-10-29T11:00:00.000Z',
        atMs: Date.UTC(2026, 9, 29, 11, 0, 0),
        actor: 'user:1:admin',
        actorPlugin: '@dizzyapi/plugin-api',
        action: 'user.balance.adjust',
        targetType: 'user',
        targetId: '7',
        summary: '调整用户 #7 的余额',
        metadata: { deltaMicros: '1000000' },
        result: 'ok',
        errorCode: null,
      },
      {
        id: 2,
        at: '2026-10-29T10:00:00.000Z',
        atMs: Date.UTC(2026, 9, 29, 10, 0, 0),
        actor: 'user:1:admin',
        actorPlugin: '@dizzyapi/plugin-web',
        action: 'topup.order.confirm',
        targetType: 'topup-order',
        targetId: 'T1',
        summary: '确认充值订单 T1 到账',
        metadata: null,
        result: 'ok',
        errorCode: null,
      },
      {
        id: 1,
        at: '2026-10-27T09:00:00.000Z',
        atMs: Date.UTC(2026, 9, 27, 9, 0, 0),
        actor: 'user:1:admin',
        actorPlugin: '@dizzyapi/plugin-api',
        action: 'user.balance.adjust',
        targetType: 'user',
        targetId: '8',
        summary: '更早的一条',
        metadata: null,
        result: 'failed',
        errorCode: 'USER_BALANCE_NOT_ZERO',
      },
    ],
    stats: { total: 3, today: 2, last24h: 2, failed: 1, lastAt: '2026-10-29T11:00:00.000Z' },
  }
}

function defaultAccountHealth(): Record<string, unknown> {
  return {
    enabled: true,
    running: false,
    lastPass: { checked: 5, healthy: 4, failed: 1, autoDisabled: ['acc-1'], autoEnabled: [] },
    lastPassAt: '2026-10-29T11:30:00.000Z',
  }
}

function defaultAccounts(): readonly Record<string, unknown>[] {
  return [
    // 塞进 id / label / baseUrl：报告里绝不能出现。
    { id: 'acc-secret-1', label: '内部账号 A', baseUrl: 'https://upstream.example/v1?key=sk-should-not-leak', enabled: true, status: 'active', health: 'healthy' },
    { id: 'acc-secret-2', label: '内部账号 B', baseUrl: 'https://upstream2.example/v1', enabled: true, status: 'active', health: 'degraded' },
    { id: 'acc-secret-3', label: '内部账号 C', baseUrl: 'https://upstream3.example/v1', enabled: true, status: 'auto_disabled', health: 'unhealthy' },
    { id: 'acc-secret-4', label: '内部账号 D', baseUrl: 'https://upstream4.example/v1', enabled: false, status: 'active', health: 'unknown' },
    { id: 'acc-secret-5', label: '内部账号 E', baseUrl: 'https://upstream5.example/v1', enabled: true, status: 'active', health: null },
  ]
}

// ───────────────────────────────── 聚合 ─────────────────────────────────

test('六块都聚合得出来：字段、整数类型、金额字符串、口径', async (t) => {
  const { report } = await boot(t)

  assert.equal(report.generatedAt, new Date(NOW).toISOString())
  assert.equal(report.degraded, false)

  // 用量链路
  assert.equal(report.usage.health.state, 'ok')
  assert.equal(report.usage.service?.records, 1234)
  assert.equal(report.usage.service?.polling, true)
  assert.equal(report.usage.service?.rejectedCount, 2)
  assert.equal(report.usage.gateway?.capacity, 32768)
  assert.equal(report.usage.gateway?.size, 120)
  assert.equal(report.usage.gatewayHealth.state, 'ok')

  // 结算：pending 是算出来的（100 - (90+3+1+2+1+0) = 3）
  assert.equal(report.billing.health.state, 'ok')
  assert.equal(report.billing.totals?.records, 100)
  assert.equal(report.billing.totals?.pending, 3)
  assert.equal(report.billing.totals?.review, 1)
  assert.equal(report.billing.totals?.overdrawn, 2)
  assert.equal(report.billing.chargedMicros, '12345678')
  assert.equal(report.billing.today?.date, '2026-10-29')
  assert.equal(report.billing.today?.settled, 24)
  assert.equal(report.billing.today?.chargedMicros, '900000')

  // 额度快照
  assert.equal(report.quota.health.state, 'ok')
  assert.equal(report.quota.ready, true)
  assert.equal(report.quota.stale, false)
  assert.equal(report.quota.ageMs, 1200)

  // 账号运行时
  assert.equal(report.runtime.health.state, 'ok')
  assert.equal(report.runtime.active, 4)
  assert.equal(report.runtime.cooling, 1)

  // 审计：24h 窗口里两条（27 号那条在外面），按动作分组
  assert.equal(report.audit.health.state, 'ok')
  assert.equal(report.audit.total, 3)
  assert.equal(report.audit.failed, 1)
  assert.deepEqual(report.audit.recentActions, [
    { action: 'topup.order.confirm', count: 1 },
    { action: 'user.balance.adjust', count: 1 },
  ])
  assert.equal(report.audit.latest.length, 3)
  assert.equal(report.audit.latest[0]?.action, 'user.balance.adjust')
  assert.equal(report.audit.latest[2]?.result, 'failed')

  // 账号池：四态 + 自动停用 + 上一轮检查
  assert.equal(report.accounts.health.state, 'ok')
  assert.equal(report.accounts.total, 5)
  assert.equal(report.accounts.enabled, 4)
  assert.equal(report.accounts.healthy, 1)
  assert.equal(report.accounts.degraded, 1)
  assert.equal(report.accounts.unhealthy, 1)
  // health 为 null 与 'unknown' 都算 unknown
  assert.equal(report.accounts.unknown, 2)
  assert.equal(report.accounts.autoDisabled, 1)
  assert.equal(report.accounts.lastPass?.checked, 5)
  assert.equal(report.accounts.lastPass?.autoDisabled, 1)
  assert.equal(report.accounts.running, false)

  // 有异常就会有对应的稳定码
  assert.ok(report.warnings.includes('BILLING_REVIEW'))
  assert.ok(report.warnings.includes('BILLING_FAILED'))
  assert.ok(report.warnings.includes('BILLING_OVERDRAWN'))
  assert.ok(report.warnings.includes('ACCOUNTS_COOLING'))
  assert.ok(report.warnings.includes('AUDIT_FAILED_ACTIONS'))
  assert.ok(report.warnings.includes('ACCOUNTS_AUTO_DISABLED'))
})

test('不泄漏：账号 id / label / baseUrl（含 key）都不出现在报告里', async (t) => {
  const { report } = await boot(t)
  const serialized = JSON.stringify(report)
  for (const secret of [
    'acc-secret-1',
    'acc-secret-2',
    '内部账号',
    'upstream.example',
    'sk-should-not-leak',
    'baseUrl',
    'label',
  ]) {
    assert.ok(!serialized.includes(secret), `报告里不应出现 ${secret}`)
  }
  // 审计条目也不带 metadata（里面可能有业务细节），只带摘要与稳定字段。
  assert.ok(!serialized.includes('deltaMicros'))
})

// ───────────────────────────────── 降级 ─────────────────────────────────

test('降级：只有 usage 缺失时其余块照常，整份报告仍可用', async (t) => {
  const { report } = await boot(t, { usage: null })
  assert.equal(report.usage.health.state, 'unavailable')
  assert.match(report.usage.health.detail, /用量插件未运行/)
  assert.equal(report.usage.service, null)
  // 桥仍能读到（usageStats 走 account-priority）
  assert.equal(report.usage.gateway?.capacity, 32768)
  assert.equal(report.billing.health.state, 'ok')
  assert.equal(report.accounts.health.state, 'ok')
  assert.equal(report.degraded, true)
})

test('降级：account-priority 缺席时三块（缓冲 / 额度 / 运行时）各自标不可用', async (t) => {
  const { report } = await boot(t, { priority: false })
  assert.equal(report.usage.gatewayHealth.state, 'unavailable')
  assert.equal(report.usage.gateway, null)
  // 用量服务本身还在：整条链路降级但不空白
  assert.equal(report.usage.health.state, 'degraded')
  assert.equal(report.quota.health.state, 'unavailable')
  assert.equal(report.quota.ready, null)
  assert.equal(report.runtime.health.state, 'unavailable')
  assert.equal(report.runtime.active, null)
  // 不依赖 account-priority 的块照常
  assert.equal(report.billing.health.state, 'ok')
  assert.equal(report.audit.health.state, 'ok')
})

test('降级：单个源抛错只影响自己（桥断 / 库锁 / 状态读失败）', async (t) => {
  const { report } = await boot(t, {
    usageThrows: true,
    usageStatsThrows: true,
    quotaThrows: true,
    billingThrows: true,
    auditThrows: true,
    accountsThrows: true,
  })
  assert.equal(report.usage.service, null)
  assert.equal(report.quota.health.state, 'degraded')
  assert.equal(report.billing.health.state, 'degraded')
  assert.equal(report.billing.totals, null)
  assert.equal(report.audit.health.state, 'degraded')
  assert.equal(report.accounts.health.state, 'degraded')
  assert.equal(report.runtime.health.state, 'ok', '未抛错的源不受影响')
  // 出错时不能抛到调用方
  assert.ok(report.degraded === true)
})

test('降级：Go 没有运行时跟踪器（accountsRuntime 返回 undefined）标降级而不是 0', async (t) => {
  const { report } = await boot(t, { runtime: null })
  assert.equal(report.runtime.health.state, 'degraded')
  assert.match(report.runtime.health.detail, /没有注入运行时跟踪器/)
  assert.equal(report.runtime.active, null)
  assert.equal(report.runtime.cooling, null)
  assert.ok(!report.warnings.includes('ACCOUNTS_COOLING'))
})

test('降级：余额快照未就绪 / 过期分别说人话并进 warnings', async (t) => {
  const notReady = await boot(t, { quota: { ready: false, size: 0, ageMs: 0, ttlMs: 15000 } })
  assert.equal(notReady.report.quota.health.state, 'degraded')
  assert.match(notReady.report.quota.health.detail, /尚未就绪/)
  assert.equal(notReady.report.quota.stale, true)
  assert.ok(notReady.report.warnings.includes('QUOTA_SNAPSHOT_STALE'))

  const expired = await boot(t, {
    quota: { ready: true, revision: 'rev-1', size: 3, ageMs: 20_000, ttlMs: 15_000 },
  })
  assert.equal(expired.report.quota.stale, true)
  assert.match(expired.report.quota.health.detail, /已过期/)
})

test('只用健康检查（没有账号门面）时：只有上一轮结果，分布标降级', async (t) => {
  const { report } = await boot(t, { accounts: null })
  assert.equal(report.accounts.health.state, 'degraded')
  assert.match(report.accounts.health.detail, /只有最近一轮健康检查结果/)
  assert.equal(report.accounts.total, 0)
  assert.equal(report.accounts.lastPass?.checked, 5)
})

// ───────────────────────────────── 异常摘要 ─────────────────────────────────

test('warnings：缺口 / 轮询失败 / 隔离区待处理 / 缓冲丢弃都会出现在摘要里', async (t) => {
  const { report } = await boot(t, {
    usage: {
      ...defaultUsageStatus(),
      consecutiveFailures: 3,
      lastError: 'sqlite busy',
      gapRecords: 17,
      rejectedPending: 2,
    },
    usageStats: { ...defaultUsageStats(), dropped: 5, gap: 5 },
  })
  for (const code of ['USAGE_GAP', 'USAGE_POLL_FAILING', 'USAGE_REJECTED_PENDING', 'USAGE_RING_DROPPED']) {
    assert.ok(report.warnings.includes(code), `缺少 ${code}`)
  }
  assert.equal(report.usage.service?.lastError, 'sqlite busy')
})

test('审计窗口：扫到上限时标 windowTruncated（不静默给偏小的分组计数）', async (t) => {
  const many = Array.from({ length: 4 }, (_, index) => ({
    id: index + 1,
    at: '2026-10-29T11:00:00.000Z',
    atMs: Date.UTC(2026, 9, 29, 11, 0, 0) - index * 1000,
    actor: 'user:1:admin',
    actorPlugin: '@dizzyapi/plugin-api',
    action: index % 2 === 0 ? 'pricing.write' : 'settings.write',
    targetType: 'pricing',
    targetId: String(index),
    summary: '窗口内的动作',
    metadata: null,
    result: 'ok' as const,
    errorCode: null,
  }))
  const fixture = {
    items: many,
    stats: { total: 4, today: 4, last24h: 4, failed: 0, lastAt: '2026-10-29T11:00:00.000Z' },
  }
  const ctx = new Context()
  ctx.provide('audit', {
    list: (_actor: string, query: { limit?: number; fromMs?: number } = {}) => {
      const items = query.fromMs === undefined ? fixture.items : fixture.items
      const limit = query.limit ?? 50
      return { items: items.slice(0, limit), total: items.length }
    },
    stats: () => fixture.stats,
  })
  const fiber = await ctx.plugin(ObservabilityService, { auditWindowLimit: 2 })
  const service = ctx.get('observability') as ObservabilityService
  const report = await service.observe(NOW)
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 清理忽略异常。
    }
  })
  assert.equal(report.audit.windowLimit, 2)
  assert.equal(report.audit.windowTruncated, true)
  assert.equal(
    report.audit.recentActions.reduce((sum, item) => sum + item.count, 0),
    2,
  )
})

// ───────────────────────────────── 配置与生命周期 ─────────────────────────────────

test('配置：审计窗口上限默认 200、边界 1..1000，非法值让插件装载失败', async () => {
  const resolved = validateObservabilityConfig(undefined)
  if (isIssueList(resolved)) throw new Error('默认配置必须合法')
  assert.equal(resolved.auditWindowLimit, 200)

  assert.ok(Array.isArray(validateObservabilityConfig({ auditWindowLimit: 0 })))
  assert.ok(Array.isArray(validateObservabilityConfig({ auditWindowLimit: 1001 })))
  assert.ok(Array.isArray(validateObservabilityConfig({ auditWindowLimit: '200' })))
  assert.ok(Array.isArray(validateObservabilityConfig({ nope: 1 })))

  const ctx = new Context()
  let failure: unknown
  try {
    await ctx.plugin(ObservabilityService, { auditWindowLimit: 0 })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error, '非法配置必须让插件装载失败')
  assert.equal(ctx.get('observability', false), undefined)
})

test('禁用后不再可用：卸载后 observe 抛稳定错误（不留残余）', async (t) => {
  const world = await boot(t)
  await world.dispose()
  await assert.rejects(
    () => world.service.observe(NOW),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'OBSERVABILITY_NOT_READY',
  )
})
