/**
 * 侧栏局部刷新（第 4 批）的**服务端契约**。
 *
 * 三条硬要求（总工拍板）：
 * 1. **片段必须与整页 `<main>` 那一截逐字相同**——同一条渲染路径，不许两个函数各拼；
 * 2. **顺序不许变**：Host → 会话 → 鉴权 → **最后**才按 `HX-Request` 决定回片段，
 *    未登录的 HX 请求照样 302；
 * 3. **`data-page-title` == 整页 `<title>`**（同一个变量），`data-page-path` 供侧栏高亮。
 *
 * 另外守住无 JS 退化：脚本没跑时链接照样是普通 `<a href>`（整页跳）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'
const USER_ID = 1

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

interface App {
  readonly base: string
  close(): Promise<void>
}

async function boot(): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return { app: ctx, port: address.port, close: async () => { await web.close() } }
  })
  return { base: started.base, close: async () => { await started.close() } }
}

function get(app: App, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${app.base}${path}`, { headers: { cookie: SESSION_COOKIE, ...headers }, redirect: 'manual' })
}

/** 从整页 HTML 里切 `<main>`那一截（与 `extractMainColumn` 同一套规则）。 */
function mainSlice(html: string): string {
  const start = html.indexOf('<main class="main"')
  assert.ok(start >= 0, '整页里必须有 <main>')
  const end = html.lastIndexOf('</main>')
  assert.ok(end > start, '整页里必须有 </main>')
  return html.slice(start, end + '</main>'.length)
}

// ─────────────────────── 片段 === 整页那一截 ───────────────────────

test('局部刷新：HX 请求回主列片段，与整页 `<main>` 那一截逐字相同', async () => {
  const app = await boot()
  try {
    const full = await get(app, '/console/profile')
    assert.equal(full.status, 200)
    const fullHtml = await full.text()
    assert.ok(fullHtml.startsWith('<!doctype html>'), '普通请求必须是整页')

    const hx = await get(app, '/console/profile', { 'hx-request': 'true' })
    assert.equal(hx.status, 200)
    const fragment = await hx.text()
    // 这是本批最关键的断言：两条路径不许漂移
    assert.equal(fragment, mainSlice(fullHtml))
    // 片段自身必须是完整的 <main> 元素（hx-swap="outerHTML" 靠它替换）
    assert.ok(fragment.startsWith('<main class="main"'))
    assert.ok(fragment.endsWith('</main>'))
    // 不许把整页塞回来（含 <!doctype> / <head> / 侧栏）
    assert.ok(!fragment.includes('<!doctype'))
    assert.ok(!fragment.includes('<aside class="side">'))
    assert.ok(!fragment.includes('<html'))

    // 片段也不许是「缓存一份旧页面」：内容随页面变
    assert.ok(fragment.includes('个人资料'))
  } finally {
    await app.close()
  }
})

test('局部刷新：多个页面都满足「片段 === 整页那一截」', async () => {
  const app = await boot()
  try {
    for (const path of ['/console/profile', '/admin/users', '/admin/audit', '/console/api-keys']) {
      const full = await (await get(app, path)).text()
      const fragment = await (await get(app, path, { 'hx-request': 'true' })).text()
      assert.equal(fragment, mainSlice(full), `${path} 的片段与整页不一致`)
    }
  } finally {
    await app.close()
  }
})

// ─────────────────────── 顺序：鉴权在 HX 判断之前 ───────────────────────

test('局部刷新：未登录的 HX 请求照样 302（不许拿到片段）', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/console/profile`, {
      headers: { 'hx-request': 'true' },
      redirect: 'manual',
    })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))
    const body = await response.text()
    assert.equal(body, '', '302 不该带片段正文')
  } finally {
    await app.close()
  }
})

// ─────────────────────── 标题与高亮的数据 ───────────────────────

test('局部刷新：data-page-title 就是整页 <title>，data-page-path 是当前路径', async () => {
  const app = await boot()
  try {
    const full = await (await get(app, '/admin/users')).text()
    const title = /<title>([^<]*)<\/title>/.exec(full)?.[1]
    assert.ok(title !== undefined)
    assert.equal(title, '用户 · 管理台 · DizzyAPI', '管理台标题带页面名（否则局部刷新后标题不变）')

    const fragment = await (await get(app, '/admin/users', { 'hx-request': 'true' })).text()
    assert.equal(/data-page-title="([^"]*)"/.exec(fragment)?.[1], title)
    assert.equal(/data-page-path="([^"]*)"/.exec(fragment)?.[1], '/admin/users')
  } finally {
    await app.close()
  }
})

// ─────────────────────── 无 JS 退化 ───────────────────────

test('无 JS 退化：侧栏链接是真的 <a href>，htmx 只是属性', async () => {
  const app = await boot()
  try {
    const html = await (await get(app, '/console/profile')).text()
    // 每个导航项都是真链接（脚本没跑 / 加载失败时整页跳）
    assert.match(html, /<a class="side-link"[^>]*href="\/console\/usage"/)
    assert.match(html, /<a class="side-link"[^>]*href="\/console\/models"/)
    // htmx 的容器属性在导航上，但 href 才是真入口
    assert.ok(html.includes('hx-target="main"'))
    assert.ok(html.includes('hx-swap="outerHTML"'))
    // 底部 /logout 不许 boost
    const logout = html.slice(html.indexOf('href="/logout"'), html.indexOf('href="/logout"') + 200)
    assert.ok(!logout.slice(0, logout.indexOf('</a>')).includes('hx-boost'))
  } finally {
    await app.close()
  }
})

test('无 JS 退化：登录页不引 htmx（没有侧栏就没有局部刷新）', async () => {
  const app = await boot()
  try {
    const html = await (await fetch(`${app.base}/login`)).text()
    assert.ok(!html.includes('htmx.min.js'), '登录页没有侧栏，52 KB 是死代码')
    assert.ok(!html.includes('hx-target'), '登录页不该有 htmx 属性')
  } finally {
    await app.close()
  }
})
