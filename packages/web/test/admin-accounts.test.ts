/**
 * 管理台「上游账号」页的回归测试。
 *
 * 2026-10 线上故障：页面用 `admin.update(id, { enabled })` 调门面，但真实签名是
 * `update(actor, id, patch)`，且 `enabled` 不在 `UPDATE_KEYS`（必须走 enable / disable）。
 * 结果「停用 / 删除」按钮全部失效。这里的断言盯住三件事：
 * 1. 停用 / 启用调用的是 `disable` / `enable`，不是 `update`；
 * 2. 每个写操作都带上了 `WEB_ACTOR`；
 * 3. 删除真的调用 `remove(actor, id)`。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import { WEB_ACTOR, type AccountUpdatePatch } from '../src/runtime.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'

interface Call {
  readonly method: string
  readonly args: readonly unknown[]
}

interface FakeAccount {
  id: string
  label: string
  enabled: boolean
  status: string
  priority: number
  labels: string[]
  weight: number | null
  concurrency: number | null
  health: string
  lastUsedAt: string | null
  autoDisabledAt: string | null
  autoDisabledReason: string | null
  lastTestOk: boolean | null
  lastTestAt: string | null
  lastTestError: string | null
  lastTestLatencyMs: number | null
}

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

/** 门面的替身：记录每次调用的方法名与参数，行为尽量贴真实服务。 */
class FakeAccountAdmin extends Service {
  readonly calls: Call[] = []
  private readonly accounts = new Map<string, FakeAccount>()

  constructor(ctx: Context) {
    super(ctx, 'accountAdmin')
    this.accounts.set('acc-1', {
      id: 'acc-1',
      label: '主账号',
      enabled: true,
      status: 'active',
      priority: 3,
      labels: ['tier:pro'],
      weight: 2.5,
      concurrency: 4,
      health: 'degraded',
      lastUsedAt: '2026-10-27T10:00:00.000Z',
      autoDisabledAt: null,
      autoDisabledReason: null,
      lastTestOk: null,
      lastTestAt: null,
      lastTestError: null,
      lastTestLatencyMs: null,
    })
    this.accounts.set('acc-2', {
      id: 'acc-2',
      label: '备份账号',
      enabled: true,
      status: 'auto_disabled',
      priority: 0,
      labels: [],
      weight: null,
      concurrency: null,
      health: 'unhealthy',
      lastUsedAt: null,
      autoDisabledAt: '2026-10-27T09:00:00.000Z',
      autoDisabledReason: '连续失败 3 次',
      lastTestOk: false,
      lastTestAt: '2026-10-27T08:00:00.000Z',
      lastTestError: 'HTTP 502',
      lastTestLatencyMs: 120,
    })
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  /** 断言最近一次调用的方法名与参数（按顺序逐项比较）。 */
  lastCall(): Call | undefined {
    return this.calls[this.calls.length - 1]
  }

  private view(account: FakeAccount) {
    return {
      ...account,
      provider: 'custom',
      kind: 'api_key',
      credentialConfigured: true,
      credentialRef: `identity/${account.id}`,
      email: null,
      subject: null,
      baseUrl: null,
      protocol: null,
      models: null,
      modelMap: null,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }

  list(_query?: unknown, options?: { readonly view?: string }) {
    this.record('list', _query, options)
    const items = [...this.accounts.values()]
    if (options?.view === 'lite') {
      return items.map((account) => ({
        id: account.id,
        label: account.label,
        provider: 'custom',
        kind: 'api_key',
        enabled: account.enabled,
        status: account.status,
        credentialConfigured: true,
        priority: account.priority,
        labels: account.labels,
        weight: account.weight,
        concurrency: account.concurrency,
        health: account.health,
        autoDisabledAt: account.autoDisabledAt,
        autoDisabledReason: account.autoDisabledReason,
        lastUsedAt: account.lastUsedAt,
        lastTestAt: account.lastTestAt,
        lastTestOk: account.lastTestOk,
        lastTestError: account.lastTestError,
        lastTestLatencyMs: account.lastTestLatencyMs,
      }))
    }
    return items.map((account) => this.view(account))
  }

  get(id: string) {
    this.record('get', id)
    const account = this.accounts.get(id)
    if (account === undefined) throw notFound(id)
    return this.view(account)
  }

  async update(actor: string, id: string, patch: AccountUpdatePatch) {
    this.record('update', actor, id, patch)
    const account = this.require(id)
    if (patch.label !== undefined) account.label = patch.label
    if (patch.labels !== undefined) account.labels = patch.labels === null ? [] : [...patch.labels]
    if (patch.weight !== undefined) account.weight = patch.weight
    if (patch.concurrency !== undefined) account.concurrency = patch.concurrency
    if (patch.priority !== undefined) account.priority = patch.priority
    return this.view(account)
  }

  async remove(actor: string, id: string): Promise<void> {
    this.record('remove', actor, id)
    this.accounts.delete(id)
  }

  async enable(actor: string, id: string) {
    this.record('enable', actor, id)
    const account = this.require(id)
    account.enabled = true
    return this.view(account)
  }

  async disable(actor: string, id: string) {
    this.record('disable', actor, id)
    const account = this.require(id)
    account.enabled = false
    return this.view(account)
  }

  async refresh(actor: string, id: string) {
    this.record('refresh', actor, id)
    return this.view(this.require(id))
  }

  async setHealth(actor: string, id: string, health: string) {
    this.record('setHealth', actor, id, health)
    const account = this.require(id)
    account.health = health
    return this.view(account)
  }

  async autoDisable(actor: string, id: string, reason: string) {
    this.record('autoDisable', actor, id, reason)
    const account = this.require(id)
    account.status = 'auto_disabled'
    account.autoDisabledReason = reason
    return this.view(account)
  }

  async autoEnable(actor: string, id: string) {
    this.record('autoEnable', actor, id)
    const account = this.require(id)
    account.status = 'active'
    account.autoDisabledAt = null
    account.autoDisabledReason = null
    return this.view(account)
  }

  async bulkUpdate(actor: string, ids: readonly string[], patch: AccountUpdatePatch) {
    this.record('bulkUpdate', actor, [...ids], patch)
    const items = ids.map((id) => ({ id, ok: true, account: this.view(this.require(id)), error: null }))
    return { total: items.length, succeeded: items.length, failed: 0, items }
  }

  async bulkEnable(actor: string, ids: readonly string[]) {
    this.record('bulkEnable', actor, [...ids])
    return { total: ids.length, succeeded: ids.length, failed: 0, items: [] }
  }

  async bulkDisable(actor: string, ids: readonly string[]) {
    this.record('bulkDisable', actor, [...ids])
    return { total: ids.length, succeeded: ids.length, failed: 0, items: [] }
  }

  async testConnection(id: string) {
    this.record('testConnection', id)
    return { ok: true, status: 200, latencyMs: 42, model: 'gpt-5', error: null }
  }

  private require(id: string): FakeAccount {
    const account = this.accounts.get(id)
    if (account === undefined) throw notFound(id)
    return account
  }

  has(id: string): boolean {
    return this.accounts.has(id)
  }
}

interface App {
  readonly base: string
  readonly admin: FakeAccountAdmin
  readonly close: () => Promise<void>
}

async function boot(t: TestContext): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    await ctx.plugin(FakeAccountAdmin)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let i = 0; i < 100; i += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: ctx.get('accountAdmin') as unknown as FakeAccountAdmin,
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
    admin: started.app,
    close: async () => {
      await started.close()
    },
  }
}

async function post(app: App, path: string, body: string): Promise<Response> {
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

test('回归：停用按钮走 disable(WEB_ACTOR)，不是 update', async (t) => {
  const app = await boot(t)
  // 列表行上只剩「详情」，开关按钮收在详情页（owner 第 9 条：操作收进「编辑」）。
  const response = await post(app, '/admin/accounts/detail?action=disable&id=acc-1', 'id=acc-1')
  assert.equal(response.status, 303)
  const location = response.headers.get('location') ?? ''
  assert.equal(location.startsWith('/admin/accounts/detail?id=acc-1&ok='), true)

  const call = app.admin.lastCall()
  assert.equal(call?.method, 'disable')
  assert.deepEqual(call?.args, [WEB_ACTOR, 'acc-1'])
  assert.equal(
    app.admin.calls.some((item) => item.method === 'update'),
    false,
    '停用不该再走 update（这正是 2026-10 的线上故障）',
  )
})

test('回归：启用按钮走 enable(WEB_ACTOR)', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/admin/accounts/detail?action=enable&id=acc-1', 'id=acc-1')
  assert.equal(response.status, 303)
  assert.equal(app.admin.lastCall()?.method, 'enable')
  assert.deepEqual(app.admin.lastCall()?.args, [WEB_ACTOR, 'acc-1'])
})

test('回归：删除按钮走 remove(WEB_ACTOR) 并真的删掉账号', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/admin/accounts/detail?action=remove&id=acc-1', 'id=acc-1')
  assert.equal(response.status, 303)
  assert.equal(response.headers.get('location'), '/admin/accounts?ok=' + encodeURIComponent('账号已删除'))
  assert.equal(app.admin.lastCall()?.method, 'remove')
  assert.deepEqual(app.admin.lastCall()?.args, [WEB_ACTOR, 'acc-1'])
  assert.equal(app.admin.has('acc-1'), false)
})

test('列表页：渲染标签 / 权重 / 并发 / 健康 / 最近使用，用 lite 视图', async (t) => {
  const app = await boot(t)
  const response = await fetch(`${app.base}/admin/accounts`, { headers: { cookie: SESSION_COOKIE } })
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.ok(html.includes('主账号'))
  assert.ok(html.includes('tier:pro'))
  assert.ok(html.includes('降级'), '健康徽章要有中文说明')
  assert.ok(html.includes('2.5'), '权重要显示')
  assert.ok(html.includes('2026-10-27 10:00 UTC'), '最近使用要显示')
  assert.ok(html.includes('连续失败 3 次'), '自动停用原因要显示')
  assert.ok(html.includes('accounts-bulk'), '批量表单要渲染出来')

  const listCall = app.admin.calls.find((item) => item.method === 'list')
  assert.deepEqual(listCall?.args?.[1], { view: 'lite' }, '列表页应当只取精简字段')
})

test('详情页：分组折叠 + 保存调度参数带 WEB_ACTOR', async (t) => {
  const app = await boot(t)
  const response = await fetch(`${app.base}/admin/accounts/detail?id=acc-1`, { headers: { cookie: SESSION_COOKIE } })
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.ok(html.includes('<details'))
  assert.ok(html.includes('调度参数'))
  assert.ok(html.includes('解除自动停用') === false, '非自动停用的账号不该出现恢复按钮')

  const saved = await post(
    app,
    '/admin/accounts/detail?action=scheduling&id=acc-1',
    'id=acc-1&labels=tier%3Afree%2C+beta&weight=3&concurrency=8&priority=7',
  )
  assert.equal(saved.status, 303)
  const call = app.admin.lastCall()
  assert.equal(call?.method, 'update')
  assert.equal(call?.args?.[0], WEB_ACTOR)
  assert.equal(call?.args?.[1], 'acc-1')
  assert.deepEqual(call?.args?.[2], {
    labels: ['tier:free', 'beta'],
    weight: 3,
    concurrency: 8,
    priority: 7,
  })
})

test('详情页：上游协议下拉含 gemini，保存基本信息能提交 gemini', async (t) => {
  const app = await boot(t)
  const page = await fetch(`${app.base}/admin/accounts/detail?id=acc-1`, { headers: { cookie: SESSION_COOKIE } })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.ok(html.includes('value="gemini"'), '详情页应能选 gemini 协议')

  const saved = await post(app, '/admin/accounts/detail?action=update&id=acc-1', 'id=acc-1&protocol=gemini&label=acc-1')
  assert.equal(saved.status, 303)
  const call = app.admin.lastCall()
  assert.equal(call?.method, 'update')
  assert.equal(call?.args?.[0], WEB_ACTOR)
  assert.equal((call?.args?.[2] as Record<string, unknown>).protocol, 'gemini')
})

test('详情页：自动停用账号给出恢复入口，恢复走 autoEnable(WEB_ACTOR)', async (t) => {
  const app = await boot(t)
  const page = await fetch(`${app.base}/admin/accounts/detail?id=acc-2`, { headers: { cookie: SESSION_COOKIE } })
  const html = await page.text()
  assert.ok(html.includes('解除自动停用'))

  const response = await post(app, '/admin/accounts/detail?action=recover&id=acc-2', 'id=acc-2')
  assert.equal(response.status, 303)
  assert.equal(app.admin.lastCall()?.method, 'autoEnable')
  assert.deepEqual(app.admin.lastCall()?.args, [WEB_ACTOR, 'acc-2'])
})

test('批量：停用勾选的账号；改字段只提交勾选过的键', async (t) => {
  const app = await boot(t)

  const disabled = await post(app, '/admin/accounts?action=bulk', 'op=disable&ids=acc-1&ids=acc-2')
  assert.equal(disabled.status, 303)
  assert.equal(app.admin.lastCall()?.method, 'bulkDisable')
  assert.deepEqual(app.admin.lastCall()?.args, [WEB_ACTOR, ['acc-1', 'acc-2']])

  const updated = await post(
    app,
    '/admin/accounts?action=bulk',
    'op=update&ids=acc-1&useWeight=1&weight=1.5&labels=tier%3Afree',
  )
  assert.equal(updated.status, 303)
  const call = app.admin.lastCall()
  assert.equal(call?.method, 'bulkUpdate')
  assert.deepEqual(call?.args, [WEB_ACTOR, ['acc-1'], { weight: 1.5 }], '没勾开关的字段不该出现')
})

test('批量：一个字段都没勾时回到页面带明确错误，不调用服务', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/admin/accounts?action=bulk', 'op=update&ids=acc-1')
  assert.equal(response.status, 303)
  const location = response.headers.get('location') ?? ''
  assert.ok(location.includes('err='))
  assert.equal(location.includes(encodeURIComponent('先勾选至少一个要修改的字段')), true)
  assert.equal(
    app.admin.calls.some((item) => item.method === 'bulkUpdate'),
    false,
  )
})

test('详情页：非管理员回 403；缺 id 与不存在的账号给人话', async (t) => {
  const app = await boot(t)
  const noSession = await fetch(`${app.base}/admin/accounts/detail?id=acc-1`, { redirect: 'manual' })
  assert.equal(noSession.status, 302)
  assert.equal(noSession.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))

  const missing = await fetch(`${app.base}/admin/accounts/detail`, { headers: { cookie: SESSION_COOKIE } })
  assert.equal(missing.status, 200)
  assert.ok((await missing.text()).includes('缺少账号 id'))

  const unknown = await fetch(`${app.base}/admin/accounts/detail?id=acc-nope`, { headers: { cookie: SESSION_COOKIE } })
  assert.equal(unknown.status, 200)
  assert.ok((await unknown.text()).includes('没有账号 acc-nope'))
})

test('服务缺失：列表页给人话，不白屏', async (t) => {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let i = 0; i < 100; i += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined)
    return {
      app: undefined,
      port: address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  t.after(async () => {
    await started.close()
  })
  const response = await fetch(`${started.base}/admin/accounts`, {
    headers: { cookie: SESSION_COOKIE },
  })
  assert.equal(response.status, 200)
  assert.ok((await response.text()).includes('账号服务未运行'))
})

/** 真实 identity 的错误带稳定 code；页面只对带 code 的领域错误显示原文。 */
function notFound(id: string): Error & { code: string } {
  const error = new Error(`没有账号 ${id}`) as Error & { code: string }
  error.code = 'IDENTITY_ACCOUNT_NOT_FOUND'
  return error
}