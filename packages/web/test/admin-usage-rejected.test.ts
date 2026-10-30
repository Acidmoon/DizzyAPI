/**
 * 管理台「全站用量」页的坏记录隔离区测试（真起 web 服务 + 表单 POST）。
 *
 * 盯住三件事：
 * 1. 隔离记录、原因、状态在页面上看得见（否则就是静默免单）；
 * 2. 「忽略 / 重放」按钮真的调到 usage 服务，且只对 pending 行给出按钮；
 * 3. 只读展示不越权：缺 usage 服务时页面说人话，不白屏。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'

class FakeAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'auth')
  }

  async verifySession(token: string) {
    if (token !== 'test-token') throw new Error('会话无效')
    return {
      sessionId: 's1',
      userId: 1,
      user: {
        id: 1,
        name: '管理员',
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

interface FakeRejected {
  reqId: string
  seq: number
  error: string
  failures: number
  status: string
  updatedAt: string
}

function totals() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costMicros: '0',
  }
}

/** 假用量服务：只实现页面用到的部分，记录提醒动作。 */
class FakeUsage extends Service {
  readonly actions: string[] = []
  readonly rejected: FakeRejected[] = [
    {
      reqId: 'bad-pending',
      seq: 3,
      error: '用量记录的时间不合法：<script>alert(1)</script>',
      failures: 10,
      status: 'pending',
      updatedAt: '2026-10-28T10:00:00.000Z',
    },
    {
      reqId: 'bad-replayed',
      seq: 4,
      error: 'database is locked',
      failures: 10,
      status: 'replayed',
      updatedAt: '2026-10-28T09:00:00.000Z',
    },
  ]

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  summary() {
    return { totals: totals(), daily: [], models: [] }
  }

  /** 「最近请求」表的数据；隔离区用例不填，保持空表。 */
  rows: {
    startedAt: string
    model: string
    apiKeyName: string
    totalTokens: number
    costMicros: string
    durationMs: number
    ttftMs: number | null
    status: number
  }[] = []

  list(query: { limit?: number } = {}) {
    return { items: this.rows.slice(0, query.limit ?? 20), nextCursor: null }
  }

  exportRows() {
    return []
  }

  stats() {
    return { today: totals(), total: totals(), models: [] }
  }

  listRejected(query: { limit?: number; offset?: number; status?: string } = {}) {
    const filtered = this.rejected.filter((row) => query.status === undefined || row.status === query.status)
    const limit = query.limit ?? 20
    const offset = query.offset ?? 0
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      pending: this.rejected.filter((row) => row.status === 'pending').length,
    }
  }

  ignoreRejected(reqId: string): void {
    this.actions.push(`ignore:${reqId}`)
    const row = this.rejected.find((item) => item.reqId === reqId)
    if (row === undefined) throw Object.assign(new Error('没有这条隔离记录'), { code: 'USAGE_REJECTED_NOT_FOUND' })
    row.status = 'ignored'
  }

  replayRejected(reqId: string) {
    this.actions.push(`replay:${reqId}`)
    const row = this.rejected.find((item) => item.reqId === reqId)
    if (row === undefined) throw Object.assign(new Error('没有这条隔离记录'), { code: 'USAGE_REJECTED_NOT_FOUND' })
    row.status = 'replayed'
    return { status: 'replayed', inserted: true }
  }
}

interface App {
  readonly base: string
  readonly usage: FakeUsage | undefined
  readonly close: () => Promise<void>
}

async function boot(t: TestContext, options: { withUsage?: boolean } = {}): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    if (options.withUsage !== false) await ctx.plugin(FakeUsage)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: options.withUsage === false ? undefined : (ctx.get('usage') as unknown as FakeUsage),
      port: address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  t.after(async () => {
    await started.close()
  })
  return {
    base: started.base,
    usage: started.app,
    close: async () => {
      await started.close()
    },
  }
}

function get(app: App, path: string): Promise<Response> {
  return fetch(`${app.base}${path}`, {
    headers: { cookie: SESSION_COOKIE },
    redirect: 'manual',
  })
}

function post(app: App, path: string, body: string): Promise<Response> {
  return fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: app.base,
      cookie: SESSION_COOKIE,
    },
    body,
    redirect: 'manual',
  })
}

test('隔离页：列出记录、原因、状态与计数，只对 pending 给操作按钮', async (t) => {
  const app = await boot(t)
  const response = await get(app, '/admin/usage')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /坏记录隔离区/)
  assert.match(html, /bad-pending/)
  assert.match(html, /bad-replayed/)
  assert.match(html, /待处理隔离/)
  assert.match(html, /累计隔离/)
  assert.match(html, /不会(结算|扣钱)/)
  // 原因必须转义，不能把上游错误当 HTML 执行。
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)

  // pending 行有两个动作；replayed 行没有表单。
  assert.equal(html.split('action="/admin/usage?action=ignore"').length - 1, 1)
  assert.equal(html.split('action="/admin/usage?action=replay"').length - 1, 1)
  assert.match(html, /name="reqId" value="bad-pending"/)
})

test('隔离页：忽略 / 重放按钮真的调用 usage 服务并 303 回页面', async (t) => {
  const app = await boot(t)

  const ignored = await post(app, '/admin/usage?action=ignore', 'reqId=bad-pending')
  assert.equal(ignored.status, 303)
  assert.equal((ignored.headers.get('location') ?? '').startsWith('/admin/usage?ok='), true)
  assert.deepEqual(app.usage?.actions, ['ignore:bad-pending'])
  assert.equal(app.usage?.rejected[0]?.status, 'ignored')

  const replayed = await post(app, '/admin/usage?action=replay', 'reqId=bad-replayed')
  assert.equal(replayed.status, 303)
  assert.equal((replayed.headers.get('location') ?? '').startsWith('/admin/usage?ok='), true)
  assert.deepEqual(app.usage?.actions, ['ignore:bad-pending', 'replay:bad-replayed'])
})

test('隔离页：缺 reqId 回到页面带错误，不调用服务', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/admin/usage?action=ignore', '')
  assert.equal(response.status, 303)
  const location = response.headers.get('location') ?? ''
  assert.equal(location.startsWith('/admin/usage?err='), true, location)
  assert.ok(location.includes(encodeURIComponent('隔离记录')))
  assert.deepEqual(app.usage?.actions, [])
})

test('隔离页：usage 服务缺失时说人话，不白屏', async (t) => {
  const app = await boot(t, { withUsage: false })
  const response = await get(app, '/admin/usage')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /用量服务未运行/)
  assert.ok(!html.includes('坏记录隔离区'))
})

test('全站用量页：最近请求表带首字延迟列，非流式 / 历史记录显示「—」而不是 0', async (t) => {
  const app = await boot(t)
  app.usage?.rows.push(
    {
      startedAt: '2026-10-28T10:00:00.000Z',
      model: 'gpt-test',
      apiKeyName: 'ci',
      totalTokens: 120,
      costMicros: '1000',
      durationMs: 2_500,
      ttftMs: 321,
      status: 200,
    },
    {
      startedAt: '2026-10-28T09:00:00.000Z',
      model: 'gpt-test',
      apiKeyName: 'ci',
      totalTokens: 20,
      costMicros: '0',
      durationMs: 40,
      ttftMs: null,
      status: 200,
    },
    {
      startedAt: '2026-10-28T08:00:00.000Z',
      model: 'gpt-test',
      apiKeyName: 'ci',
      totalTokens: 20,
      costMicros: '0',
      durationMs: 40,
      ttftMs: null,
      status: 500,
    },
  )

  const response = await get(app, '/admin/usage')
  assert.equal(response.status, 200)
  const html = await response.text()

  // 表头有「首字延迟」列，且说明写清 null 的含义（不让人以为 0 = 没测到）。
  assert.match(html, /最近请求/)
  assert.match(html, /首字延迟/)
  assert.match(html, /TTFT/)
  assert.match(html, /只有流式请求才有/)

  // 流式记录：321ms / 总耗时 2.5s。
  assert.match(html, />321 ms</)
  assert.match(html, />2\.5 s</)
  // 非流式 / 历史记录：必须是「—」，不能是 0 ms。
  assert.match(html, />—</)
  assert.ok(!html.includes('>0 ms<'), '没有采集到的首字延迟不能显示成 0 ms')

  // 非 200 的状态用错误徽标，不混在正常状态里。
  assert.match(html, /500/)
})

test('全站用量：8 个指标分成「今日 / 累计 / 坏记录隔离」三组，费用是主指标', async (t) => {
  // owner 的原话：「全站用量这些指标全部挤在一起，谁能看得清楚？」
  // 改前是 8 张等权卡片平铺在一个 `.metrics` 里；这条钉住「分组 + 主次」不许退回去。
  const app = await boot(t)
  const html = await (await get(app, '/admin/usage')).text()

  for (const title of ['今日', '累计', '坏记录隔离']) {
    assert.match(html, new RegExp(`<h2 class="metric-group-title">${title}</h2>`), `缺少指标分组：${title}`)
  }
  assert.ok(html.includes('class="metric-groups"'), '指标区必须是分组结构（不是一排平铺卡片）')
  // 每组一张主指标卡（今日费用 / 累计费用），其余是次级指标：8 个指标 → 2 个主指标。
  assert.equal((html.match(/card--primary/g) ?? []).length, 2, '应当只有两个主指标卡')
  assert.match(html, /class="card card--primary card--metric"/)
})
