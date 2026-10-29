/**
 * `GET /api/admin/observability` 的 HTTP 面测试。
 *
 * 盯住四件事：
 * 1. 管理员拿到 200 + 完整报告（六块都在），金额是**字符串**、响应里没有 bigint；
 * 2. 普通用户 403；缺聚合服务只让这条路由 503，入口本身照常；
 * 3. 聚合插件抛错时按稳定码映射状态码（不吞成 200）；
 * 4. 报告里的数据源健康度原样透出（HTTP 层不做二次判断）。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
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

test('管理员拿到 200：六块都在、金额是字符串、响应里没有 bigint', async (t) => {
  const { server, observability } = await setup(t)
  const cookie = await adminCookie(server)

  const reply = await call(server, '/api/admin/observability', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(observability.calls, 1)

  // 六块 + 摘要 + 时间
  for (const key of ['usage', 'billing', 'quota', 'runtime', 'audit', 'accounts']) {
    assert.ok(reply.json[key] !== undefined, `缺少 ${key}`)
    assert.equal(typeof reply.json[key].health.state, 'string', `${key} 必须带数据源健康度`)
  }
  assert.equal(reply.json.generatedAt, '2026-10-29T12:00:00.000Z')
  assert.ok(Array.isArray(reply.json.warnings))
  assert.equal(reply.json.degraded, true)

  // 金额是十进制字符串（不是数字、不是 bigint）
  assert.equal(reply.json.billing.chargedMicros, '12345678')
  assert.equal(reply.json.billing.today.chargedMicros, '900000')
  assert.equal(typeof reply.json.billing.totals.records, 'number')

  // 原始文本里不能出现 bigint 字面量（JSON.stringify 也不允许）
  assert.ok(!/:\s*-?\d+n/.test(reply.text), '响应里不能有 bigint 字面量')
  assert.ok(!reply.text.includes('12345678n'))

  // 计数是整数
  assert.equal(reply.json.usage.service.records, 1234)
  assert.equal(reply.json.audit.recentActions[0].count, 2)
  assert.equal(reply.json.accounts.unhealthy, 1)
})

test('普通用户 403；缺聚合服务只让这条路由 503（入口照常）', async (t) => {
  const { server } = await setup(t)
  const user = await login(server, 'alice@example.com', 'password2')
  const denied = await call(server, '/api/admin/observability', { cookie: user })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'API_FORBIDDEN')

  const missing = await setup(t, { withoutObservability: true })
  const cookie = await adminCookie(missing.server)
  const reply = await call(missing.server, '/api/admin/observability', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'OBSERVABILITY_UNAVAILABLE')
  // 别的路由不受影响
  assert.equal((await call(missing.server, '/api/health')).status, 200)
})

test('聚合插件抛错：按稳定码映射状态码，不伪装成 200', async (t) => {
  const { server, observability } = await setup(t)
  const cookie = await adminCookie(server)
  observability.failCode = 'OBSERVABILITY_NOT_READY'

  const reply = await call(server, '/api/admin/observability', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'OBSERVABILITY_NOT_READY')
})

test('数据源降级：报告标 degraded 但接口仍是 200（不整页 503）', async (t) => {
  const { server, observability } = await setup(t)
  const cookie = await adminCookie(server)
  observability.report = {
    generatedAt: '2026-10-29T12:00:00.000Z',
    usage: {
      health: { state: 'unavailable', detail: '用量插件未运行：看不到轮询状态与隔离区' },
      service: null,
      gateway: null,
      gatewayHealth: { state: 'unavailable', detail: 'account-priority 未运行' },
    },
    billing: {
      health: { state: 'degraded', detail: '读取结算汇总失败：结算库锁住了' },
      totals: null,
      chargedMicros: null,
      today: null,
    },
    quota: {
      health: { state: 'unavailable', detail: 'account-priority 未运行' },
      ready: null,
      revision: null,
      generation: null,
      size: null,
      ageMs: null,
      ttlMs: null,
      stale: null,
    },
    runtime: { health: { state: 'unavailable', detail: 'account-priority 未运行' }, active: null, cooling: null },
    audit: {
      health: { state: 'unavailable', detail: '审计插件未运行' },
      total: 0,
      failed: 0,
      lastAt: null,
      recentActions: [],
      windowLimit: 200,
      windowTruncated: false,
      latest: [],
    },
    accounts: {
      health: { state: 'unavailable', detail: '账号服务未运行' },
      total: 0,
      enabled: 0,
      unknown: 0,
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      autoDisabled: 0,
      lastPass: null,
      lastPassAt: null,
      running: null,
    },
    warnings: [],
    degraded: true,
  }

  const reply = await call(server, '/api/admin/observability', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.degraded, true)
  assert.equal(reply.json.usage.health.state, 'unavailable')
  assert.match(reply.json.usage.health.detail, /用量插件未运行/)
  // 不可用的块用 null 占位，不要编造 0
  assert.equal(reply.json.billing.totals, null)
  assert.equal(reply.json.runtime.active, null)
})
