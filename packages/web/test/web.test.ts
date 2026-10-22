/**
 * 服务端渲染前端的测试。
 *
 * 覆盖：配置校验、路由表唯一性、登录页、未登录重定向、静态资源、404、金额换算。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { PAGES } from '../src/pages/index.ts'
import { WEB_DEFAULTS, validateWebConfig, type ResolvedWebConfig } from '../src/config.ts'
import { formatYuan, microsToYuan } from '../src/forms.ts'

async function boot(): Promise<{ ctx: Context; base: string; close(): Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  await ctx.plugin(WebService, { port: 0 })
  const web = ctx.get('web') as WebService
  for (let i = 0; i < 100; i += 1) {
    if (web.address !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const address = web.address
  assert.ok(address !== undefined, 'web 服务没有启动')
  return {
    ctx,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await web.close()
    },
  }
}

test('配置：默认值、非法端口、未知字段', () => {
  const resolved = validateWebConfig({}) as ResolvedWebConfig
  assert.equal(resolved.port, WEB_DEFAULTS.port)
  assert.equal(resolved.sessionCookieName, 'dizzyapi_session')

  assert.ok(Array.isArray(validateWebConfig({ port: 70000 })))
  assert.ok(Array.isArray(validateWebConfig({ nope: 1 })))
  assert.ok(Array.isArray(validateWebConfig({ sessionCookieName: 'bad name' })))
})

test('路由表：路径唯一，每页有标题，登录 / 注册不要求登录', () => {
  const paths = PAGES.map((page) => page.path)
  assert.equal(new Set(paths).size, paths.length)
  for (const page of PAGES) {
    assert.ok(page.title.length > 0)
  }
  const login = PAGES.find((page) => page.path === '/login')
  const register = PAGES.find((page) => page.path === '/register')
  assert.equal(login?.auth, false)
  assert.equal(register?.auth, false)
  assert.equal(PAGES.filter((page) => page.area === 'admin').every((page) => page.admin === true), true)
})

test('金额：微元 ↔ 元，负数与进位都正确', () => {
  assert.equal(formatYuan(1_137_940_000n), '¥1,137.94')
  assert.equal(formatYuan(0n), '¥0.00')
  assert.equal(formatYuan(-5_000_000n), '-¥5.00')
  assert.equal(microsToYuan('2500000'), 2.5)
})

test('HTTP：登录页 200，未登录访问控制台 302 到 /login', async () => {
  const app = await boot()
  try {
    const login = await fetch(`${app.base}/login`)
    assert.equal(login.status, 200)
    const html = await login.text()
    assert.ok(html.includes('登录 DizzyAPI'))
    assert.ok(html.includes('name="email"'))
    assert.ok(html.includes('/assets/app.css'))

    const usage = await fetch(`${app.base}/console/usage`, { redirect: 'manual' })
    assert.equal(usage.status, 302)
    assert.equal(usage.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))
  } finally {
    await app.close()
  }
})

test('HTTP：静态资源、404、跨站 POST 被拒', async () => {
  const app = await boot()
  try {
    const css = await fetch(`${app.base}/assets/app.css`)
    assert.equal(css.status, 200)
    assert.ok((await css.text()).includes('--bg-base: #151517'))

    const missing = await fetch(`${app.base}/nope`)
    assert.equal(missing.status, 404)

    const cross = await fetch(`${app.base}/login?action=login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: 'email=a%40b.c&password=x',
    })
    assert.equal(cross.status, 500)
  } finally {
    await app.close()
  }
})

test('HTTP：登录 POST 在鉴权服务缺失时回到登录页带错误', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/login?action=login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40b.c&password=x',
      redirect: 'manual',
    })
    assert.equal(response.status, 303)
    assert.ok((response.headers.get('location') ?? '').startsWith('/login?err='))
  } finally {
    await app.close()
  }
})
