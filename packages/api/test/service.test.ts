import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, FiberState } from 'cordis'
import ApiService from '../src/index.ts'
import { createFixture, type Fixture } from './fixtures.ts'

/**
 * 直接构造 ApiService：不经过 Loader，用 `ctx.provide` 放入假服务。
 * 这验证的是「服务构造 + 端口生命周期 + 可选服务的运行期解析」，
 * HTTP 路由的细节在 server.test.ts 里逐条覆盖。
 */
async function provideFixture(
  t: TestContext,
  options: { readonly identityOnly?: boolean } = {},
): Promise<{ fixture: Fixture; ctx: Context; service: ApiService; cookie: string }> {
  const fixture = await createFixture()
  const ctx = new Context()
  const disposers = [ctx.provide('user', fixture.user), ctx.provide('auth', fixture.auth)]
  if (options.identityOnly !== true) {
    disposers.push(
      ctx.provide('frontend', fixture.frontend),
      ctx.provide('catalog', fixture.catalog),
      ctx.provide('accountAdmin', fixture.accountAdmin),
      ctx.provide('accountPriority', fixture.priority),
    )
  }
  const service = new ApiService(ctx, { port: 0 })
  await service.start()
  t.after(async () => {
    await service.stop()
    for (const dispose of disposers) dispose()
    try {
      await ctx.root.fiber.dispose()
    } catch {
      // 测试清理：dispose 的返回值在 cordis 4 里是 void，忽略即可。
    }
    await fixture.cleanup()
  })
  return {
    fixture,
    ctx,
    service,
    cookie: `dizzyapi_session=${encodeURIComponent(fixture.auth.issueFor(1))}`,
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: any }> {
  const response = await fetch(url, { headers: { 'x-requested-with': 'dizzyapi', ...headers } })
  const text = await response.text()
  return { status: response.status, text, json: text === '' ? undefined : JSON.parse(text) }
}

test('ApiService：端口 0 起停、地址可读、stop 幂等', async (t) => {
  const { service } = await provideFixture(t)
  assert.equal(service.listening, true)
  assert.ok(service.port > 0)
  assert.match(service.url ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)

  const health = await getJson(`${service.url}/api/health`)
  assert.equal(health.status, 200)
  assert.equal(health.json.state, 'ok', health.text)

  await service.stop()
  await service.stop()
  assert.equal(service.listening, false)
})

test('可选服务缺失：API 仍 ACTIVE，静态 / 目录 / 账号路由各自 503', async (t) => {
  const { ctx, service, cookie } = await provideFixture(t, { identityOnly: true })

  const impl = ctx.root.reflect._getImpl('api', false)
  assert.ok(impl !== undefined, 'api 服务必须已经提供')
  assert.equal(impl.ctx.fiber.state, FiberState.ACTIVE, '缺 frontend/catalog/accountAdmin 不应让插件 PENDING')
  assert.equal(service.listening, true)

  const health = await getJson(`${service.url}/api/health`)
  assert.equal(health.status, 200)
  assert.equal(health.json.state, 'degraded')
  for (const name of ['frontend', 'catalog', 'account-admin', 'account-priority']) {
    assert.ok(
      health.json.components.some((component: any) => component.name === name && component.state === 'degraded'),
      `${name} 必须标成 degraded`,
    )
  }

  const session = await getJson(`${service.url}/api/session`, { cookie })
  assert.equal(session.status, 200)

  const usage = await getJson(`${service.url}/api/usage?range=7d`, { cookie })
  assert.equal(usage.status, 503, '用量路由只依赖 usage 服务，缺失时自己 503')
  assert.equal(usage.json.error.code, 'API_USAGE_UNAVAILABLE')
  const topup = await getJson(`${service.url}/api/topup/options`, { cookie })
  assert.equal(topup.status, 200)

  const manifest = await getJson(`${service.url}/api/console/manifest`)
  assert.equal(manifest.status, 503)
  assert.equal(manifest.json.error.code, 'FRONTEND_UNAVAILABLE')

  const spa = await getJson(`${service.url}/console/usage`)
  assert.equal(spa.status, 503)
  assert.equal(spa.json.error.code, 'FRONTEND_UNAVAILABLE')

  const asset = await getJson(`${service.url}/assets/frontend/v1/app.js`)
  assert.equal(asset.status, 503)
  assert.equal(asset.json.error.code, 'FRONTEND_UNAVAILABLE')

  const catalog = await getJson(`${service.url}/api/catalog/modules`, { cookie })
  assert.equal(catalog.status, 503)
  assert.equal(catalog.json.error.code, 'CATALOG_UNAVAILABLE')

  const accounts = await getJson(`${service.url}/api/accounts`, { cookie })
  assert.equal(accounts.status, 503)
  assert.equal(accounts.json.error.code, 'ACCOUNT_ADMIN_UNAVAILABLE')

  const keys = await getJson(`${service.url}/api/keys`, { cookie })
  assert.equal(keys.status, 503)
  assert.equal(keys.json.error.code, 'API_KEY_UNAVAILABLE')

  const settings = await getJson(`${service.url}/api/settings`, { cookie })
  assert.equal(settings.status, 503)
  assert.equal(settings.json.error.code, 'API_SETTINGS_UNAVAILABLE')
})

test('ApiService：settings 与 apiKey 按需解析，注销后立刻 503', async (t) => {
  const { fixture, ctx, service, cookie } = await provideFixture(t)

  const noSettings = await getJson(`${service.url}/api/settings`, { cookie })
  assert.equal(noSettings.status, 503)
  assert.equal(noSettings.json.error.code, 'API_SETTINGS_UNAVAILABLE')

  const disposeSettings = ctx.provide('settings', fixture.settings)
  const withSettings = await getJson(`${service.url}/api/settings`, { cookie })
  assert.equal(withSettings.status, 200)
  assert.equal(withSettings.json.namespaces[0].ns, 'mailer')
  disposeSettings()
  const goneSettings = await getJson(`${service.url}/api/settings`, { cookie })
  assert.equal(goneSettings.status, 503)

  const noKeys = await getJson(`${service.url}/api/keys`, { cookie })
  assert.equal(noKeys.status, 503)
  assert.equal(noKeys.json.error.code, 'API_KEY_UNAVAILABLE')

  const disposeKeys = ctx.provide('apiKey', fixture.apiKey)
  const withKeys = await getJson(`${service.url}/api/keys`, { cookie })
  assert.equal(withKeys.status, 200)
  assert.equal(withKeys.json.items.length, 1)
  disposeKeys()
  const goneKeys = await getJson(`${service.url}/api/keys`, { cookie })
  assert.equal(goneKeys.status, 503)
})

test('ApiService：非法配置在构造期就失败（不静默降级）', () => {
  const ctx = new Context()
  assert.throws(
    () => new ApiService(ctx, { port: -1 }),
    /产品 HTTP 入口配置不合法/,
  )
})
