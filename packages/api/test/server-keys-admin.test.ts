/**
 * HTTP 入口：API key 与管理面用户。
 *
 * 从 `server.test.ts` 按入口分组拆出（§5.6：测试文件 500 行上限）；断言逐字未改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_ACTOR, ApiServer } from '../src/http.ts'
import { call, cookieOf, login, setup } from './helpers/server-harness.ts'

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

