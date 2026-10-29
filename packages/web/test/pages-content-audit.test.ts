/**
 * 管理台内容审核页（`/admin/content-audit`）的测试。
 *
 * 真起 web 服务 + 表单 POST，盯住六件事：
 * 1. 规则列表、状态卡、命中明细都渲染出来，`block` / `log` 有区分；
 * 2. **关键词与备注来自管理员手填，必须转义**（不能变成可执行 HTML）；
 * 3. Go 侧读不到时显示「未知」而不是 0 命中、不假装快照新鲜；
 * 4. 总开关关闭 / 快照过期 / 推送跟不上 / 连续失败都有明确提示；
 * 5. 新增 / 编辑 / 启停 / 删除 / 立刻推送都走 303，并调对服务方法；
 * 6. 写动作留审计（actor 是会话里的真人，元数据里没有关键字）；缺服务不白屏。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import type {
  ContentAuditRuleView,
  ContentAuditStatusView,
  WebRuntime,
} from '../src/runtime.ts'
import type { AuditEntryView } from '../src/runtime.ts'

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
        name: 'owner',
        status: 'enabled' as const,
        role: 'admin' as const,
        balance: 0n,
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

function ruleOf(patch: Partial<ContentAuditRuleView> & { id: string }): ContentAuditRuleView {
  return {
    pattern: 'seed-word',
    action: 'block',
    enabled: true,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    ...patch,
  }
}

/** 假内容审核服务：只实现页面会调到的方法，记录动作与参数。 */
class FakeContentAudit extends Service {
  readonly calls: string[] = []
  readonly rules: ContentAuditRuleView[] = [
    // 故意放一段像标签的关键词与备注：页面必须转义。
    ruleOf({ id: 'car_seed', pattern: 'evil<script>alert(1)</script>', note: '<img src=x onerror=alert(2)>' }),
    ruleOf({ id: 'car_log', pattern: 'log-only', action: 'log', enabled: false, category: 'spam' }),
  ]
  statusView: ContentAuditStatusView = {
    enabled: true,
    pushIntervalMs: 5_000,
    ruleCount: 2,
    revision: 'rev-seed',
    generation: 42,
    ageMs: 1_200,
    ttlMs: 15_000,
    stale: false,
    goReady: true,
    lastPushAt: '2026-10-29T12:00:00.000Z',
    lastError: null,
    pushes: 11,
    heartbeats: 10,
    failureStreak: 0,
    goTtlMs: 15_000,
    heartbeatTooSlow: false,
    hits: {
      blocked: 3,
      logged: 1,
      allowedStale: 0,
      strictFailed: 0,
      parseFailed: 2,
      noText: 41,
      truncated: 0,
      ruleHitTotal: 4,
      byRule: { car_seed: 4 },
      staleStreak: 0,
    },
  }

  pushResult: string | null = 'rev-pushed'

  constructor(ctx: Context) {
    super(ctx, 'contentAudit')
  }

  list(actor: string): readonly ContentAuditRuleView[] {
    this.calls.push(`list:${actor}`)
    return this.rules.map((rule) => ({ ...rule }))
  }

  async create(actor: string, input: Record<string, unknown>): Promise<ContentAuditRuleView> {
    this.calls.push(`create:${actor}:${JSON.stringify(input)}`)
    return ruleOf({ id: 'car_new', pattern: String(input.pattern) })
  }

  async update(actor: string, id: string, patch: Record<string, unknown>): Promise<ContentAuditRuleView> {
    this.calls.push(`update:${actor}:${id}:${JSON.stringify(patch)}`)
    return ruleOf({ id, enabled: patch.enabled !== false })
  }

  async remove(actor: string, id: string): Promise<boolean> {
    this.calls.push(`remove:${actor}:${id}`)
    return id !== 'missing'
  }

  async status(): Promise<ContentAuditStatusView> {
    return this.statusView
  }

  async pushNow(): Promise<string | null> {
    this.calls.push('pushNow')
    return this.pushResult
  }
}

/** 假审计服务：只记下来，让用例断言「谁、什么动作、带没带关键字」。 */
class FakeAudit extends Service {
  readonly records: AuditEntryView[] = []
  failRecord = false

  constructor(ctx: Context) {
    super(ctx, 'audit')
  }

  record(entry: AuditEntryView): AuditEntryView {
    if (this.failRecord) throw new Error('审计库坏了')
    this.records.push(entry)
    return entry
  }
}

interface App {
  readonly base: string
  readonly contentAudit: FakeContentAudit | undefined
  readonly audit: FakeAudit | undefined
}

async function boot(
  t: TestContext,
  options: { withContentAudit?: boolean; withAudit?: boolean } = {},
): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    if (options.withContentAudit !== false) await ctx.plugin(FakeContentAudit)
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
        contentAudit:
          options.withContentAudit === false
            ? undefined
            : (ctx.get('contentAudit') as unknown as FakeContentAudit),
        audit: options.withAudit === false ? undefined : (ctx.get('audit') as unknown as FakeAudit),
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
  return { base: started.base, contentAudit: started.app.contentAudit, audit: started.app.audit }
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

// ───────────────────────────────── 渲染 ─────────────────────────────────

test('页面渲染：规则表、状态卡、命中明细、按规则命中', async (t) => {
  const app = await boot(t)
  const response = await get(app, '/admin/content-audit')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /内容审核/)
  // 规则与动作区分
  assert.match(html, /命中即拒绝/)
  assert.match(html, /命中只记日志/)
  assert.match(html, /car_log/)
  assert.match(html, /spam/)
  // 状态卡与命中明细
  assert.match(html, /规则总数/)
  assert.match(html, /启用中/)
  assert.match(html, /拦截次数/)
  assert.match(html, /1200 ms/)
  assert.match(html, /15000 ms/)
  assert.match(html, /只记日志 1/)
  assert.match(html, /解析失败放行 2/)
  assert.match(html, /无可审文本 41/)
  assert.match(html, /rev-seed/)
  // 按规则命中表
  assert.match(html, /按规则命中/)

  // 关键词与备注必须转义
  assert.ok(!html.includes('<script>alert(1)</script>'), '关键词必须转义')
  assert.ok(!html.includes('<img src=x onerror=alert(2)>'), '备注必须转义')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)

  // 表单入口都在
  assert.match(html, /action="\/admin\/content-audit\?action=create"/)
  assert.match(html, /action="\/admin\/content-audit\?action=toggle"/)
  assert.match(html, /action="\/admin\/content-audit\?action=delete"/)
  assert.match(html, /action="\/admin\/content-audit\?action=edit"/)
})

test('Go 侧读不到：明说「未知」，不显示成 0 命中、不假装快照新鲜', async (t) => {
  const app = await boot(t)
  const contentAudit = app.contentAudit as FakeContentAudit
  contentAudit.statusView = {
    ...contentAudit.statusView,
    ageMs: null,
    ttlMs: null,
    stale: null,
    goReady: null,
    hits: null,
  }

  const html = await (await get(app, '/admin/content-audit')).text()
  assert.match(html, /读不到 Go 侧状态/)
  assert.match(html, /不是 0/)
  // 状态卡里是占位符而不是数字 0
  assert.match(html, /命中明细：—/)
  assert.ok(!html.includes('拦截次数</div>\n<div class="metric-value">0'))
})

test('健康度提示：总开关关闭 / 快照过期 / 推送跟不上 / 连续失败', async (t) => {
  const app = await boot(t)
  const contentAudit = app.contentAudit as FakeContentAudit
  contentAudit.statusView = {
    ...contentAudit.statusView,
    enabled: false,
    stale: true,
    heartbeatTooSlow: true,
    goTtlMs: 4_000,
    failureStreak: 3,
    lastError: '桥断线',
  }

  const html = await (await get(app, '/admin/content-audit')).text()
  assert.match(html, /审核总开关是关闭的/)
  assert.match(html, /规则快照已过期/)
  assert.match(html, /TTL 必须 ≥ 3 × 间隔/)
  assert.match(html, /连续 3 次推送失败/)
  assert.match(html, /桥断线/)
})

test('缺插件：页面给人话，不白屏', async (t) => {
  const app = await boot(t, { withContentAudit: false })
  const response = await get(app, '/admin/content-audit')
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /内容审核插件未运行/)
  assert.match(html, /照常放行/)
})

// ───────────────────────────────── 写动作 ─────────────────────────────────

test('新增规则：303 回页面、调服务、留审计（元数据里没有关键字）', async (t) => {
  const app = await boot(t)
  const response = await post(
    app,
    '/admin/content-audit?action=create',
    'pattern=SecretWord&action=log&category=abuse&note=%E5%A4%87%E6%B3%A8',
  )
  assert.equal(response.status, 303)
  const location = response.headers.get('location') ?? ''
  assert.ok(location.startsWith('/admin/content-audit?ok='), location)

  const created = app.contentAudit?.calls.find((call) => call.startsWith('create:'))
  assert.ok(created !== undefined, '必须调 create')
  assert.match(created, /@dizzyapi\/plugin-web/)
  assert.match(created, /"pattern":"SecretWord"/)
  assert.match(created, /"action":"log"/)

  const entry = app.audit?.records.at(-1) as AuditEntryView
  assert.equal(entry.action, 'content_audit.rule.create')
  assert.equal(entry.actor, 'user:1:admin')
  assert.equal(entry.actorPlugin, '@dizzyapi/plugin-web')
  assert.equal(entry.result, 'ok')
  assert.ok(!JSON.stringify(entry).includes('SecretWord'), '审计里不该出现关键词本身')

  const follow = await get(app, location)
  assert.equal(follow.status, 200)
  assert.match(await follow.text(), /已新增审核规则/)
})

test('编辑 / 启停 / 删除 / 立刻推送：都走 303 并调对方法', async (t) => {
  const app = await boot(t)

  const edited = await post(
    app,
    '/admin/content-audit?action=edit',
    'ruleId=car_seed&pattern=new-word&action=block&category=&note=',
  )
  assert.equal(edited.status, 303)
  const editCall = app.contentAudit?.calls.find((call) => call.startsWith('update:')) ?? ''
  assert.match(editCall, /car_seed/)
  // 空表单字段 → null（服务层用它表达清空）
  assert.match(editCall, /"category":null/)
  assert.match(editCall, /"note":null/)

  const toggled = await post(app, '/admin/content-audit?action=toggle', 'ruleId=car_seed&enabled=0')
  assert.equal(toggled.status, 303)
  assert.ok(app.contentAudit?.calls.some((call) => call.includes('car_seed') && call.includes('"enabled":false')))

  const deleted = await post(app, '/admin/content-audit?action=delete', 'ruleId=car_seed')
  assert.equal(deleted.status, 303)
  assert.ok(app.contentAudit?.calls.includes('remove:@dizzyapi/plugin-web:car_seed'))

  const pushed = await post(app, '/admin/content-audit?action=push', '')
  assert.equal(pushed.status, 303)
  assert.ok(app.contentAudit?.calls.includes('pushNow'))
  assert.match(await (await get(app, pushed.headers.get('location') ?? '')).text(), /已推送：revision rev-pushed/)

  // 三类写动作都留了审计
  const actions = (app.audit?.records ?? []).map((entry) => entry.action)
  assert.deepEqual(actions, [
    'content_audit.rule.update',
    'content_audit.rule.update',
    'content_audit.rule.delete',
  ])
})

test('推送失败与删除不存在的规则：页面给人话，不抛 500', async (t) => {
  const app = await boot(t)
  const contentAudit = app.contentAudit as FakeContentAudit
  contentAudit.pushResult = null

  const pushed = await post(app, '/admin/content-audit?action=push', '')
  assert.equal(pushed.status, 303)
  assert.match(
    await (await get(app, pushed.headers.get('location') ?? '')).text(),
    /推送失败/,
  )

  const missing = await post(app, '/admin/content-audit?action=delete', 'ruleId=missing')
  assert.equal(missing.status, 303)
  assert.match(await (await get(app, missing.headers.get('location') ?? '')).text(), /此前已被删除/)
})

test('审计挂了不影响写动作（审计是旁路）', async (t) => {
  const app = await boot(t)
  const audit = app.audit as FakeAudit
  audit.failRecord = true

  const response = await post(app, '/admin/content-audit?action=create', 'pattern=still-works&action=block')
  assert.equal(response.status, 303, '审计抛错不能让写动作失败')
  assert.ok(app.contentAudit?.calls.some((call) => call.includes('still-works')))
})

test('白名单外的写 / 非法动作参数：给 stable code，不是 500', async (t) => {
  const app = await boot(t)
  const bad = await post(app, '/admin/content-audit?action=create', 'pattern=x&action=drop')
  assert.equal(bad.status, 303)
  const html = await (await get(app, bad.headers.get('location') ?? '')).text()
  assert.match(html, /动作只能是拒绝或只记日志/)

  const noPattern = await post(app, '/admin/content-audit?action=create', 'action=block')
  assert.equal(noPattern.status, 303)
  assert.match(await (await get(app, noPattern.headers.get('location') ?? '')).text(), /关键词不能为空/)
})

/** 只为类型检查：WebRuntime 里的 contentAudit 就是上面这个假实现。 */
const _shape: keyof WebRuntime = 'contentAudit'
void _shape
