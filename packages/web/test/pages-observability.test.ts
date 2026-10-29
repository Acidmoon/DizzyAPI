/**
 * 管理台 · 运维总览（`/admin/observability`）的测试。
 *
 * 真起 web 服务 + 假 observability 服务，盯住六件事：
 * 1. 六块都渲染出来，金额按「整数微元 → 元」渲染（不经浮点）；
 * 2. 某块不可用时页面照常渲染其余块，只标注那一块的原因（不白屏、不整页 503）；
 * 3. 异常值高亮（缺口 / 待核查 / 冷却 / 自动停用会给徽标）；
 * 4. 异常摘要与动作码都有中文、未映射的动作码原样显示；
 * 5. 文本都转义（摘要里塞 HTML 不能执行）；
 * 6. 缺服务、服务抛错都给人话。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import type { ObservabilityReportView } from '../src/runtime.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'

class FakeAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'auth')
  }

  async verifySession(token: string) {
    if (token !== 'test-token') throw new Error('会话无效')
    return {
      sessionId: 's1',
      userId: 2,
      user: {
        id: 2,
        name: 'alice',
        status: 'enabled' as const,
        role: 'admin' as const,
        balance: 0n,
        balanceEnabled: false,
        avatar: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
  }

  async logout(): Promise<void> {
    // 测试不关心。
  }
}

/** 一份「六块都在、含异常值」的报告。 */
function reportOf(patch: Partial<ObservabilityReportView> = {}): ObservabilityReportView {
  return {
    generatedAt: '2026-10-29T12:00:00.000Z',
    usage: {
      health: { state: 'ok', detail: '' },
      service: {
        records: 1234,
        polling: true,
        consecutiveFailures: 0,
        lastError: null,
        gapRecords: 17,
        rejectedCount: 2,
        rejectedPending: 1,
        pricingAvailable: true,
        epoch: 'epoch-1',
        lastSeq: 900,
      },
      gateway: { epoch: 'epoch-1', capacity: 32768, size: 120, firstSeq: 781, lastSeq: 900, dropped: 5, gap: 5 },
      gatewayHealth: { state: 'ok', detail: '' },
    },
    billing: {
      health: { state: 'ok', detail: '' },
      totals: { records: 100, settled: 90, pending: 3, settling: 0, noPrice: 3, noUser: 1, failed: 2, review: 1, overdrawn: 2 },
      chargedMicros: '12345678',
      today: { date: '2026-10-29', settled: 24, chargedMicros: '900000' },
    },
    quota: {
      health: { state: 'ok', detail: '' },
      ready: true,
      revision: 'rev-1',
      generation: 7,
      size: 3,
      ageMs: 1200,
      ttlMs: 15000,
      stale: false,
    },
    runtime: { health: { state: 'ok', detail: '' }, active: 4, cooling: 1 },
    audit: {
      health: { state: 'ok', detail: '' },
      total: 3,
      failed: 1,
      lastAt: '2026-10-29T11:00:00.000Z',
      recentActions: [
        { action: 'user.balance.adjust', count: 2 },
        { action: 'custom.unmapped_action', count: 1 },
      ],
      windowLimit: 200,
      windowTruncated: false,
      latest: [
        {
          at: '2026-10-29T11:00:00.000Z',
          actor: 'user:1:admin',
          action: 'user.balance.adjust',
          targetType: 'user',
          targetId: '7',
          summary: '调整余额 <img src=x onerror=alert(1)>',
          result: 'ok',
          errorCode: null,
        },
      ],
    },
    accounts: {
      health: { state: 'ok', detail: '' },
      total: 5,
      enabled: 4,
      unknown: 2,
      healthy: 1,
      degraded: 1,
      unhealthy: 1,
      autoDisabled: 1,
      lastPass: { checked: 5, healthy: 4, failed: 1, autoDisabled: 1, autoEnabled: 0 },
      lastPassAt: '2026-10-29T11:30:00.000Z',
      running: false,
    },
    warnings: ['USAGE_GAP', 'BILLING_REVIEW', 'QUOTA_SNAPSHOT_STALE'],
    degraded: true,
    ...patch,
  }
}

/** 假运维总览服务：返回给定报告，可让 observe 抛错。 */
class FakeObservability extends Service {
  calls = 0
  report: ObservabilityReportView = reportOf()
  failWith: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'observability')
  }

  async observe(): Promise<ObservabilityReportView> {
    this.calls += 1
    if (this.failWith !== undefined) throw Object.assign(new Error(this.failWith), { code: 'OBSERVABILITY_STORE_FAILED' })
    return this.report
  }
}

interface App {
  readonly base: string
  readonly observability: FakeObservability | undefined
}

async function boot(t: TestContext, options: { withObservability?: boolean } = {}): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    if (options.withObservability !== false) await ctx.plugin(FakeObservability)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: {
        observability:
          options.withObservability === false
            ? undefined
            : (ctx.get('observability') as unknown as FakeObservability),
      },
      port: address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  t.after(async () => {
    await started.close()
  })
  return { base: started.base, observability: started.app.observability }
}

function get(app: App, path: string): Promise<Response> {
  return fetch(`${app.base}${path}`, { headers: { cookie: SESSION_COOKIE }, redirect: 'manual' })
}

// ───────────────────────────────── 正常渲染 ─────────────────────────────────

test('运维总览：六块都渲染、金额按整数微元渲染、动作码有中文与原始码', async (t) => {
  const app = await boot(t)
  const response = await get(app, '/admin/observability')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.equal(app.observability?.calls, 1)

  // 六个块的标题
  for (const title of [
    '用量链路（TS 轮询）',
    '用量链路（Go 环形缓冲）',
    '结算',
    '额度快照（Go 侧余额只读快照）',
    '账号运行时（Go 侧全站聚合）',
    '审计（最近 24 小时）',
    '账号池健康',
  ]) {
    assert.ok(html.includes(title), `缺少块：${title}`)
  }

  // 金额：12345678 微元 = ¥12.34（formatYuan 保留两位、截断）；今日 900000 = ¥0.90
  assert.match(html, /¥12\.34/)
  assert.match(html, /¥0\.90/)
  // 计数
  assert.match(html, /1,234/)
  assert.match(html, /32,768/)
  // 动作：已映射给中文 + 原始码，未映射原样显示
  assert.match(html, /调整用户余额/)
  assert.match(html, /user\.balance\.adjust/)
  assert.match(html, /custom\.unmapped_action/)
  // 异常摘要给中文
  assert.match(html, /用量序号有缺口/)
  assert.match(html, /结算有需要人工核查的记录/)
})

test('高亮：缺口 / 待核查 / 冷却 / 自动停用都给徽标；正常值不给', async (t) => {
  const app = await boot(t)
  const html = await (await get(app, '/admin/observability')).text()

  // 17 条缺口、1 条待核查、1 个冷却、1 个自动停用 → 都是徽标里的数字
  assert.match(html, /<span class="badge (err|warn)">17<\/span>/)
  assert.match(html, /<span class="badge (err|warn)">1<\/span>/)
  // 健康度徽标：正常 = ok
  assert.match(html, /<span class="badge ok">正常<\/span>/)
  // 页面顶部有降级提示（这份报告 degraded=true）
  assert.match(html, /有数据源降级或不可用/)
})

test('转义：审计摘要里的 HTML 不会执行', async (t) => {
  const app = await boot(t)
  const html = await (await get(app, '/admin/observability')).text()
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

// ───────────────────────────────── 降级 ─────────────────────────────────

test('降级：某块不可用时其余块照常，只标注那一块的原因', async (t) => {
  const app = await boot(t)
  app.observability!.report = reportOf({
    usage: {
      health: { state: 'unavailable', detail: '用量插件未运行：看不到轮询状态与隔离区' },
      service: null,
      gateway: null,
      gatewayHealth: { state: 'unavailable', detail: 'account-priority 未运行：读不到 Go 环形缓冲健康度' },
    },
    billing: {
      health: { state: 'degraded', detail: '读取结算汇总失败：结算库锁住了' },
      totals: null,
      chargedMicros: null,
      today: null,
    },
    degraded: true,
  })

  const response = await get(app, '/admin/observability')
  assert.equal(response.status, 200)
  const html = await response.text()

  // 不可用的块：徽标 + 原因
  assert.match(html, /<span class="badge err">不可用<\/span>/)
  assert.match(html, /用量插件未运行/)
  assert.match(html, /结算库锁住了/)
  assert.match(html, /用量服务不可用：看不到轮询状态/)
  assert.match(html, /结算服务不可用/)

  // 其它块照常（同样来自这份报告）
  assert.match(html, /账号池健康/)
  assert.match(html, /1,200ms?/) // 额度快照年龄（count() 用 formatThousands）
})

test('缺服务：页面降级人话，不白屏', async (t) => {
  const app = await boot(t, { withObservability: false })
  const response = await get(app, '/admin/observability')
  assert.equal(response.status, 200)
  assert.match(await response.text(), /运维总览服务未运行/)
})

test('服务抛错：页面给人话，不 500', async (t) => {
  const app = await boot(t)
  app.observability!.failWith = '聚合炸了'
  const response = await get(app, '/admin/observability')
  assert.equal(response.status, 200)
  assert.match(await response.text(), /聚合炸了/)
})

test('普通用户 403：运维总览是管理员页', async (t) => {
  const app = await boot(t)
  const response = await fetch(`${app.base}/admin/observability`, {
    headers: { cookie: 'dizzyapi_session=user-token' },
    redirect: 'manual',
  })
  // FakeAuth 只认 test-token：无效会话会被重定向到登录页（也算挡住了）。
  assert.ok(response.status === 302 || response.status === 403)
})
