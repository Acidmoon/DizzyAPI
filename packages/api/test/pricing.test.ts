/**
 * `/api/pricing` 的 HTTP 用例：会话读、管理员写、错误码映射与含 `/` 的模型名。
 *
 * 使用假价格表（`FakePricing`），重点验证 HTTP 层的行为；价格规范化由 pricing
 * 插件自己的用例覆盖。
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

/** 直接签发会话，免去测试依赖假 auth 的具体密码。 */
function cookieFor(auth: Fixture['auth'], userId: number): string {
  return `dizzyapi_session=${encodeURIComponent(auth.issueFor(userId))}`
}

function priceView(model: string, input = '1', output = '2') {
  return {
    model,
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: '0',
    cacheWritePerMillion: '0',
    currency: 'CNY',
    updatedAt: '2026-10-21T00:00:00.000Z',
  }
}

test('服务缺失：/api/pricing 返回 503 API_PRICING_UNAVAILABLE', async (t) => {
  const { server, auth } = await setup(t, { withoutPricing: true })
  const cookie = cookieFor(auth, 1)

  const listed = await call(server, '/api/pricing', { cookie })
  assert.equal(listed.status, 503)
  assert.equal(listed.json.error.code, 'API_PRICING_UNAVAILABLE')

  const single = await call(server, '/api/pricing/gpt-4o', { cookie })
  assert.equal(single.status, 503)
  assert.equal(single.json.error.code, 'API_PRICING_UNAVAILABLE')
})

test('读：未登录 401；普通用户可读列表与单个价格，缺失返回 404', async (t) => {
  const { server, auth, pricing } = await setup(t)
  pricing.prices.set('gpt-4o', priceView('gpt-4o', '3.75', '15'))
  pricing.prices.set('*', priceView('*', '1', '1'))

  const anonymous = await call(server, '/api/pricing')
  assert.equal(anonymous.status, 401)

  const cookie = cookieFor(auth, 2)
  const listed = await call(server, '/api/pricing', { cookie })
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.headers['cache-control'], 'no-store')
  assert.deepEqual(
    listed.json.items.map((item: { model: string }) => item.model).sort(),
    ['*', 'gpt-4o'],
  )

  const single = await call(server, '/api/pricing/gpt-4o', { cookie })
  assert.equal(single.status, 200, single.text)
  assert.deepEqual(single.json, priceView('gpt-4o', '3.75', '15'))

  const missing = await call(server, '/api/pricing/unknown-model', { cookie })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'PRICING_NOT_FOUND')
})

test('写：普通用户 403；管理员可写入、读取与删除含 / 的模型名', async (t) => {
  const { server, auth, pricing } = await setup(t)
  const userCookie = cookieFor(auth, 2)
  const adminCookie = cookieFor(auth, 1)

  const denied = await call(server, '/api/pricing/gpt-4o', {
    method: 'PUT',
    cookie: userCookie,
    body: JSON.stringify({ inputPerMillion: '1', outputPerMillion: '2' }),
  })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'API_FORBIDDEN')
  assert.equal(pricing.prices.has('gpt-4o'), false)

  const model = 'deepseek-ai/DeepSeek-V3'
  const encoded = encodeURIComponent(model)
  assert.ok(encoded.includes('%2F'), '模型名里的 / 必须编成一个路径段')

  const written = await call(server, `/api/pricing/${encoded}`, {
    method: 'PUT',
    cookie: adminCookie,
    body: JSON.stringify({
      inputPerMillion: '3.750000',
      outputPerMillion: '15',
      cacheReadPerMillion: '0.75',
    }),
  })
  assert.equal(written.status, 200, written.text)
  assert.equal(written.json.model, model)
  assert.equal(written.json.currency, 'CNY')

  const readBack = await call(server, `/api/pricing/${encoded}`, { cookie: userCookie })
  assert.equal(readBack.status, 200, readBack.text)
  assert.equal(readBack.json.model, model)

  const removed = await call(server, `/api/pricing/${encoded}`, {
    method: 'DELETE',
    cookie: adminCookie,
  })
  assert.equal(removed.status, 200, removed.text)
  assert.deepEqual(removed.json, { removed: true })

  const removedAgain = await call(server, `/api/pricing/${encoded}`, {
    method: 'DELETE',
    cookie: adminCookie,
  })
  assert.equal(removedAgain.status, 200)
  assert.deepEqual(removedAgain.json, { removed: false })
})

test('参数校验：未知字段 400，价格 / 模型非法映射成稳定 code，存储失败 500', async (t) => {
  const { server, auth, pricing } = await setup(t)
  const cookie = cookieFor(auth, 1)

  const unknownField = await call(server, '/api/pricing/gpt-4o', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ inputPerMillion: '1', outputPerMillion: '2', currency: 'USD' }),
  })
  assert.equal(unknownField.status, 400)
  assert.equal(unknownField.json.error.code, 'API_BAD_REQUEST')

  const badType = await call(server, '/api/pricing/gpt-4o', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ inputPerMillion: { value: 1 }, outputPerMillion: '2' }),
  })
  assert.equal(badType.status, 400)
  assert.equal(badType.json.error.code, 'PRICING_PRICE_INVALID')

  const missing = await call(server, '/api/pricing/gpt-4o', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ inputPerMillion: '1' }),
  })
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'PRICING_PRICE_INVALID')

  // 假价格表不校验模型名；这里让它按真实服务的错误码拒绝空白模型名。
  const originalSet = pricing.set.bind(pricing)
  pricing.set = async (actor, model, input) => {
    if (model.trim() === '') {
      const error = new Error('模型名不能为空') as Error & { code: string }
      error.code = 'PRICING_MODEL_INVALID'
      throw error
    }
    return originalSet(actor, model, input)
  }
  const badModel = await call(server, '/api/pricing/%20', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ inputPerMillion: '1', outputPerMillion: '2' }),
  })
  assert.equal(badModel.status, 400)
  assert.equal(badModel.json.error.code, 'PRICING_MODEL_INVALID')

  pricing.set = async () => {
    const error = new Error('磁盘写入失败') as Error & { code: string }
    error.code = 'PRICING_STORE_FAILED'
    throw error
  }
  const failed = await call(server, '/api/pricing/gpt-4o', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ inputPerMillion: '1', outputPerMillion: '2' }),
  })
  assert.equal(failed.status, 500)
  assert.equal(failed.json.error.code, 'PRICING_STORE_FAILED')
})
