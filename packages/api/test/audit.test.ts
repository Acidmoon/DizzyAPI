/**
 * 管理员审计的 HTTP 面测试。
 *
 * 盯住四件事：
 * 1. `GET /api/admin/audit` 的读口径（分页、筛选透传、`stats=1`）与权限（管理员 / 503）；
 * 2. **高危写操作真的会记审计**（余额、角色、价格、设置、账号凭据、充值到账）；
 * 3. **审计是旁路**：审计服务缺席或 `record` 抛错时，业务写操作照常成功；
 * 4. 记录里**不含秘密**（凭据 payload / 设置值）。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { ApiServer } from '../src/http.ts'
import { createFixture, type Fixture, type FixtureOptions } from './fixtures/index.ts'

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly json: any
}

interface CallOptions {
  readonly method?: string
  readonly headers?: Record<string, string | undefined>
  readonly body?: string
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
    body = Buffer.from(options.body, 'utf8')
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

/** 管理员（owner）与普通用户（alice）各拿一个 cookie。 */
async function login(server: ApiServer, email: string, password: string): Promise<string> {
  const reply = await call(server, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  assert.equal(reply.status, 200, reply.text)
  const raw = reply.headers['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  assert.ok(typeof value === 'string' && value !== '')
  return value.split(';')[0] as string
}

async function adminCookie(server: ApiServer): Promise<string> {
  return login(server, 'owner@example.com', 'password1')
}

// ───────────────────────────────── 读接口 ─────────────────────────────────

test('审计列表：时间倒序、分页、筛选按名透传，stats=1 附带汇总', async (t) => {
  const { server, audit } = await setup(t)
  audit.seed({
    actor: 'user:1:admin',
    actorPlugin: '@dizzyapi/plugin-api',
    action: 'user.balance.adjust',
    targetType: 'user',
    targetId: '2',
    summary: '调整用户 #2 的余额',
    metadata: { deltaMicros: '1000000' },
    atMs: Date.UTC(2026, 9, 19, 10, 0, 0),
  })
  audit.seed({
    actor: 'user:1:admin',
    actorPlugin: '@dizzyapi/plugin-web',
    action: 'pricing.write',
    targetType: 'pricing',
    targetId: 'deepseek-chat',
    summary: '写入模型价格',
    atMs: Date.UTC(2026, 9, 19, 11, 0, 0),
  })

  const cookie = await adminCookie(server)
  const reply = await call(server, '/api/admin/audit?limit=1&stats=1', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.total, 2)
  assert.equal(reply.json.limit, 1)
  assert.equal(reply.json.items.length, 1)
  // 时间倒序：最新的一条（价格）在前。
  assert.equal(reply.json.items[0].action, 'pricing.write')
  assert.equal(reply.json.stats.total, 2)
  assert.equal(reply.json.stats.byAction.length, 2)

  const filtered = await call(server, '/api/admin/audit?action=user.balance.adjust', { cookie })
  assert.equal(filtered.status, 200, filtered.text)
  assert.equal(filtered.json.total, 1)
  assert.equal(filtered.json.items[0].targetType, 'user')
  assert.equal(filtered.json.items[0].metadata.deltaMicros, '1000000')
  // 服务收到的查询条件必须按名传（不是丢弃或改名）。
  const last = audit.reads.at(-1)
  assert.equal(last?.query?.action, 'user.balance.adjust')
  assert.equal(last?.actor, '@dizzyapi/plugin-api')

  const byTarget = await call(server, '/api/admin/audit?targetType=pricing&targetId=deepseek-chat', { cookie })
  assert.equal(byTarget.json.total, 1)
  assert.equal(byTarget.json.items[0].action, 'pricing.write')

  const byRange = await call(server, '/api/admin/audit?from=1&to=2', { cookie })
  assert.equal(byRange.status, 200, byRange.text)
})

test('审计列表：普通用户 403；缺服务 503（入口本身照常）', async (t) => {
  const { server } = await setup(t)
  const user = await login(server, 'alice@example.com', 'password2')
  const denied = await call(server, '/api/admin/audit', { cookie: user })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'API_FORBIDDEN')

  const missing = await setup(t, { withoutAudit: true })
  const cookie = await adminCookie(missing.server)
  const reply = await call(missing.server, '/api/admin/audit', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'AUDIT_UNAVAILABLE')
  // 别的路由不受影响。
  const health = await call(missing.server, '/api/health')
  assert.equal(health.status, 200)
})

// ───────────────────────────────── 写操作接线 ─────────────────────────────────

test('写操作接线：余额 / 角色 / 价格 / 设置 / 账号凭据 / 充值到账都记审计', async (t) => {
  const { server, audit } = await setup(t)
  const cookie = await adminCookie(server)

  const balance = await call(server, '/api/users/2/balance', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ delta: '1500000', reason: '补偿' }),
  })
  assert.equal(balance.status, 200, balance.text)
  const balanceEntry = audit.calls.at(-1)
  assert.equal(balanceEntry?.action, 'user.balance.adjust')
  assert.equal(balanceEntry?.actor, 'user:1:admin')
  assert.equal(balanceEntry?.actorPlugin, '@dizzyapi/plugin-api')
  assert.equal(balanceEntry?.targetType, 'user')
  assert.equal(balanceEntry?.targetId, '2')
  assert.equal(balanceEntry?.result, 'ok')
  assert.equal((balanceEntry?.metadata as Record<string, unknown>).deltaMicros, '1500000')

  const role = await call(server, '/api/users/2', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ role: 'admin' }),
  })
  assert.equal(role.status, 200, role.text)
  assert.equal(audit.calls.at(-1)?.action, 'user.role.set')

  const price = await call(server, '/api/pricing/deepseek-chat', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ inputPerMillion: '2', outputPerMillion: '8' }),
  })
  assert.equal(price.status, 200, price.text)
  assert.equal(audit.calls.at(-1)?.action, 'pricing.write')

  const settings = await call(server, '/api/settings/mailer', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ patch: { from: 'robot@example.com' } }),
  })
  assert.equal(settings.status, 200, settings.text)
  assert.equal(audit.calls.at(-1)?.action, 'settings.write')
  // 只记字段名，不记值。
  assert.deepEqual((audit.calls.at(-1)?.metadata as Record<string, unknown>).fields, ['from'])

  const credentials = await call(server, '/api/accounts/acc_1/credentials', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ payload: { apiKey: 'sk-live-should-never-be-audited' } }),
  })
  assert.equal(credentials.status, 200, credentials.text)
  const credentialEntry = audit.calls.at(-1)
  assert.equal(credentialEntry?.action, 'account.import_credentials')
  assert.equal(credentialEntry?.targetId, 'acc_1')
  // 凭据明文绝不能出现在审计记录里。
  assert.ok(!JSON.stringify(audit.calls).includes('sk-live-should-never-be-audited'))

  const confirm = await call(server, '/api/admin/topup-orders/T20261019110000ABCD1234/confirm', {
    method: 'POST',
    cookie,
  })
  assert.equal(confirm.status, 200, confirm.text)
  const confirmEntry = audit.calls.at(-1)
  assert.equal(confirmEntry?.action, 'topup.order.confirm')
  assert.equal(confirmEntry?.targetType, 'topup-order')
  assert.equal(confirmEntry?.targetId, 'T20261019110000ABCD1234')
  assert.equal(confirmEntry?.result, 'ok')
})

test('写操作失败也记：带稳定错误码，业务状态码不变', async (t) => {
  const { server, audit, settings } = await setup(t)
  const cookie = await adminCookie(server)
  settings.failCode = 'SETTINGS_CONFLICT'

  const bad = await call(server, '/api/settings/mailer', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ patch: { nope: 1 } }),
  })
  assert.equal(bad.status, 409, bad.text)
  assert.equal(bad.json.error.code, 'SETTINGS_CONFLICT')
  const entry = audit.calls.at(-1)
  assert.equal(entry?.action, 'settings.write')
  assert.equal(entry?.result, 'failed')
  assert.equal(entry?.errorCode, 'SETTINGS_CONFLICT')
})

// ───────────────────────────────── 旁路纪律 ─────────────────────────────────

test('审计 write 抛错：业务照常成功，只留一条警告日志', async (t) => {
  const { server, audit, runtime } = await setup(t)
  const cookie = await adminCookie(server)
  audit.failRecord = true

  const logs: string[] = []
  const originalLog = runtime.log
  ;(runtime as { log: typeof originalLog }).log = (level, message) => {
    if (level === 'warn') logs.push(message)
    originalLog(level, message)
  }

  const reply = await call(server, '/api/users/2/balance', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ delta: '1000000', reason: '审计挂了' }),
  })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.balanceMinor, '1500000')
  assert.ok(
    logs.some((line) => line.includes('审计写入失败')),
    `应当记一条审计失败警告，实际：${logs.join(' | ')}`,
  )
})

test('审计插件被禁用：写操作照常成功，也不产生记录', async (t) => {
  const { server, audit } = await setup(t, { withoutAudit: true })
  const cookie = await adminCookie(server)

  const reply = await call(server, '/api/users/2', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ status: 'banned' }),
  })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.status, 'banned')
  assert.deepEqual(audit.calls, [], '审计服务不在时不应有调用')
})
