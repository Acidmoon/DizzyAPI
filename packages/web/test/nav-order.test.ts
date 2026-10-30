/**
 * 侧栏拖动排序（第 12 条）的服务端部分。
 *
 * 分两块：
 * 1. **纯函数**（`nav-order.ts`）：套用顺序 / 净化提交值 / 拆逗号；
 * 2. **动作**（`/console/profile?action=nav-order`）：真的落到 `user.setUiPreferences`，
 *    且 fetch 提交（`X-Requested-With`）回 204 而不是 303。
 *
 * 三条规则（owner 口径）：
 * - 只接受**默认表里有的路径**，未知路径丢弃；
 * - 默认表里缺的路径**按默认顺序补到末尾**（以后新加侧栏项，老偏好不能把它藏掉）；
 * - 顺序存 `ui_preferences.navOrder`，`user` 是唯一写者（web 不另存）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import { applyNavOrder, normalizeNavOrder, splitNavOrder } from '../src/nav-order.ts'
import { ADMIN_NAV, CONSOLE_NAV } from '../src/layout.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'
const USER_ID = 1

// ───────────────────────────── 纯函数 ─────────────────────────────

const DEFAULTS = [
  { path: '/a', label: 'A' },
  { path: '/b', label: 'B' },
  { path: '/c', label: 'C' },
]

test('顺序：没设过偏好就是站默认顺序', () => {
  assert.deepEqual(applyNavOrder(DEFAULTS, []).map((item) => item.path), ['/a', '/b', '/c'])
})

test('顺序：用户顺序生效', () => {
  assert.deepEqual(applyNavOrder(DEFAULTS, ['/c', '/a', '/b']).map((item) => item.path), ['/c', '/a', '/b'])
})

test('顺序：未知路径丢弃（旧版本存过、后来页面被删了）', () => {
  assert.deepEqual(
    applyNavOrder(DEFAULTS, ['/gone', '/c', '/a', '/b']).map((item) => item.path),
    ['/c', '/a', '/b'],
  )
})

test('顺序：默认表里缺的路径按默认顺序补到末尾（新加侧栏项不会被藏掉）', () => {
  // 用户只拖过 /c 和 /a，/b 是后来新加的：必须出现在末尾，不是消失
  assert.deepEqual(applyNavOrder(DEFAULTS, ['/c', '/a']).map((item) => item.path), ['/c', '/a', '/b'])
})

test('顺序：重复路径只认第一次（防止手工改库造成的抖动）', () => {
  assert.deepEqual(applyNavOrder(DEFAULTS, ['/b', '/b', '/a']).map((item) => item.path), ['/b', '/a', '/c'])
})

test('顺序：默认项一个都不丢（永远返回同样多的一项）', () => {
  for (const stored of [[], ['/b'], ['/x', '/y'], ['/c', '/b', '/a']]) {
    assert.equal(applyNavOrder(DEFAULTS, stored).length, DEFAULTS.length)
  }
})

test('顺序：净化提交值——未知路径丢弃、去重', () => {
  assert.deepEqual(normalizeNavOrder(DEFAULTS, ['/c', '/x', '/c', '/a']), ['/c', '/a'])
})

test('顺序：净化后仍是「默认表的子集」，不会写进默认表里没有的东西', () => {
  const cleaned = normalizeNavOrder(DEFAULTS, ['/c', '/b'])
  for (const path of cleaned) assert.ok(DEFAULTS.some((item) => item.path === path))
})

test('顺序：逗号串的解析（空串 → 空数组，两侧空白去掉）', () => {
  assert.deepEqual(splitNavOrder(''), [])
  assert.deepEqual(splitNavOrder(undefined), [])
  assert.deepEqual(splitNavOrder(null), [])
  assert.deepEqual(splitNavOrder('/a,/b'), ['/a', '/b'])
  assert.deepEqual(splitNavOrder(' /a , , /b '), ['/a', '/b'])
})

test('顺序：两个区域各自有默认表，路径互不重叠（一份 navOrder 够用）', () => {
  const consolePaths = new Set(CONSOLE_NAV.map((item) => item.path))
  const adminPaths = new Set(ADMIN_NAV.map((item) => item.path))
  for (const path of adminPaths) {
    assert.equal(consolePaths.has(path), false, `${path} 同时出现在两个区域的侧栏里`)
  }
  // 用户站里没有的路径会被管理台侧栏自然忽略（applyNavOrder 的丢弃逻辑）
  assert.equal(applyNavOrder(ADMIN_NAV, ['/console/usage']).length, ADMIN_NAV.length)
})

// ───────────────────────────── 真 HTTP ─────────────────────────────

class FakeAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'auth')
  }

  async verifySession(token: string) {
    if (token !== 'test-token') throw new Error('会话无效')
    return {
      sessionId: 's1',
      userId: USER_ID,
      user: {
        id: USER_ID,
        name: '用户',
        status: 'enabled' as const,
        role: 'admin' as const,
        balance: 0n,
        balanceEnabled: false,
        concurrencyLimit: null,
        avatar: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
  }

  async logout(): Promise<void> {}
}

/** 偏好桩：只实现页面与动作会用到的方法，并把每次写入记下来。 */
class FakeUser extends Service {
  readonly writes: unknown[] = []
  private preferences = { fontScale: 1, letterSpacing: 'normal', navOrder: [] as string[] }

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  async getUiPreferences() {
    return { ...this.preferences, navOrder: [...this.preferences.navOrder] }
  }

  async setUiPreferences(_id: number, patch: unknown) {
    this.writes.push(patch)
    const next = patch as { navOrder?: string[] }
    if (Array.isArray(next.navOrder)) this.preferences.navOrder = [...next.navOrder]
    return this.getUiPreferences()
  }
}

async function boot(): Promise<{ base: string; user: FakeUser; close(): Promise<void> }> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    await ctx.plugin(FakeUser)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: ctx.get('user') as unknown as FakeUser,
      port: address.port,
      close: async () => { await web.close() },
    }
  })
  return { base: started.base, user: started.app, close: async () => { await started.close() } }
}

function post(base: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}/console/profile?action=nav-order`, {
    method: 'POST',
    headers: {
      cookie: SESSION_COOKIE,
      origin: base,
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  })
}

test('落库：fetch 提交回 204（不跟着 303 把整页再拉一遍）', async () => {
  const app = await boot()
  try {
    const response = await post(app.base, {
      area: 'console',
      navOrder: '/console/models,/console/usage',
    }, { 'x-requested-with': 'dizzyapi' })
    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
    // 真的写到 user 插件（web 侧不另存）
    assert.equal(app.user.writes.length, 1)
    const patch = app.user.writes[0] as { navOrder: string[] }
    assert.deepEqual(patch.navOrder, ['/console/models', '/console/usage'])
  } finally {
    await app.close()
  }
})

test('落库：普通表单提交仍走 303（PRG 不变）', async () => {
  const app = await boot()
  try {
    const response = await post(app.base, { area: 'console', navOrder: '/console/models' })
    assert.equal(response.status, 303)
    assert.match(response.headers.get('location') ?? '', /^\/console\/profile\?ok=/)
  } finally {
    await app.close()
  }
})

test('落库：未知路径在写库前就被丢掉（用户站侧栏只有那 8 项）', async () => {
  const app = await boot()
  try {
    await post(app.base, {
      area: 'console',
      navOrder: '/console/usage,/nope,/admin/users,/console/usage',
    }, { 'x-requested-with': 'dizzyapi' })
    const patch = app.user.writes[0] as { navOrder: string[] }
    assert.deepEqual(patch.navOrder, ['/console/usage'])
  } finally {
    await app.close()
  }
})

test('落库：区域选 admin 时按管理台默认表过滤（两个区域互不串味）', async () => {
  const app = await boot()
  try {
    await post(app.base, {
      area: 'admin',
      navOrder: '/admin/audit,/console/usage,/admin/users',
    }, { 'x-requested-with': 'dizzyapi' })
    const patch = app.user.writes[0] as { navOrder: string[] }
    assert.deepEqual(patch.navOrder, ['/admin/audit', '/admin/users'])
  } finally {
    await app.close()
  }
})

test('落库：未登录 302，一个字节都不写', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/console/profile?action=nav-order`, {
      method: 'POST',
      headers: { origin: app.base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ area: 'console', navOrder: '/console/usage' }).toString(),
      redirect: 'manual',
    })
    assert.equal(response.status, 302)
    assert.equal(app.user.writes.length, 0)
  } finally {
    await app.close()
  }
})

test('落库：跨站提交被拒，一个字节都不写', async () => {
  const app = await boot()
  try {
    const response = await post(app.base, { area: 'console', navOrder: '/console/usage' }, {
      origin: 'https://evil.example',
    })
    assert.notEqual(response.status, 204)
    assert.equal(app.user.writes.length, 0)
  } finally {
    await app.close()
  }
})

test('渲染：存进去的顺序真的反映在侧栏（服务端渲染，无 JS 也生效）', async () => {
  const app = await boot()
  try {
    await post(app.base, {
      area: 'console',
      navOrder: '/console/profile,/console/usage',
    }, { 'x-requested-with': 'dizzyapi' })

    const html = await (await fetch(`${app.base}/console/profile`, {
      headers: { cookie: SESSION_COOKIE },
    })).text()
    // 个人资料现在排第一，用量信息第二
    const profileAt = html.indexOf('data-nav-path="/console/profile"')
    const usageAt = html.indexOf('data-nav-path="/console/usage"')
    assert.ok(profileAt > 0 && usageAt > profileAt, '侧栏顺序没按存进去的渲染')
    // 没有提到的项按默认顺序补在末尾（不是消失）
    assert.ok(html.indexOf('data-nav-path="/console/models"') > usageAt)
  } finally {
    await app.close()
  }
})
