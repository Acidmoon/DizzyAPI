/**
 * 产品 HTTP 入口的兑换码路由测试。
 *
 * 覆盖：用户面（兑换 / 我的记录）与会话闸、错误码 → 状态码映射、服务缺失时 503、
 * 管理面权限与参数校验、生成批次时明文只出现在那一次响应里、列表只回掩码。
 *
 * 金额在 JSON 里一律是十进制字符串（浏览器用 BigInt 解析）；响应里不出现裸 bigint。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { API_ACTOR, ApiServer } from '../src/http.ts'
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

/**
 * 直接注入会话令牌，省掉一次登录：本文件要的是「管理员 / 普通用户」两种身份，
 * 不是登录流程本身（那是 auth 的测试）。
 */
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

test('兑换：未登录 401；登录后 200，金额是十进制字符串', async (t) => {
  const app = await setup(t)
  const anonymous = await call(app.server, '/api/redeem', {
    method: 'POST',
    body: JSON.stringify({ code: 'ABCD-EFGH-JKMN-PQRS-TVWX-0001' }),
  })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json.error.code, 'API_UNAUTHORIZED')

  const cookie = sessionCookie(app, 2)
  const reply = await call(app.server, '/api/redeem', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ code: 'abcd-efgh-jkmn-pqrs-tvwx-0001' }),
  })
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(reply.json, {
    amountMinor: '5000000',
    balanceMinor: '12345678',
    batchName: '测试批次',
  })
  // 传下去的按原样交给服务（规范化是 redeem 插件的职责，不在 HTTP 层重复）。
  const callRecord = app.redeem.calls.find((item) => item.method === 'redeemCode')
  assert.deepEqual(callRecord?.args, [{ userId: 2, code: 'abcd-efgh-jkmn-pqrs-tvwx-0001' }])
})

test('我的兑换记录：GET /api/redeem 只回掩码与金额字符串', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  const reply = await call(app.server, '/api/redeem?limit=5', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(reply.json.items, [
    {
      codeId: 'code-1',
      codeMask: '****A3F7',
      amountMinor: '5000000',
      batchName: '测试批次',
      redeemedAt: '2026-10-19T12:00:00.000Z',
    },
  ])
  assert.equal(app.redeem.calls[0]?.method, 'listMyRedemptions')
  assert.deepEqual(app.redeem.calls[0]?.args, [2, 5])
})

test('兑换错误码 → HTTP 状态码', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  const cases: { readonly code: string; readonly status: number }[] = [
    { code: 'REDEEM_CODE_INVALID', status: 400 },
    { code: 'REDEEM_CODE_NOT_FOUND', status: 404 },
    { code: 'REDEEM_CODE_DISABLED', status: 409 },
    { code: 'REDEEM_CODE_EXPIRED', status: 409 },
    { code: 'REDEEM_CODE_USED', status: 409 },
    { code: 'REDEEM_CODE_REDEEMING', status: 409 },
    { code: 'REDEEM_CODE_CONFLICT', status: 409 },
    { code: 'REDEEM_CODE_BALANCE_FAILED', status: 503 },
    { code: 'REDEEM_USER_FORBIDDEN', status: 403 },
    { code: 'REDEEM_STORE_CORRUPT', status: 500 },
  ]
  for (const item of cases) {
    app.redeem.failRedeem = item.code
    const reply = await call(app.server, '/api/redeem', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ code: 'ABCD-EFGH-JKMN-PQRS-TVWX-0001' }),
    })
    assert.equal(reply.status, item.status, `${item.code} 应是 ${item.status}`)
    assert.equal(reply.json.error.code, item.code)
  }
})

test('兑换码服务不在运行：用户面与管理员面都 503，入口本身照常', async (t) => {
  const app = await setup(t, { withoutRedeem: true })
  const cookie = sessionCookie(app, 1)

  const redeem = await call(app.server, '/api/redeem', { cookie })
  assert.equal(redeem.status, 503)
  assert.equal(redeem.json.error.code, 'REDEEM_UNAVAILABLE')

  const codes = await call(app.server, '/api/admin/redeem-codes', { cookie })
  assert.equal(codes.status, 503)
  assert.equal(codes.json.error.code, 'REDEEM_UNAVAILABLE')

  // 其它入口不受影响。
  const session = await call(app.server, '/api/session', { cookie })
  assert.equal(session.status, 200)
})

// ───────────────────────────────── 管理面 ─────────────────────────────────

test('管理面要求管理员', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 2)
  for (const [path, method] of [
    ['/api/admin/redeem-codes', 'GET'],
    ['/api/admin/redeem-codes', 'POST'],
    ['/api/admin/redeem-batches', 'GET'],
    ['/api/admin/redeem-stats', 'GET'],
  ] as const) {
    const reply = await call(app.server, path, {
      method,
      cookie,
      ...(method === 'POST' ? { body: JSON.stringify({ name: 'x', amountMicro: '1', count: 1 }) } : {}),
    })
    assert.equal(reply.status, 403, `${method} ${path}`)
    assert.equal(reply.json.error.code, 'API_FORBIDDEN')
  }
})

test('生成批次：200，明文只在这一次响应里；列表只有掩码', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)

  const created = await call(app.server, '/api/admin/redeem-codes', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      name: '双十一',
      amountMicro: '5000000',
      count: 2,
      notes: '测试批次',
    }),
  })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.json.codes.length, 2)
  assert.equal(created.json.batch.name, '双十一')
  assert.equal(created.json.batch.amountMinor, '5000000')
  assert.equal(created.json.batch.total, 2)
  assert.equal(created.json.batch.kind, 'balance')

  // actor 必须是 api 插件自己（app.yml 的 adminPlugins 里登记的就是它）。
  const createCall = app.redeem.calls.find((item) => item.method === 'createBatch')
  assert.equal((createCall?.args as unknown[])[0], API_ACTOR)
  const input = (createCall?.args as unknown[])[1] as { amountMicro: bigint; count: number }
  assert.equal(input.amountMicro, 5_000_000n)
  assert.equal(input.count, 2)

  // 列表里不该出现明文。
  const list = await call(app.server, '/api/admin/redeem-codes?batch=batch-1', { cookie })
  assert.equal(list.status, 200, list.text)
  assert.equal(list.json.items.length, 2)
  for (const item of list.json.items) {
    assert.match(item.codeMask, /^\*{4}[0-9A-Z]{4}$/)
    assert.equal(typeof item.amountMinor, 'string')
  }
  for (const plain of created.json.codes as string[]) {
    assert.ok(!list.text.includes(plain), '列表响应里不得出现明文')
  }
})

test('管理面参数校验：金额不走浮点、数量有上下限、ids 必须是数组', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  const post = (body: unknown): Promise<Reply> =>
    call(app.server, '/api/admin/redeem-codes', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    })

  for (const amountMicro of [1.5, -1, 'abc', '', null, {}]) {
    const reply = await post({ name: 'x', amountMicro, count: 1 })
    assert.equal(reply.status, 400, `amountMicro=${String(amountMicro)} 必须被拒`)
  }
  for (const count of [0, 101, 1.5, '2', null]) {
    const reply = await post({ name: 'x', amountMicro: '1000000', count })
    assert.equal(reply.status, 400, `count=${String(count)} 必须被拒`)
  }
  const unknown = await post({ name: 'x', amountMicro: '1000000', count: 1, extra: true })
  assert.equal(unknown.status, 400)

  const badIds = await call(app.server, '/api/admin/redeem-codes', {
    method: 'DELETE',
    cookie,
    body: JSON.stringify({ ids: 'code-1' }),
  })
  assert.equal(badIds.status, 400)
})

test('启停 / 人工核查 / 删除 / 统计 / 批次列表', async (t) => {
  const app = await setup(t)
  const cookie = sessionCookie(app, 1)
  await call(app.server, '/api/admin/redeem-codes', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ name: '批量', amountMicro: '2000000', count: 3 }),
  })

  const disabled = await call(app.server, '/api/admin/redeem-codes/status', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ id: 'code-1', status: 'disabled' }),
  })
  assert.equal(disabled.status, 200, disabled.text)
  assert.equal(disabled.json.status, 'disabled')
  assert.equal(typeof disabled.json.amountMinor, 'string')

  const resolved = await call(app.server, '/api/admin/redeem-codes/resolve', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ id: 'code-1', outcome: 'used' }),
  })
  assert.equal(resolved.status, 200, resolved.text)
  assert.equal(resolved.json.status, 'used')

  const invalidStatus = await call(app.server, '/api/admin/redeem-codes/status', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ id: 'code-1', status: 'used' }),
  })
  assert.equal(invalidStatus.status, 400)

  const removed = await call(app.server, '/api/admin/redeem-codes', {
    method: 'DELETE',
    cookie,
    body: JSON.stringify({ ids: ['code-1', 'code-2'] }),
  })
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.json.deleted, 1)
  assert.deepEqual(removed.json.rejected, [{ id: 'code-1', reason: 'REDEEM_CODE_USED' }])

  const stats = await call(app.server, '/api/admin/redeem-stats', { cookie })
  assert.equal(stats.status, 200, stats.text)
  assert.equal(stats.json.batches, 1)
  assert.equal(stats.json.codes, 2)
  assert.equal(typeof stats.json.redeemedAmountMicro, 'string')

  const batches = await call(app.server, '/api/admin/redeem-batches', { cookie })
  assert.equal(batches.status, 200, batches.text)
  assert.equal(batches.json.items.length, 1)
  assert.equal(batches.json.items[0].amountMinor, '2000000')

  const one = await call(app.server, '/api/admin/redeem-batches/batch-1', { cookie })
  assert.equal(one.status, 200, one.text)
  assert.equal(one.json.id, 'batch-1')
})
