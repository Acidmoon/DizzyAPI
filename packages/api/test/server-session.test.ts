/**
 * HTTP 入口：会话、注册、找回密码与资料。
 *
 * 从 `server.test.ts` 按入口分组拆出（§5.6：测试文件 500 行上限）；断言逐字未改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { call, cookieOf, login, setup } from './helpers/server-harness.ts'

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

