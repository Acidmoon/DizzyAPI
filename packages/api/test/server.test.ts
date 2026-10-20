import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { API_ACTOR } from '../src/http.ts'
import { ApiServer } from '../src/http.ts'
import { createFixture, type Fixture, type FixtureOptions } from './fixtures.ts'

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly json: any
}

interface CallOptions {
  readonly method?: string
  readonly headers?: Record<string, string | undefined>
  readonly body?: string | Uint8Array
  readonly cookie?: string
}

function call(server: ApiServer, path: string, options: CallOptions = {}): Promise<Reply> {
  const port = server.address?.port
  assert.ok(port !== undefined, '服务器必须已启动')
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    'x-requested-with': 'dizzyapi',
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name]
    else headers[name] = value
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie

  let body: Buffer | undefined
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : Buffer.from(options.body)
    headers['content-length'] = String(body.length)
    headers['content-type'] ??= 'application/json'
  }

  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: any
          try {
            json = text === '' ? undefined : JSON.parse(text)
          } catch {
            json = undefined
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function cookieOf(reply: Reply): string {
  const raw = reply.headers['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  assert.ok(typeof value === 'string' && value !== '', '响应必须设置 cookie')
  return value.split(';')[0] as string
}

async function setup(t: TestContext, options: FixtureOptions = {}): Promise<Fixture & { server: ApiServer }> {
  const fixture = await createFixture(options)
  const server = new ApiServer(fixture.runtime)
  await server.start(0)
  t.after(async () => {
    await server.stop()
    await fixture.cleanup()
  })
  return { ...fixture, server }
}

async function login(
  server: ApiServer,
  email = 'owner@example.com',
  password = 'password1',
  headers: Record<string, string> = {},
): Promise<{ reply: Reply; cookie: string }> {
  const reply = await call(server, '/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  })
  assert.equal(reply.status, 200, reply.text)
  return { reply, cookie: cookieOf(reply) }
}

// ───────────────────────────────── 生命周期与访问闸 ─────────────────────────────────

test('生命周期：端口 0 起停、地址可读、stop 幂等', async (t) => {
  const { server } = await setup(t)
  assert.ok(server.address !== undefined)
  assert.ok((server.address?.port ?? 0) > 0)
  assert.match(server.origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(server.listening, true)

  await server.stop()
  await server.stop()
  assert.equal(server.listening, false)
  assert.equal(server.address, undefined)
})

test('四道闸：Host、X-Requested-With、Origin、Sec-Fetch-Site', async (t) => {
  const { server } = await setup(t)

  const badHost = await call(server, '/api/health', { headers: { host: 'evil.example' } })
  assert.equal(badHost.status, 403)
  assert.equal(badHost.json.error.code, 'API_HOST_FORBIDDEN')

  const noHeader = await call(server, '/api/health', { headers: { 'x-requested-with': undefined } })
  assert.equal(noHeader.status, 403)
  assert.equal(noHeader.json.error.code, 'API_REQUEST_HEADER_REQUIRED')

  const badOrigin = await call(server, '/api/health', { headers: { origin: 'http://evil.example' } })
  assert.equal(badOrigin.status, 403)
  assert.equal(badOrigin.json.error.code, 'API_ORIGIN_FORBIDDEN')

  const crossSite = await call(server, '/api/health', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.error.code, 'API_ORIGIN_FORBIDDEN')

  const sameOrigin = await call(server, '/api/health', {
    headers: {
      origin: `http://127.0.0.1:${server.address?.port}`,
      'sec-fetch-site': 'same-origin',
    },
  })
  assert.equal(sameOrigin.status, 200)
  assert.equal(sameOrigin.headers['access-control-allow-origin'], undefined, '不发送任何 CORS 头')
})

test('健康与清单：真实汇总、account-priority 缺失时 degraded、不编造桥', async (t) => {
  const { server } = await setup(t)
  const health = await call(server, '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.state, 'ok')
  assert.equal(health.json.bridge.connected, true)
  assert.equal(health.json.bridge.transport, 'tcp')
  assert.ok(health.json.components.some((component: any) => component.name === 'account-priority'))

  const manifest = await call(server, '/api/console/manifest')
  assert.equal(manifest.status, 200)
  assert.equal(manifest.headers['cache-control'], 'no-store')
  assert.equal(manifest.json.revision, 'manifest-1')

  const missing = await setup(t, { withoutPriority: true })
  const degraded = await call(missing.server, '/api/health')
  assert.equal(degraded.status, 200)
  assert.equal(degraded.json.state, 'degraded')
  assert.equal(degraded.json.bridge.connected, false)
  assert.equal(degraded.json.bridge.transport, null)
  assert.ok(degraded.json.components.some((component: any) => component.name === 'account-priority' && component.state === 'degraded'))
})

// ───────────────────────────────── 注册 / 登录 / 会话 ─────────────────────────────────

test('会话：无 cookie 401，登录设置 HttpOnly cookie 且响应不含令牌', async (t) => {
  const { server, auth } = await setup(t)

  const anonymous = await call(server, '/api/session')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json.error.code, 'API_UNAUTHORIZED')

  const wrong = await call(server, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'owner@example.com', password: 'nope' }),
  })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json.error.code, 'AUTH_CREDENTIALS_INVALID')

  const { reply, cookie } = await login(server)
  const setCookie = reply.headers['set-cookie']
  const cookieText = Array.isArray(setCookie) ? setCookie[0] : setCookie
  assert.match(String(cookieText), /HttpOnly/)
  assert.match(String(cookieText), /SameSite=Lax/)
  assert.match(String(cookieText), /Path=\//)
  assert.doesNotMatch(String(cookieText), /Secure/)

  // Caddy 终止 TLS 后会带 X-Forwarded-Proto；此时 cookie 必须加 Secure。
  const secure = await login(server, undefined, undefined, { 'x-forwarded-proto': 'https' })
  const secureSetCookie = secure.reply.headers['set-cookie']
  const secureText = Array.isArray(secureSetCookie) ? secureSetCookie[0] : secureSetCookie
  assert.match(String(secureText), /HttpOnly/)
  assert.match(String(secureText), /Secure/)
  assert.equal(reply.headers['cache-control'], 'no-store')

  const token = [...auth.tokens.keys()].pop()
  assert.ok(token !== undefined)
  assert.ok(!reply.text.includes(token), '响应 JSON 不得包含会话令牌')
  assert.ok(!reply.text.includes('passwordHash'))
  assert.equal(reply.json.user.name, 'owner')
  assert.equal(reply.json.session.id.length > 0, true)

  const session = await call(server, '/api/session', { cookie })
  assert.equal(session.status, 200)
  assert.equal(session.json.user.id, 1)
  assert.equal(session.json.user.role, 'admin')
  assert.equal(session.json.user.balanceCents, 1234)
  assert.equal(session.json.email, 'owner@example.com')
  assert.equal(session.json.permissions.admin, true)
  assert.ok(!session.text.includes(token))
  assert.ok(!session.text.includes('passwordHash'))
})

test('会话：普通用户没有 admin 权限，余额默认不返回', async (t) => {
  const { server, auth } = await setup(t)
  const cookie = `dizzyapi_session=${encodeURIComponent(auth.issueFor(2))}`
  const session = await call(server, '/api/session', { cookie })
  assert.equal(session.status, 200)
  assert.equal(session.json.permissions.admin, false)
  assert.equal(session.json.user.role, 'user')
  assert.equal(session.json.user.balanceEnabled, false)
  assert.equal(session.json.user.balanceCents, null)
})

test('注册：请求验证码 → 从假 mailer 读码 → 确认后直接登录', async (t) => {
  const { server, auth } = await setup(t)
  const email = 'new@example.com'

  const requested = await call(server, '/api/auth/register/request', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'password3', name: 'newbie' }),
  })
  assert.equal(requested.status, 200, requested.text)
  assert.ok(auth.lastCode !== null)
  assert.deepEqual(auth.sent.at(-1), { to: email, code: auth.lastCode })

  const bad = await call(server, '/api/auth/register/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, code: '000000' }),
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'AUTH_CODE_INVALID')

  const confirmed = await call(server, '/api/auth/register/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, code: auth.lastCode }),
  })
  assert.equal(confirmed.status, 200, confirmed.text)
  assert.equal(confirmed.json.user.name, 'newbie')
  assert.ok(confirmed.headers['set-cookie'] !== undefined)

  const cookie = cookieOf(confirmed)
  const session = await call(server, '/api/session', { cookie })
  assert.equal(session.status, 200)
  assert.equal(session.json.email, email)
})

test('找回密码：验证码确认后新密码可登录', async (t) => {
  const { server, auth } = await setup(t)
  const email = 'owner@example.com'

  const requested = await call(server, '/api/auth/password/reset/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  assert.equal(requested.status, 200)
  assert.ok(auth.lastCode !== null)

  const confirmed = await call(server, '/api/auth/password/reset/confirm', {
    method: 'POST',
    body: JSON.stringify({ email, code: auth.lastCode, password: 'new-password-9' }),
  })
  assert.equal(confirmed.status, 200, confirmed.text)
  assert.equal(confirmed.json.userId, 1)

  await login(server, email, 'new-password-9')
})

test('资料：改用户名 / 头像、改密码、登出使 cookie 失效', async (t) => {
  const { server, user } = await setup(t)
  const { cookie } = await login(server)

  const avatar = 'data:image/png;base64,AAAA'
  const patched = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ name: 'owner-2', avatar }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.name, 'owner-2')
  assert.equal(patched.json.avatar, avatar)
  assert.ok(user.calls.some((entry) => entry.method === 'updateProfile'))

  const unknownField = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ password: 'x' }),
  })
  assert.equal(unknownField.status, 400)

  const badPassword = await call(server, '/api/profile/password', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ currentPassword: 'wrong', newPassword: 'new-password-9' }),
  })
  assert.equal(badPassword.status, 401)

  const changed = await call(server, '/api/profile/password', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ currentPassword: 'password1', newPassword: 'new-password-9' }),
  })
  assert.equal(changed.status, 200, changed.text)
  assert.equal(changed.json.revokedSessions, 0)

  const logout = await call(server, '/api/auth/logout', { method: 'POST', cookie })
  assert.equal(logout.status, 200)
  const cleared = logout.headers['set-cookie']
  assert.match(String(Array.isArray(cleared) ? cleared[0] : cleared), /Max-Age=0/)

  const after = await call(server, '/api/session', { cookie })
  assert.equal(after.status, 401)
  assert.equal(after.json.error.code, 'AUTH_SESSION_INVALID')
})

// ───────────────────────────────── API keys ─────────────────────────────────

test('API keys：服务缺失 503；存在时 create/list/rotate/update/remove，列表可再次复制完整 key', async (t) => {
  const unavailable = await setup(t, { withApiKey: false })
  const { cookie: unavailableCookie } = await login(unavailable.server)
  const missing = await call(unavailable.server, '/api/keys', { cookie: unavailableCookie })
  assert.equal(missing.status, 503)
  assert.equal(missing.json.error.code, 'API_KEY_UNAVAILABLE')

  const { server } = await setup(t)
  const { cookie } = await login(server)

  const listed = await call(server, '/api/keys', { cookie })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.items.length, 1)
  assert.equal(typeof listed.json.items[0].secret, 'string', '用户列表可以复制完整 key')
  assert.equal(typeof listed.json.items[0].maskedKey, 'string')

  const created = await call(server, '/api/keys', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: 'deploy' }),
  })
  assert.equal(created.status, 200, created.text)
  assert.match(created.json.secret, /^sk-dizzy-secret-/)
  assert.equal(created.json.id.startsWith('key_'), true)
  assert.equal('key' in created.json, false, '创建响应必须展开成扁平 CreatedApiKey')
  assert.equal(created.headers['cache-control'], 'no-store')
  const secret = created.json.secret as string

  const afterCreate = await call(server, '/api/keys', { cookie })
  const createdView = afterCreate.json.items.find((item: { name: string }) => item.name === 'deploy')
  assert.equal(createdView?.secret, secret, '列表必须能再次读到刚创建的完整 key')

  const rotated = await call(server, `/api/keys/${created.json.id}/rotate`, { method: 'POST', cookie })
  assert.equal(rotated.status, 200, rotated.text)
  assert.match(rotated.json.secret, /^sk-dizzy-rotated-/)
  assert.equal(rotated.json.id, created.json.id)
  assert.equal('key' in rotated.json, false, '轮换响应必须展开成扁平 CreatedApiKey')
  assert.equal(rotated.headers['cache-control'], 'no-store')

  const updated = await call(server, `/api/keys/${created.json.id}`, {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.json.enabled, false)
  assert.equal(typeof updated.json.maskedKey, 'string')
  assert.equal(updated.json.secret, rotated.json.secret, 'PATCH 响应仍带轮换后的完整 key，供列表复制')

  const removed = await call(server, `/api/keys/${created.json.id}`, { method: 'DELETE', cookie })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.removed, true)

  const noName = await call(server, '/api/keys', { method: 'POST', cookie, body: '{}' })
  assert.equal(noName.status, 400)
})

// ───────────────────────────────── 管理员：用户 / 账号 / 目录 / 设置 ─────────────────────────────────

test('管理员用户：非 admin 403；列表、改名、状态、角色、余额开关、调余额、删除', async (t) => {
  const { server, user, auth } = await setup(t)
  const normalCookie = `dizzyapi_session=${encodeURIComponent(auth.issueFor(2))}`
  const denied = await call(server, '/api/users', { cookie: normalCookie })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'API_FORBIDDEN')

  const { cookie } = await login(server)
  const listed = await call(server, '/api/users?limit=2', { cookie })
  assert.equal(listed.status, 200)
  assert.equal(listed.json.items.length, 2)
  assert.equal(typeof listed.json.items[0].balanceMinor, 'string')

  const one = await call(server, '/api/users/1', { cookie })
  assert.equal(one.status, 200)
  assert.equal(one.json.role, 'admin')

  const patched = await call(server, '/api/users/2', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ name: 'alice-2', status: 'banned', role: 'admin', balanceEnabled: true }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.name, 'alice-2')
  assert.equal(patched.json.status, 'banned')
  assert.equal(patched.json.role, 'admin')
  assert.equal(patched.json.balanceEnabled, true)
  const actors = user.calls.filter((entry) => ['rename', 'setStatus', 'setRole', 'setBalanceEnabled'].includes(entry.method))
  assert.deepEqual(actors.map((entry) => entry.args[0]), [API_ACTOR, API_ACTOR, API_ACTOR, API_ACTOR])

  const balance = await call(server, '/api/users/2/balance', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ delta: '1000000', reason: 'manual top-up' }),
  })
  assert.equal(balance.status, 200, balance.text)
  assert.equal(balance.json.balanceMinor, String(500_000n + 1_000_000n))

  const badDelta = await call(server, '/api/users/2/balance', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ delta: '1.5', reason: 'x' }),
  })
  assert.equal(badDelta.status, 400)

  const unknown = await call(server, '/api/users/2', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ password: 'x' }),
  })
  assert.equal(unknown.status, 400)

  const removed = await call(server, '/api/users/3', { method: 'DELETE', cookie })
  assert.equal(removed.status, 200)
  assert.equal(removed.json.removed, true)
})

test('管理员账号：列表 / 详情剥掉 credentialRef，PATCH enabled 走 enable/disable', async (t) => {
  const { server, accountAdmin } = await setup(t)
  const { cookie } = await login(server)

  const listed = await call(server, '/api/accounts?provider=openai&limit=1', { cookie })
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.json.items.length, 1)
  assert.equal(listed.json.nextCursor, null)
  assert.equal(listed.json.items[0].id, 'acc_1')
  assert.deepEqual(
    Object.keys(listed.json.items[0]).sort(),
    [
      'accessExpiresAt',
      'backoffUntil',
      'baseUrl',
      'createdAt',
      'email',
      'enabled',
      'failureCount',
      'id',
      'kind',
      'label',
      'lastError',
      'lastRefreshAt',
      'models',
      'modelMap',
      'priority',
      'protocol',
      'provider',
      'refreshDueAt',
      'status',
      'subject',
      'updatedAt',
    ].sort(),
    '账号响应必须逐字段挑选，不能漏出 credentialRef / credentialConfigured',
  )
  assert.ok(!listed.text.includes('credentialRef'))
  assert.ok(!listed.text.includes('credentialConfigured'))

  const one = await call(server, '/api/accounts/acc_1', { cookie })
  assert.equal(one.status, 200)
  assert.ok(!one.text.includes('credentialRef'))

  const created = await call(server, '/api/accounts', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      provider: 'openai',
      kind: 'api_key',
      label: 'new account',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 7,
      credential: { payload: 'sk-upstream', format: 'auto' },
    }),
  })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.json.label, 'new account')
  assert.equal(created.json.protocol, 'openai-chat')
  assert.deepEqual(created.json.models, ['gpt-5', 'gpt-5-codex'])
  assert.deepEqual(created.json.modelMap, { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' })
  assert.ok(!created.text.includes('credentialRef'))
  const createCall = accountAdmin.calls.find((entry) => entry.method === 'create')
  assert.deepEqual(createCall?.args, [
    API_ACTOR,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'new account',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 7,
      credential: { payload: 'sk-upstream', format: 'auto' },
    },
  ])

  const patched = await call(server, '/api/accounts/acc_1', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({
      label: 'renamed',
      baseUrl: 'https://new.example.com/v1',
      protocol: 'anthropic',
      models: ['o3'],
      modelMap: { o3: 'o3-mini' },
      priority: 9,
      enabled: false,
    }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.label, 'renamed')
  assert.equal(patched.json.baseUrl, 'https://new.example.com/v1')
  assert.equal(patched.json.protocol, 'anthropic')
  assert.deepEqual(patched.json.models, ['o3'])
  assert.deepEqual(patched.json.modelMap, { o3: 'o3-mini' })
  assert.equal(patched.json.priority, 9)
  assert.equal(patched.json.enabled, false)
  const updateCall = accountAdmin.calls.find((entry) => entry.method === 'update')
  assert.deepEqual(updateCall?.args, [
    API_ACTOR,
    'acc_1',
    {
      label: 'renamed',
      baseUrl: 'https://new.example.com/v1',
      protocol: 'anthropic',
      models: ['o3'],
      modelMap: { o3: 'o3-mini' },
      priority: 9,
    },
  ])
  assert.ok(accountAdmin.calls.some((entry) => entry.method === 'disable'))
  assert.ok(!accountAdmin.calls.some((entry) => entry.method === 'enable'), 'enabled 不能被塞进 update')

  const credentials = await call(server, '/api/accounts/acc_1/credentials', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ payload: 'sk-upstream', format: 'api-key' }),
  })
  assert.equal(credentials.status, 200, credentials.text)
  assert.ok(!credentials.text.includes('credentialRef'))
  assert.ok(accountAdmin.calls.some((entry) => entry.method === 'importCredentials'))

  const preview = await call(server, '/api/accounts/import/preview', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ payload: 'sk-upstream' }),
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.format, 'api-key')

  const bulk = await call(server, '/api/accounts/import', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ items: [{ payload: 'sk-upstream' }] }),
  })
  assert.equal(bulk.status, 200, bulk.text)
  assert.ok(!bulk.text.includes('credentialRef'))

  const removed = await call(server, '/api/accounts/acc_2', { method: 'DELETE', cookie })
  assert.equal(removed.status, 200)
})

test('管理员目录：catalog.query 映射成 CatalogResponse，pages 按 owner/package 匹配', async (t) => {
  const { server } = await setup(t, {
    pages: [
      {
        id: 'api.admin.entry',
        owner: '@dizzyapi/plugin-api',
        area: 'admin',
        path: '/admin/api',
        title: 'API',
      },
    ],
  })
  const { cookie } = await login(server)
  const reply = await call(server, '/api/catalog/modules', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.generatedAt, '2026-10-19T00:00:00.000Z', 'generatedAt 来自 catalog.query()')
  const api = reply.json.modules.find((module: any) => module.id === 'api')
  assert.equal(api.kind, 'plugin')
  assert.equal(api.state, 'active')
  assert.deepEqual(api.pages, ['/admin/api'])
  assert.ok(api.provides.includes('http-api'))
  const off = reply.json.modules.find((module: any) => module.id === 'off')
  assert.equal(off.state, 'disabled')
})

test('管理员设置：描述 / 写入 / 恢复基线，actor 固定为 plugin-api', async (t) => {
  const { server, settings } = await setup(t)
  const { cookie } = await login(server)

  const described = await call(server, '/api/settings', { cookie })
  assert.equal(described.status, 200)
  assert.equal(described.json.namespaces[0].ns, 'mailer')

  const updated = await call(server, '/api/settings/mailer', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ patch: { from: 'robot@example.com' }, expectedRevision: 'rev-1' }),
  })
  assert.equal(updated.status, 200, updated.text)
  const updateCall = settings.calls.find((entry) => entry.method === 'update')
  assert.deepEqual(updateCall?.args, [API_ACTOR, 'mailer', { from: 'robot@example.com' }, 'rev-1'])

  const reset = await call(server, '/api/settings/mailer', { method: 'DELETE', cookie })
  assert.equal(reset.status, 200)
  assert.deepEqual(settings.calls.find((entry) => entry.method === 'reset')?.args, [API_ACTOR, 'mailer'])
})

test('设置插件缺失时 503', async (t) => {
  const { server } = await setup(t, { withSettings: false })
  const { cookie } = await login(server)
  const reply = await call(server, '/api/settings', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'API_SETTINGS_UNAVAILABLE')
})

test('用量：余额按 BigInt 换算成分，历史不伪造；充值选项与 501 订单', async (t) => {
  const { server, auth } = await setup(t)
  const { cookie } = await login(server)

  const usage = await call(server, '/api/usage?range=7d', { cookie })
  assert.equal(usage.status, 200, usage.text)
  assert.equal(usage.json.range, '7d')
  assert.equal(usage.json.from, '2026-10-13')
  assert.equal(usage.json.to, '2026-10-19')
  assert.equal(usage.json.balances.paidCents, 1234)
  assert.equal(usage.json.balances.grantedCents, 0)
  assert.equal(usage.json.balances.spentCents, 0)
  assert.deepEqual(usage.json.totals, { costCents: 0, requests: 0, tokens: 0 })
  assert.deepEqual(usage.json.daily, [])
  assert.deepEqual(usage.json.models, [])
  assert.equal(usage.json.generatedAt, '2026-10-19T12:00:00.000Z')

  const normalCookie = `dizzyapi_session=${encodeURIComponent(auth.issueFor(2))}`
  const normalUsage = await call(server, '/api/usage?range=30d', { cookie: normalCookie })
  assert.equal(normalUsage.json.balances.paidCents, 50)

  const invalid = await call(server, '/api/usage?range=1d', { cookie })
  assert.equal(invalid.status, 400)

  const options = await call(server, '/api/topup/options', { cookie })
  assert.equal(options.status, 200)
  assert.equal(options.json.currency, 'CNY')
  assert.deepEqual(options.json.amountsCents, [1_000, 2_000, 5_000, 10_000, 30_000, 50_000])
  assert.equal(options.json.maxCents, 1_000_000)
  assert.ok(options.json.methods.every((method: any) => method.enabled === true))

  const order = await call(server, '/api/topup/orders', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ amountCents: 10_000, method: 'alipay' }),
  })
  assert.equal(order.status, 501)
  assert.equal(order.json.error.code, 'TOPUP_NOT_IMPLEMENTED')
})

// ───────────────────────────────── 静态与 SPA ─────────────────────────────────

test('静态：/ 重定向、SPA fallback 的 CSP、immutable 资源头、HEAD', async (t) => {
  const { server } = await setup(t)

  const root = await call(server, '/')
  assert.equal(root.status, 303)
  assert.equal(root.headers.location, '/console/usage')

  const spa = await call(server, '/console/usage')
  assert.equal(spa.status, 200)
  assert.match(spa.text, /id="app"/)
  assert.equal(spa.headers['cache-control'], 'no-store')
  assert.match(String(spa.headers['content-security-policy']), /default-src 'self'/)
  assert.match(String(spa.headers['content-security-policy']), /frame-ancestors 'none'/)
  assert.match(String(spa.headers['content-security-policy']), /img-src 'self' data: https:/)
  assert.equal(spa.headers['referrer-policy'], 'no-referrer')
  assert.equal(spa.headers['x-content-type-options'], 'nosniff')

  const admin = await call(server, '/admin/accounts/whatever')
  assert.equal(admin.status, 200)
  assert.match(admin.text, /id="app"/)

  const asset = await call(server, '/assets/frontend/v1/app.js')
  assert.equal(asset.status, 200)
  assert.match(String(asset.headers['content-type']), /text\/javascript/)
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(asset.headers['x-content-type-options'], 'nosniff')

  const head = await call(server, '/assets/frontend/v1/app.js', { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.ok(Number(head.headers['content-length']) > 0)

  const traversal = await call(server, '/assets/frontend/v1/%2e%2e/state.json')
  assert.equal(traversal.status, 404)

  const unknown = await call(server, '/nope')
  assert.equal(unknown.status, 404)
  assert.equal(unknown.json.error.code, 'API_NOT_FOUND')

  const method = await call(server, '/console', { method: 'POST' })
  assert.equal(method.status, 405)
})

test('静态：state.json.enabled=false 时静态 404，但 /api/health 仍可用', async (t) => {
  const { server, frontend } = await setup(t)
  await frontend.setEnabled(false)

  const spa = await call(server, '/console/usage')
  assert.equal(spa.status, 404)
  const asset = await call(server, '/assets/frontend/v1/app.js')
  assert.equal(asset.status, 404)
  const health = await call(server, '/api/health')
  assert.equal(health.status, 200)
})

// ───────────────────────────────── 请求体与方法 ─────────────────────────────────

test('请求体：超限 413、坏 JSON 400、缺字段 400、方法 405', async (t) => {
  const { server } = await setup(t, { config: { bodyLimitBytes: 64 * 1024 } })

  const tooLarge = await call(server, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'owner@example.com', password: 'x'.repeat(70 * 1024) }),
  })
  assert.equal(tooLarge.status, 413)
  assert.equal(tooLarge.json.error.code, 'API_BODY_TOO_LARGE')

  const badJson = await call(server, '/api/auth/login', { method: 'POST', body: '{' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error.code, 'API_INVALID_JSON')

  const empty = await call(server, '/api/auth/login', { method: 'POST', body: '{}' })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error.code, 'API_BAD_REQUEST')

  const wrongMethod = await call(server, '/api/auth/login')
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')
  assert.equal(wrongMethod.json.error.code, 'API_METHOD_NOT_ALLOWED')

  const missingRoute = await call(server, '/api/nope')
  assert.equal(missingRoute.status, 404)
})

function imageDataUrl(bytes: number): string {
  return `data:image/png;base64,${Buffer.alloc(bytes, 0x41).toString('base64')}`
}

test('头像：https URL 通过、超长 URL / 其他 scheme 拒绝', async (t) => {
  const { server } = await setup(t)
  const { cookie } = await login(server)

  const httpsAvatar = 'https://cdn.example.com/avatar.png?size=128'
  const accepted = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: httpsAvatar }),
  })
  assert.equal(accepted.status, 200, accepted.text)
  assert.equal(accepted.json.avatar, httpsAvatar)

  const httpAccepted = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: 'http://cdn.example.com/avatar.png' }),
  })
  assert.equal(httpAccepted.status, 200, 'user 插件接受 http(s) URL（CSP 只放行 https 渲染）')

  const tooLong = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: `https://example.com/${'a'.repeat(2048)}` }),
  })
  assert.equal(tooLong.status, 400)

  const badScheme = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: 'ftp://example.com/avatar.png' }),
  })
  assert.equal(badScheme.status, 400)

  const badData = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: 'data:text/plain;base64,AAAA' }),
  })
  assert.equal(badData.status, 400)
})

test('头像：data URL 按解码后大小校验（≤256 KiB）', async (t) => {
  const { server } = await setup(t)
  const { cookie } = await login(server)

  const nearLimit = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: imageDataUrl(255 * 1024) }),
  })
  assert.equal(nearLimit.status, 200, nearLimit.text)

  const overLimit = await call(server, '/api/profile', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ avatar: imageDataUrl(256 * 1024 + 1) }),
  })
  assert.equal(overLimit.status, 413)
  assert.equal(overLimit.json.error.code, 'API_BODY_TOO_LARGE')
})

test('会话校验失败只暴露稳定 code，不带 auth 内部消息', async (t) => {
  const { server } = await setup(t)

  const banned = await call(server, '/api/session', { cookie: 'dizzyapi_session=banned-token' })
  assert.equal(banned.status, 403)
  assert.equal(banned.json.error.code, 'AUTH_USER_BANNED')
  assert.ok(!banned.text.includes('内部细节'))

  const broken = await call(server, '/api/session', { cookie: 'dizzyapi_session=broken-session' })
  assert.equal(broken.status, 401)
  assert.equal(broken.json.error.code, 'AUTH_SESSION_INVALID')
  assert.ok(!broken.text.includes('内部细节'))
})

test('错误响应不回显请求体里的密码 / 验证码 / 上游凭据', async (t) => {
  const { server } = await setup(t)

  const password = 'super-secret-password-123'
  const loginReply = await call(server, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'owner@example.com', password }),
  })
  assert.equal(loginReply.status, 401)
  assert.ok(!loginReply.text.includes(password))

  const code = '987654-secret-code'
  const confirmReply = await call(server, '/api/auth/register/confirm', {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@example.com', code }),
  })
  assert.equal(confirmReply.status, 400)
  assert.ok(!confirmReply.text.includes(code))

  const { cookie } = await login(server)
  const upstreamSecret = 'sk-upstream-super-secret'
  const credentialsReply = await call(server, '/api/accounts/acc_1/credentials', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ payload: [upstreamSecret] }),
  })
  assert.equal(credentialsReply.status, 400)
  assert.ok(!credentialsReply.text.includes(upstreamSecret))
})
