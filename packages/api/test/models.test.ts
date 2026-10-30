/**
 * 产品 HTTP 入口的模型广场路由测试（`GET /api/models`）。
 *
 * 覆盖：会话闸、形状与金额字符串、过滤参数透传与校验、服务缺失 503、
 * 错误码映射，以及**`/v1/models` 的契约不在这里被改动**（那是 Go 侧的事，
 * 由 `internal/httpapi` 的 Go 用例守着）。
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
    headers['content-type'] = 'application/json'
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

/** 直接注入会话令牌，省掉一次登录（登录流程本身是 auth 的测试）。 */
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

// ───────────────────────────────── 目录 ─────────────────────────────────

test('未登录 401；登录后返回目录（可用 / 不可用 + 统计）', async (t) => {
  const app = await setup(t)
  const anonymous = await call(app.server, '/api/models')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json.error.code, 'API_UNAUTHORIZED')

  const reply = await call(app.server, '/api/models', { cookie: sessionCookie(app, 2) })
  assert.equal(reply.status, 200, reply.text)

  assert.deepEqual(reply.json.available, [
    {
      model: 'deepseek-chat',
      priced: true,
      price: {
        inputPerMillion: '2',
        outputPerMillion: '8',
        cacheReadPerMillion: '0.5',
        cacheWritePerMillion: '0',
        currency: 'CNY',
        updatedAt: '2026-10-19T00:00:00.000Z',
      },
      accountCount: 3,
      healthyAccountCount: 2,
      protocols: ['openai-chat'],
      upstreamModels: ['deepseek-chat-2026'],
      mapped: true,
    },
  ])
  assert.deepEqual(reply.json.unavailable, [
    {
      model: 'deepseek-reasoner',
      reason: 'no_healthy_account',
      detail: '提供这个模型的账号当前都不可用（停用、凭据缺失或健康检查未通过）',
      accountCount: 1,
      priced: false,
      price: null,
    },
  ])
  assert.deepEqual(reply.json.summary, {
    total: 2,
    availableCount: 1,
    unavailableCount: 1,
    pricedCount: 1,
    accountCount: 4,
  })

  // 金额一律十进制字符串：JSON 里不能出现浮点或裸 bigint。
  for (const entry of reply.json.available) {
    if (entry.price === null) continue
    assert.equal(typeof entry.price.inputPerMillion, 'string')
    assert.equal(typeof entry.price.outputPerMillion, 'string')
  }
})

test('过滤参数按名透传给服务；非法值 400', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)

  const reply = await call(
    app.server,
    '/api/models?search=deep&availability=available&priced=priced',
    { cookie },
  )
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(app.modelhub.calls.at(-1)?.query, {
    search: 'deep',
    availability: 'available',
    priced: 'priced',
  })

  const noQuery = await call(app.server, '/api/models', { cookie })
  assert.equal(noQuery.status, 200)
  assert.deepEqual(app.modelhub.calls.at(-1)?.query, {})

  for (const query of ['availability=maybe', 'priced=cheap']) {
    const bad = await call(app.server, `/api/models?${query}`, { cookie })
    assert.equal(bad.status, 400, query)
    assert.equal(bad.json.error.code, 'API_BAD_REQUEST')
  }
})

test('只支持 GET / HEAD：POST 是 405', async (t) => {
  const app = await setup(t)
  const reply = await call(app.server, '/api/models', {
    method: 'POST',
    cookie: sessionCookie(app, 2),
    body: '{}',
  })
  assert.equal(reply.status, 405)
})

test('模型广场服务不在运行：503 MODELHUB_UNAVAILABLE，其他入口照常', async (t) => {
  const app = await setup(t, { withoutModelHub: true })
  const cookie = sessionCookie(app, 2)
  const reply = await call(app.server, '/api/models', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'MODELHUB_UNAVAILABLE')

  const pricing = await call(app.server, '/api/pricing', { cookie })
  assert.equal(pricing.status, 200, '价格路由不受模型广场缺席影响')
})

test('错误码 → HTTP 状态码', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  const cases: { readonly code: string; readonly status: number }[] = [
    { code: 'MODELHUB_QUERY_INVALID', status: 400 },
    { code: 'MODELHUB_CONFIG_INVALID', status: 500 },
  ]
  for (const item of cases) {
    app.modelhub.failCode = item.code
    const reply = await call(app.server, '/api/models', { cookie })
    assert.equal(reply.status, item.status, `${item.code} 应是 ${item.status}`)
    assert.equal(reply.json.error.code, item.code)
  }
})
