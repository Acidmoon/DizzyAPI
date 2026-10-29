/**
 * 管理台 · 操作审计页面与审计接线的测试。
 *
 * 覆盖：
 * 1. 页面渲染（统计卡 / 表格 / 动作中文标签 + 原始码 / 未映射动作显式回退原始码）；
 * 2. 筛选与分页参数按名传给服务，日期 → 毫秒范围；
 * 3. 缺 audit 服务时页面降级成人话，不白屏；
 * 4. **管理台写动作真的会记审计**（actor / actorPlugin / action / target 都对）；
 * 5. audit.record 抛错时动作照常成功（审计是旁路）；
 * 6. 页面上的文本都经过转义（元数据里塞 HTML 不能执行）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { AUDIT_ACTION_LABELS } from '../src/content/audit_actions.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import type {
  AuditEntryView,
  AuditPageView,
  AuditQueryView,
  AuditRecordView,
  AuditStatsView,
  UserView,
} from '../src/runtime.ts'

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
        balance: 2_500_000n,
        balanceEnabled: true,
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

/** 假用户服务：只覆盖管理台动作会调到的方法。 */
class FakeUser extends Service {
  readonly calls: string[] = []
  balance = 2_500_000n

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  async get(id: number): Promise<UserView | undefined> {
    return {
      id,
      name: 'alice',
      status: 'enabled',
      role: 'admin',
      balance: this.balance,
      balanceEnabled: true,
      avatar: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  async list(): Promise<UserView[]> {
    return [(await this.get(2)) as UserView]
  }

  async adjustBalance(actor: string, id: number, delta: bigint): Promise<bigint> {
    this.calls.push(`adjust:${actor}:${id}:${delta.toString()}`)
    this.balance += delta
    return this.balance
  }

  async setStatus(actor: string, id: number, status: string): Promise<UserView> {
    this.calls.push(`status:${actor}:${id}:${status}`)
    return (await this.get(id)) as UserView
  }

  async setRole(actor: string, id: number, role: string): Promise<UserView> {
    this.calls.push(`role:${actor}:${id}:${role}`)
    return (await this.get(id)) as UserView
  }

  async remove(actor: string, id: number): Promise<UserView> {
    this.calls.push(`remove:${actor}:${id}`)
    return (await this.get(id)) as UserView
  }
}

/** 假审计服务：内存数组 + 记录调用；可以让 record 抛错。 */
class FakeAudit extends Service {
  readonly entries: AuditEntryView[] = []
  readonly reads: { readonly actor: string; readonly query?: AuditQueryView }[] = []
  failRecord = false
  private rows: AuditRecordView[] = []
  private nextId = 1

  constructor(ctx: Context) {
    super(ctx, 'audit')
  }

  record(entry: AuditEntryView): AuditRecordView {
    if (this.failRecord) throw new Error('审计库写入失败（测试注入）')
    const atMs = entry.atMs ?? Date.UTC(2026, 9, 29, 10, 0, 0)
    const row: AuditRecordView = {
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
    this.entries.push(entry)
    this.rows.push(row)
    return row
  }

  list(actor: string, query: AuditQueryView = {}): AuditPageView {
    this.reads.push({ actor, query })
    const filtered = this.rows.filter((row) => {
      if (query.actor !== undefined && row.actor !== query.actor) return false
      if (query.action !== undefined && row.action !== query.action) return false
      if (query.targetType !== undefined && row.targetType !== query.targetType) return false
      if (query.fromMs !== undefined && row.atMs < query.fromMs) return false
      if (query.toMs !== undefined && row.atMs >= query.toMs) return false
      return true
    })
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit }
  }

  stats(actor: string): AuditStatsView {
    this.reads.push({ actor })
    return {
      total: this.rows.length,
      today: this.rows.length,
      last24h: this.rows.length,
      failed: this.rows.filter((row) => row.result === 'failed').length,
      lastAt: this.rows.length === 0 ? null : (this.rows[this.rows.length - 1] as AuditRecordView).at,
      byAction: [],
      byActor: [],
    }
  }

  seed(entry: AuditEntryView): AuditRecordView {
    return this.record(entry)
  }
}

interface App {
  readonly base: string
  readonly audit: FakeAudit | undefined
  readonly user: FakeUser
}

async function boot(t: TestContext, options: { withAudit?: boolean } = {}): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    await ctx.plugin(FakeUser)
    const user = ctx.get('user') as unknown as FakeUser
    if (options.withAudit !== false) await ctx.plugin(FakeAudit)
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
        audit: options.withAudit === false ? undefined : (ctx.get('audit') as unknown as FakeAudit),
        user,
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
  return { base: started.base, audit: started.app.audit, user: started.app.user }
}

function get(app: App, path: string): Promise<Response> {
  return fetch(`${app.base}${path}`, { headers: { cookie: SESSION_COOKIE }, redirect: 'manual' })
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

// ───────────────────────────────── 页面渲染 ─────────────────────────────────

test('审计页：统计卡、动作中文标签 + 原始码、未映射动作显式回退原始码、结果徽标', async (t) => {
  const app = await boot(t)
  app.audit?.seed({
    actor: 'user:2:admin',
    actorPlugin: '@dizzyapi/plugin-api',
    action: 'user.balance.adjust',
    targetType: 'user',
    targetId: '7',
    summary: '调整用户 #7 的余额',
    metadata: { deltaMicros: '1500000', balanceAfterMicros: '9000000' },
    atMs: Date.UTC(2026, 9, 29, 9, 0, 0),
  })
  app.audit?.seed({
    actor: 'user:3:admin',
    actorPlugin: '@dizzyapi/plugin-web',
    action: 'custom.unmapped_action',
    targetType: 'mystery-target',
    targetId: '<img src=x onerror=alert(1)>',
    summary: '一个还没有中文标签的动作',
    metadata: { note: '<script>alert(2)</script>' },
    result: 'failed',
    errorCode: 'AUDIT_STORE_FAILED',
    atMs: Date.UTC(2026, 9, 29, 10, 0, 0),
  })

  const response = await get(app, '/admin/audit')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /操作审计/)
  assert.match(html, /记录总数/)
  assert.match(html, /最近 24 小时/)
  assert.match(html, /失败操作/)
  // 已映射动作：中文标签 + 原始码都在。
  assert.match(html, /调整用户余额/)
  assert.match(html, /user\.balance\.adjust/)
  // 未映射动作：显式显示原始码（不能空白）。
  assert.match(html, /custom\.unmapped_action/)
  // 失败徽标带稳定码。
  assert.match(html, /失败 AUDIT_STORE_FAILED/)
  // 元数据与 targetId 都必须转义。
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'))
  assert.ok(!html.includes('<script>alert(2)</script>'))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('审计页：筛选与分页参数按名传给服务，日期换成毫秒范围', async (t) => {
  const app = await boot(t)
  const response = await get(
    app,
    '/admin/audit?actor=user%3A2%3Aadmin&action=pricing.write&targetType=pricing&from=2026-10-01&to=2026-10-02&offset=50',
  )
  assert.equal(response.status, 200)
  // 页面先 list 再 stats：取最后一个带 query 的读调用。
  const last = [...(app.audit?.reads ?? [])].reverse().find((item) => item.query !== undefined)
  assert.equal(last?.actor, '@dizzyapi/plugin-web')
  assert.equal(last?.query?.actor, 'user:2:admin')
  assert.equal(last?.query?.action, 'pricing.write')
  assert.equal(last?.query?.targetType, 'pricing')
  assert.equal(last?.query?.offset, 50)
  assert.equal(last?.query?.limit, 50)
  assert.equal(last?.query?.fromMs, Date.UTC(2026, 9, 1))
  // to 是「当天结束」，所以是次日 00:00（左闭右开）。
  assert.equal(last?.query?.toMs, Date.UTC(2026, 9, 3))
  assert.match(await response.text(), /全部动作/)
})

test('审计页：缺 audit 服务时降级人话，不白屏', async (t) => {
  const app = await boot(t, { withAudit: false })
  const response = await get(app, '/admin/audit')
  assert.equal(response.status, 200)
  assert.match(await response.text(), /审计服务未运行/)
})

// ───────────────────────────────── 接线 ─────────────────────────────────

test('接线：管理台改余额会记审计（actor / actorPlugin / action / 目标 / 结果）', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/admin/users?action=balance', 'id=2&deltaYuan=1.5&reason=%E8%A1%A5%E5%81%BF')
  assert.equal(response.status, 303)
  assert.ok((response.headers.get('location') ?? '').startsWith('/admin/users?ok='))
  assert.deepEqual(app.user.calls, ['adjust:@dizzyapi/plugin-web:2:1500000'])

  const entry = app.audit?.entries.at(-1)
  assert.equal(entry?.action, 'user.balance.adjust')
  assert.equal(entry?.actor, 'user:2:admin')
  assert.equal(entry?.actorPlugin, '@dizzyapi/plugin-web')
  assert.equal(entry?.targetType, 'user')
  assert.equal(entry?.targetId, '2')
  assert.equal(entry?.result, 'ok')
  assert.equal((entry?.metadata as Record<string, unknown>).deltaMicros, '1500000')
})

test('接线：审计 record 抛错时动作照常成功（旁路纪律）', async (t) => {
  const app = await boot(t)
  app.audit!.failRecord = true
  const response = await post(app, '/admin/users?action=status', 'id=2&status=banned')
  assert.equal(response.status, 303)
  assert.ok((response.headers.get('location') ?? '').startsWith('/admin/users?ok='))
  assert.deepEqual(app.user.calls, ['status:@dizzyapi/plugin-web:2:banned'])
})

test('接线：缺 audit 服务时动作照常成功', async (t) => {
  const app = await boot(t, { withAudit: false })
  const response = await post(app, '/admin/users?action=role', 'id=2&role=user')
  assert.equal(response.status, 303)
  assert.ok((response.headers.get('location') ?? '').startsWith('/admin/users?ok='))
  assert.deepEqual(app.user.calls, ['role:@dizzyapi/plugin-web:2:user'])
})

// ───────────────────────────────── 标签映射自证 ─────────────────────────────────

test('标签映射：源码里出现的每个审计动作码都有中文标签，也没有多余标签', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const pages = readdirSync(`${root}packages/web/src/pages`)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `packages/web/src/pages/${name}`)
  // `/api/*` 的路由处理已按前缀拆到 `packages/api/src/routes/*.ts`，审计动作码跟着搬过去了；
  // 这里必须把 routes 一起扫，否则「标签表里有没接线的码」会对着旧位置误报。
  const apiRoutes = readdirSync(`${root}packages/api/src/routes`)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => `packages/api/src/routes/${name}`)
  const files = ['packages/api/src/http.ts', 'packages/admin/src/service.ts', ...apiRoutes, ...pages]

  const used = new Set<string>()
  for (const file of files) {
    const text = readFileSync(`${root}${file}`, 'utf8')
    // 只收「像审计动作码」的字符串字面量：点分小写，且以已知业务前缀开头。
    for (const match of text.matchAll(/'([a-z][a-z0-9]*(?:\.[a-z][a-z0-9_-]*)+)'/g)) {
      const code = match[1] as string
      if (/^(user|account|redeem|topup|pricing|settings|usage)\./.test(code)) used.add(code)
    }
  }

  assert.ok(used.size >= 20, `扫描到的动作码太少（${used.size}），说明自证逻辑没生效`)
  for (const code of used) {
    assert.ok(code in AUDIT_ACTION_LABELS, `缺少中文标签：${code}`)
  }
  for (const code of Object.keys(AUDIT_ACTION_LABELS)) {
    assert.ok(used.has(code), `标签表里有没接线的动作码：${code}`)
  }
})
