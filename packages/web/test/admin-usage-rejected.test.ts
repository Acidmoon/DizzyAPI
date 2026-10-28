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

  list() {
    return { items: [], nextCursor: null }
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
  t.after(async () => {
    await web.close()
  })
  return {
    base: `http://127.0.0.1:${address.port}`,
    usage: options.withUsage === false ? undefined : (ctx.get('usage') as unknown as FakeUsage),
    close: async () => {
      await web.close()
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
