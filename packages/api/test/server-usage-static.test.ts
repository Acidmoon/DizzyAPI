/**
 * HTTP 入口：用量、静态资源、请求体限制、头像与错误脱敏。
 *
 * 从 `server.test.ts` 按入口分组拆出（§5.6：测试文件 500 行上限）；断言逐字未改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { call, cookieOf, login, setup } from './helpers/server-harness.ts'

test('用量：余额按 BigInt 换算成分，历史不伪造；充值选项与人工确认订单', async (t) => {
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
  assert.deepEqual(usage.json.totals, {
    requests: 0,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costCents: 0,
    costMicros: '0',
  })
  assert.deepEqual(usage.json.daily, [])
  assert.deepEqual(usage.json.models, [])
  assert.deepEqual(usage.json.records, { items: [], nextCursor: null })
  assert.equal(usage.json.pricingAvailable, true)
  assert.equal(usage.json.generatedAt, '2026-10-19T12:00:00.000Z')

  const normalCookie = `dizzyapi_session=${encodeURIComponent(auth.issueFor(2))}`
  const normalUsage = await call(server, '/api/usage?range=30d', { cookie: normalCookie })
  assert.equal(normalUsage.json.balances.paidCents, 50)

  const invalid = await call(server, '/api/usage?range=1d', { cookie })
  assert.equal(invalid.status, 400)

  // 充值走人工确认（没有在线支付）：选项来自 topup 插件，金额是整数微元的十进制字符串。
  const options = await call(server, '/api/topup/options', { cookie })
  assert.equal(options.status, 200, options.text)
  assert.equal(options.json.currency, 'CNY')
  assert.equal(options.json.providerId, 'manual')
  assert.equal(options.json.online, false)
  assert.match(options.json.minAmountMicros, /^[0-9]+$/)
  assert.equal(options.json.maxAmountMicros, '10000000000')
  assert.equal(options.json.expiresMinutes, 30)

  const order = await call(server, '/api/topup/orders', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ amountYuan: '100' }),
  })
  assert.equal(order.status, 200, order.text)
  assert.equal(order.json.order.amountMicro, '100000000')
  assert.equal(order.json.order.status, 'pending')
  assert.equal(order.json.order.provider, 'manual')
  assert.equal(typeof order.json.instructions, 'string')
  assert.ok(order.json.instructions.length > 0)

  // 旧的 501 契约（分 + method + alipay）已经不存在：未知字段明确 400，不再假装「未实现」。
  const legacy = await call(server, '/api/topup/orders', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ amountCents: 10_000, method: 'alipay' }),
  })
  assert.equal(legacy.status, 400)
  assert.equal(legacy.json.error.code, 'API_BAD_REQUEST')
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
