/**
 * 产品 HTTP 入口的结算路由测试（`GET /api/admin/billing`）。
 *
 * 覆盖：管理员可见、普通用户 403、结算服务缺失 503、只读（POST 405）、
 * 金额一律十进制字符串（不出现裸 bigint）、查询参数原样交给服务。
 *
 * 真实扣费由 usage 的结算钩子驱动（见 packages/billing 与 packages/usage 的测试），
 * HTTP 层没有写入口。
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

function sessionCookie(fixture: Fixture, userId: number): string {
  const token = `token-${userId}-${Math.random().toString(36).slice(2)}`
  fixture.auth.tokens.set(token, {
    userId,
    sessionId: `session-${userId}`,
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: '2099-10-19T00:00:00.000Z',
  })
  return `${fixture.runtime.config.sessionCookieName}=${token}`
}

test('管理员读结算记录：金额是字符串、汇总与记录都在', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)

  const reply = await call(app.server, '/api/admin/billing?limit=10', { cookie })
  assert.equal(reply.status, 200)
  assert.equal(reply.json.totals.settled, 1)
  assert.equal(reply.json.totals.chargedMicros, '1750000')
  assert.equal(reply.json.totals.todayChargedMicros, '1750000')
  assert.equal(reply.json.daily[0].date, '2026-10-19')
  assert.equal(reply.json.daily[0].chargedMicros, '1750000')
  assert.equal(reply.json.models[0].model, 'deepseek-chat')
  assert.equal(reply.json.records.items[0].reqId, 'req-1')
  assert.equal(reply.json.records.items[0].costMicro, '1750000')
  assert.equal(reply.json.records.items[0].overdrawn, false)
  assert.equal(reply.json.records.items[0].balanceAfter, '8250000')
  assert.equal(reply.json.totals.overdrawn, 0)
  assert.equal(reply.json.records.items[0].status, 'settled')
  assert.equal(typeof reply.json.records.items[0].costMicro, 'string')
  assert.equal(reply.json.records.total, 1)
  assert.ok(Number.isFinite(Date.parse(reply.json.generatedAt)))

  const listCall = app.billing.calls.find((item) => item.method === 'list')
  assert.deepEqual(listCall?.args, [{ limit: 10, offset: 0 }])
})

test('普通用户读不到（403）', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  const reply = await call(app.server, '/api/admin/billing', { cookie })
  assert.equal(reply.status, 403)
  assert.equal(reply.json.error.code, 'API_FORBIDDEN')
})

test('未登录 401', async (t) => {
  const app = await setup(t)
  const reply = await call(app.server, '/api/admin/billing')
  assert.equal(reply.status, 401)
})

test('结算服务不在运行：503 BILLING_UNAVAILABLE', async (t) => {
  const app = await setup(t, { withoutBilling: true })
  const cookie = sessionCookie(app, 1)
  const reply = await call(app.server, '/api/admin/billing', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'BILLING_UNAVAILABLE')
})

test('status 参数原样交给服务；非法状态由服务拒绝 → 400', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)

  const problems = await call(app.server, '/api/admin/billing?status=problem', { cookie })
  assert.equal(problems.status, 200)
  assert.equal(problems.json.records.total, 0)
  assert.deepEqual(
    app.billing.calls.find((item) => item.method === 'list')?.args,
    [{ status: 'problem', limit: 50, offset: 0 }],
  )

  app.billing.failCode = 'BILLING_INPUT_INVALID'
  const bad = await call(app.server, '/api/admin/billing?status=bogus', { cookie })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'BILLING_INPUT_INVALID')
})

test('只读：POST 405', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  const reply = await call(app.server, '/api/admin/billing', { method: 'POST', cookie })
  assert.equal(reply.status, 405)
})
