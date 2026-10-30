/**
 * 产品 HTTP 入口的充值订单路由测试。
 *
 * 覆盖：用户面（选项 / 下单 / 我的订单 / 单笔 / 取消）与会话闸、金额一律十进制字符串、
 * 错误码 → 状态码映射、服务缺失时 503、管理面权限与参数校验、
 * 人工确认到账的幂等返回（`credited: false` 表示「早就到账了，没有再加钱」）。
 *
 * 本批**没有在线支付**：没有回调路由，也没有任何「自动到账」的入口。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { API_ACTOR, ApiServer } from '../src/http.ts'
import { createFixture, type Fixture, type FixtureOptions } from './fixtures/index.ts'

const ORDER_NO = 'T20261019110000ABCD1234'

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

// ───────────────────────────────── 用户面 ─────────────────────────────────

test('未登录一律 401：选项、下单、我的订单、取消', async (t) => {
  const app = await setup(t)
  for (const [method, path] of [
    ['GET', '/api/topup/options'],
    ['GET', '/api/topup/orders'],
    ['POST', '/api/topup/orders'],
    ['GET', `/api/topup/orders/${ORDER_NO}`],
    ['POST', `/api/topup/orders/${ORDER_NO}/cancel`],
  ] as const) {
    const reply = await call(app.server, path, {
      method,
      ...(method === 'POST' ? { body: JSON.stringify({ amountYuan: '100' }) } : {}),
    })
    assert.equal(reply.status, 401, `${method} ${path}`)
    assert.equal(reply.json.error.code, 'API_UNAUTHORIZED')
  }
})

test('充值选项：金额是微元的十进制字符串，明确标注没有在线支付', async (t) => {
  const app = await setup(t)
  const reply = await call(app.server, '/api/topup/options', { cookie: sessionCookie(app, 2) })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.currency, 'CNY')
  assert.equal(reply.json.providerId, 'manual')
  assert.equal(reply.json.online, false)
  assert.match(reply.json.minAmountMicros, /^[0-9]+$/)
  assert.equal(reply.json.maxAmountMicros, '10000000000')
  assert.equal(reply.json.expiresMinutes, 30)
  assert.equal(typeof reply.json.notice, 'string')
})

test('下单：200，金额与备注按原样交给服务，返回订单 + 人工确认说明', async (t) => {
  const app = await setup(t)
  const reply = await call(app.server, '/api/topup/orders', {
    method: 'POST',
    cookie: sessionCookie(app, 2),
    body: JSON.stringify({ amountYuan: '100.5', note: '对公转账' }),
  })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.order.amountMicro, '100000000')
  assert.equal(reply.json.order.status, 'pending')
  assert.equal(reply.json.order.provider, 'manual')
  assert.equal(typeof reply.json.order.createdAt, 'string')
  assert.equal(typeof reply.json.instructions, 'string')

  const record = app.topup.calls.find((item) => item.method === 'createOrder')
  assert.deepEqual(record?.args, [{ userId: 2, amountYuan: '100.5', note: '对公转账' }])
})

test('下单参数校验：缺金额 / 金额不是字符串 / 未知字段都 400', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  for (const body of [
    {},
    { amountYuan: 100 },
    { amountYuan: '' },
    { amountYuan: '100', method: 'alipay' },
    { amountYuan: '100', amountCents: 10_000 },
  ]) {
    const reply = await call(app.server, '/api/topup/orders', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    })
    assert.equal(reply.status, 400, JSON.stringify(body))
  }
  assert.equal(app.topup.calls.length, 0, '参数非法时不该把调用透传到服务')
})

test('我的订单：列表带 limit、单笔按单号，金额都是字符串', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)

  const list = await call(app.server, '/api/topup/orders?limit=5', { cookie })
  assert.equal(list.status, 200, list.text)
  assert.equal(list.json.total, 1)
  assert.equal(list.json.items.length, 1)
  assert.equal(list.json.items[0].amountMicro, '100000000')
  assert.equal(typeof list.json.items[0].amountMicro, 'string')
  const listCall = app.topup.calls.find((item) => item.method === 'listMine')
  assert.deepEqual(listCall?.args, [2, 5])

  const one = await call(app.server, `/api/topup/orders/${ORDER_NO}`, { cookie })
  assert.equal(one.status, 200, one.text)
  assert.equal(one.json.orderNo, ORDER_NO)
  const getCall = app.topup.calls.find((item) => item.method === 'getMine')
  assert.deepEqual(getCall?.args, [2, ORDER_NO])
})

test('取消自己的订单：200；GET 打取消接口是 405', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  const reply = await call(app.server, `/api/topup/orders/${ORDER_NO}/cancel`, {
    method: 'POST',
    cookie,
  })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.status, 'canceled')
  assert.equal(typeof reply.json.canceledAt, 'string')

  const wrong = await call(app.server, `/api/topup/orders/${ORDER_NO}/cancel`, { cookie })
  assert.equal(wrong.status, 405)
})

test('用户面错误码 → HTTP 状态码', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  const cases: { readonly code: string; readonly status: number }[] = [
    { code: 'TOPUP_AMOUNT_INVALID', status: 400 },
    { code: 'TOPUP_AMOUNT_OUT_OF_RANGE', status: 400 },
    { code: 'TOPUP_PROVIDER_UNKNOWN', status: 400 },
    { code: 'TOPUP_INPUT_INVALID', status: 400 },
    { code: 'TOPUP_ORDER_STATE', status: 409 },
    { code: 'TOPUP_ORDER_NOT_FOUND', status: 404 },
    { code: 'TOPUP_PROVIDER_FAILED', status: 502 },
    { code: 'TOPUP_BALANCE_FAILED', status: 503 },
    { code: 'TOPUP_NOT_READY', status: 503 },
    { code: 'TOPUP_STORE_FAILED', status: 500 },
    { code: 'TOPUP_STORE_CORRUPT', status: 500 },
  ]
  for (const item of cases) {
    app.topup.failCode = item.code
    const reply = await call(app.server, '/api/topup/orders', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ amountYuan: '100' }),
    })
    assert.equal(reply.status, item.status, `${item.code} 应是 ${item.status}`)
    assert.equal(reply.json.error.code, item.code)
  }
})

test('充值订单服务不在运行：用户面与管理面都 503，入口本身照常', async (t) => {
  const app = await setup(t, { withoutTopup: true })
  const cookie = sessionCookie(app, 1)
  for (const [method, path] of [
    ['GET', '/api/topup/options'],
    ['GET', '/api/topup/orders'],
    ['POST', '/api/topup/orders'],
    ['GET', '/api/admin/topup-orders'],
    ['GET', '/api/admin/topup-orders/stats'],
    ['POST', `/api/admin/topup-orders/${ORDER_NO}/confirm`],
  ] as const) {
    const reply = await call(app.server, path, {
      method,
      cookie,
      ...(method === 'POST' ? { body: JSON.stringify({ amountYuan: '100' }) } : {}),
    })
    assert.equal(reply.status, 503, `${method} ${path}`)
    assert.equal(reply.json.error.code, 'TOPUP_UNAVAILABLE')
  }

  // 别的入口不受影响。
  const session = await call(app.server, '/api/session', { cookie })
  assert.equal(session.status, 200)
})

// ───────────────────────────────── 管理面 ─────────────────────────────────

test('管理面要求管理员：普通用户 403', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  for (const [method, path] of [
    ['GET', '/api/admin/topup-orders'],
    ['GET', '/api/admin/topup-orders/stats'],
    ['POST', `/api/admin/topup-orders/${ORDER_NO}/confirm`],
    ['POST', `/api/admin/topup-orders/${ORDER_NO}/cancel`],
  ] as const) {
    const reply = await call(app.server, path, { method, cookie })
    assert.equal(reply.status, 403, `${method} ${path}`)
    assert.equal(reply.json.error.code, 'API_FORBIDDEN')
  }
})

test('管理面列表：筛选与分页参数按名传给服务，金额是字符串', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  const reply = await call(
    app.server,
    '/api/admin/topup-orders?status=pending&userId=2&from=1000&to=2000&limit=5&offset=3',
    { cookie },
  )
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.total, 1)
  assert.equal(reply.json.items[0].amountMicro, '100000000')

  const listCall = app.topup.calls.find((item) => item.method === 'list')
  assert.deepEqual(listCall?.args, [
    {
      status: 'pending',
      userId: 2,
      fromMs: 1000,
      toMs: 2000,
      limit: 5,
      offset: 3,
    },
  ])

  const tooBig = await call(app.server, '/api/admin/topup-orders?limit=1000', { cookie })
  assert.equal(tooBig.status, 400)
})

test('确认到账：200 且 credited=true；重复确认 credited=false（不会再加钱）', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  const first = await call(app.server, `/api/admin/topup-orders/${ORDER_NO}/confirm`, {
    method: 'POST',
    cookie,
  })
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.credited, true)
  assert.equal(first.json.order.orderNo, ORDER_NO)

  app.topup.confirmCredited = false
  const again = await call(app.server, `/api/admin/topup-orders/${ORDER_NO}/confirm`, {
    method: 'POST',
    cookie,
  })
  assert.equal(again.status, 200, again.text)
  assert.equal(again.json.credited, false)

  const confirmCall = app.topup.calls.find((item) => item.method === 'confirmPaid')
  assert.deepEqual(confirmCall?.args, [API_ACTOR, ORDER_NO])
})

test('管理面取消：200；用 GET 打确认 / 取消是 405', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  const reply = await call(app.server, `/api/admin/topup-orders/${ORDER_NO}/cancel`, {
    method: 'POST',
    cookie,
  })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.status, 'canceled')

  for (const path of [
    `/api/admin/topup-orders/${ORDER_NO}/confirm`,
    `/api/admin/topup-orders/${ORDER_NO}/cancel`,
  ]) {
    const wrong = await call(app.server, path, { cookie })
    assert.equal(wrong.status, 405, path)
  }
})

test('管理面统计：四项计数 + 两个金额字符串', async (t) => {
  const app = await setup(t)
  const reply = await call(app.server, '/api/admin/topup-orders/stats', {
    cookie: sessionCookie(app, 1),
  })
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(reply.json, {
    todayPaidCount: 1,
    todayPaidMicros: '100000000',
    totalPaidCount: 2,
    totalPaidMicros: '300000000',
    pendingCount: 3,
    expiredCount: 4,
  })
})

test('管理面错误码 → HTTP 状态码（确认到账）', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  const cases: { readonly code: string; readonly status: number }[] = [
    { code: 'TOPUP_ORDER_NOT_FOUND', status: 404 },
    { code: 'TOPUP_ORDER_STATE', status: 409 },
    { code: 'TOPUP_BALANCE_FAILED', status: 503 },
    { code: 'TOPUP_PROVIDER_FAILED', status: 502 },
    { code: 'TOPUP_ACTOR_FORBIDDEN', status: 403 },
    { code: 'TOPUP_STORE_CORRUPT', status: 500 },
  ]
  for (const item of cases) {
    app.topup.failCode = item.code
    const reply = await call(app.server, `/api/admin/topup-orders/${ORDER_NO}/confirm`, {
      method: 'POST',
      cookie,
    })
    assert.equal(reply.status, item.status, `${item.code} 应是 ${item.status}`)
    assert.equal(reply.json.error.code, item.code)
  }
})
