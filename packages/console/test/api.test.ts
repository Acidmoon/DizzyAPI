import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ApiError,
  createHttpApis,
  createHttpTransport,
  createMockApis,
  isApiError,
} from '../assets/lib/api.js'

interface Call {
  readonly url: string
  readonly init: RequestInit
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: new Headers(headers),
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
}

function fakeFetch(reply: ReturnType<typeof response>, calls: Call[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return reply
  }) as unknown as typeof fetch
}

test('HTTP 客户端：路径、查询串、方法与 JSON body', async () => {
  const calls: Call[] = []
  const apis = createHttpApis({
    baseUrl: 'http://gw.test/api/',
    fetchImpl: fakeFetch(
      response({ items: [], nextCursor: null }),
      calls,
    ),
  })
  await apis.accounts.list({ provider: 'claude', limit: 2 })
  assert.equal(calls[0]?.url, 'http://gw.test/api/accounts?provider=claude&limit=2')
  assert.equal(calls[0]?.init.method, 'GET')
  assert.equal(calls[0]?.init.credentials, 'same-origin')
  assert.equal((calls[0]?.init.headers as Record<string, string>).Accept, 'application/json')
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>)['X-Requested-With'],
    'dizzyapi',
    '所有请求都要带网关要求的自定义头',
  )

  const settingsFetch = fakeFetch(response({ ns: 'mailer' }), calls)
  const settings = createHttpApis({ baseUrl: 'http://gw.test/api', fetchImpl: settingsFetch })
  await settings.settings.update('mailer', { smtp: { host: 'smtp.example.com' } }, 'rev-1')
  const call = calls[calls.length - 1]
  assert.equal(call?.url, 'http://gw.test/api/settings/mailer')
  assert.equal(call?.init.method, 'POST')
  assert.equal((call?.init.headers as Record<string, string>)['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(String(call?.init.body)), {
    patch: { smtp: { host: 'smtp.example.com' } },
    expectedRevision: 'rev-1',
  })
})

test('HTTP 客户端：keys / usage / topup 的路径与参数', async () => {
  const calls: Call[] = []
  const apis = createHttpApis({
    baseUrl: '/api',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return response({})
    }) as unknown as typeof fetch,
  })
  await apis.usage.get({ range: '7d', apiKeyId: 'key_1' })
  await apis.keys.create({ name: 'ci' })
  await apis.keys.update('key_1', { name: 'renamed' })
  await apis.keys.remove('key_1')
  await apis.topup.options()
  await apis.topup.createOrder({ amountCents: 10_000, method: 'alipay' })
  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? 'GET'} ${call.url}`),
    [
      'GET /api/usage?range=7d&apiKeyId=key_1',
      'POST /api/keys',
      'PATCH /api/keys/key_1',
      'DELETE /api/keys/key_1',
      'GET /api/topup/options',
      'POST /api/topup/orders',
    ],
  )
})

test('HTTP 客户端：session / users / keys.rotate 的路径与参数', async () => {
  const calls: Call[] = []
  const apis = createHttpApis({
    baseUrl: '/api',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} })
      return response({})
    }) as unknown as typeof fetch,
  })
  await apis.session.get()
  await apis.session.login({ email: 'a@example.com', password: 'p' })
  await apis.session.logout()
  await apis.session.registerRequest({ email: 'a@example.com', password: 'p', name: 'a' })
  await apis.session.registerConfirm({ email: 'a@example.com', code: '123456' })
  await apis.session.requestPasswordReset({ email: 'a@example.com' })
  await apis.session.confirmPasswordReset({ email: 'a@example.com', code: '1', password: 'p' })
  await apis.session.updateProfile({ name: 'renamed' })
  await apis.session.changePassword({ currentPassword: 'old', newPassword: 'new' })
  await apis.users.list({ status: 'enabled', offset: 2, limit: 5 })
  await apis.users.get(7)
  await apis.users.update(7, { role: 'admin' })
  await apis.users.adjustBalance(7, { deltaMinor: '1000000', reason: 'top-up' })
  await apis.users.remove(7)
  await apis.keys.rotate('key_1')

  assert.deepEqual(
    calls.map((call) => `${call.init.method ?? 'GET'} ${call.url}`),
    [
      'GET /api/session',
      'POST /api/auth/login',
      'POST /api/auth/logout',
      'POST /api/auth/register/request',
      'POST /api/auth/register/confirm',
      'POST /api/auth/password/reset/request',
      'POST /api/auth/password/reset/confirm',
      'PATCH /api/profile',
      'POST /api/profile/password',
      'GET /api/users?status=enabled&offset=2&limit=5',
      'GET /api/users/7',
      'PATCH /api/users/7',
      'POST /api/users/7/balance',
      'DELETE /api/users/7',
      'POST /api/keys/key_1/rotate',
    ],
  )
  assert.deepEqual(JSON.parse(String(calls[12]?.init.body)), {
    delta: '1000000',
    reason: 'top-up',
  })
})

test('HTTP 客户端：错误映射保留 code、status 与 request id', async () => {
  const apis = createHttpApis({
    baseUrl: 'http://gw.test/api',
    fetchImpl: fakeFetch(
      response(
        { error: { code: 'SETTINGS_CONFLICT', message: '设置已被别人改过' } },
        409,
        { 'x-request-id': 'req-1', 'content-type': 'application/json' },
      ),
    ),
  })
  await assert.rejects(
    () => apis.settings.update('mailer', { from: 'x' }, 'rev-old'),
    (error: unknown) => {
      assert.ok(isApiError(error))
      assert.equal(error.status, 409)
      assert.equal(error.code, 'SETTINGS_CONFLICT')
      assert.equal(error.requestId, 'req-1')
      assert.match(error.message, /设置已被别人改过/)
      return true
    },
  )
})

test('HTTP 客户端：网络错误与超时', async () => {
  const network = createHttpApis({
    baseUrl: 'http://gw.test/api',
    fetchImpl: (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => network.health.get(),
    (error: unknown) => isApiError(error) && error.code === 'NETWORK_ERROR',
  )

  const transport = createHttpTransport({
    timeoutMs: 5,
    fetchImpl: ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch,
  })
  await assert.rejects(
    () => transport('/health'),
    (error: unknown) => isApiError(error) && error.code === 'TIMEOUT',
  )
})

test('mock：用量、keys、充值都是契约形状', async () => {
  const mock = createMockApis({ latencyMs: 0, now: () => new Date('2026-10-19T12:00:00.000Z') })

  const usage = await mock.usage.get({ range: '30d' })
  assert.equal(usage.daily.length, 30)
  assert.ok(usage.totals.costCents > 0)
  assert.ok(usage.totals.requests > 0)
  assert.ok(usage.daily.every((point) => point.date.match(/^\d{4}-\d{2}-\d{2}$/)))
  assert.equal((await mock.usage.get({ range: '7d' })).daily.length, 7)
  assert.equal((await mock.usage.get({ range: '30d', apiKeyId: 'key_ci_runner' })).apiKeyId, 'key_ci_runner')

  const listed = await mock.keys.list()
  assert.equal(listed.items.length, 3)
  assert.ok(listed.items.every((item) => !('secret' in item)))
  const created = await mock.keys.create({ name: 'ci' })
  assert.match(created.secret, /^sk-dizzy-mock-/)
  assert.ok(!('secret' in (await mock.keys.list()).items[0]))
  assert.equal((await mock.keys.update(created.id, { name: 'ci-2' })).name, 'ci-2')
  const rotated = await mock.keys.rotate(created.id)
  assert.match(rotated.secret, /^sk-dizzy-mock-rotated-/)
  await mock.keys.remove(created.id)
  assert.equal((await mock.keys.list()).items.length, 3)

  const topup = await mock.topup.options()
  assert.equal(topup.currency, 'CNY')
  assert.ok(topup.methods.some((method) => method.id === 'alipay' && method.enabled))
  const order = await mock.topup.createOrder({ amountCents: 10_000, method: 'alipay' })
  assert.equal(order.status, 'pending')
  assert.equal(order.amountCents, 10_000)
  await assert.rejects(
    () => mock.topup.createOrder({ amountCents: 1, method: 'alipay' }),
    (error: unknown) => error instanceof ApiError && error.code === 'TOPUP_AMOUNT_OUT_OF_RANGE',
  )

  const manifest = await mock.console.manifest()
  assert.ok(manifest.pages.some((page) => page.path === '/console'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/api_keys'))
  assert.ok(manifest.pages.some((page) => page.path === '/console/top_up'))
  assert.equal(manifest.pages.find((page) => page.path === '/console/profile')?.view.kind, 'profile')
  assert.equal(manifest.pages.find((page) => page.path === '/admin/users')?.view.kind, 'users')
})

test('mock：会话、用户管理与 admin 权限形状', async () => {
  const mock = createMockApis({ latencyMs: 0, now: () => new Date('2026-10-19T12:00:00.000Z') })

  const session = await mock.session.get()
  assert.equal(session.user.role, 'admin')
  assert.equal(session.permissions.admin, true)
  assert.equal(session.email, 'owner@example.com')
  assert.ok(!('token' in session))
  assert.ok(!('passwordHash' in session.user))

  const users = await mock.users.list()
  assert.equal(users.items.length, 3)
  assert.equal(typeof users.items[0]?.balanceMinor, 'string')
  assert.equal((await mock.users.update(2, { role: 'admin' })).role, 'admin')
  assert.equal((await mock.users.update(2, { balanceEnabled: true })).balanceEnabled, true)
  const adjusted = await mock.users.adjustBalance(2, { deltaMinor: '1000000', reason: 'test' })
  assert.equal(adjusted.balanceMinor, String(500_000n + 1_000_000n))

  await mock.session.logout()
  await assert.rejects(
    () => mock.session.get(),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  )
  await mock.session.login({ email: 'owner@example.com', password: 'anything' })
  assert.equal((await mock.session.get()).permissions.admin, true)

  await mock.session.registerRequest({ email: 'new@example.com', password: 'password', name: 'new' })
  const registered = await mock.session.registerConfirm({ email: 'new@example.com', code: '123456' })
  assert.equal(registered.user.id, 1)
})
