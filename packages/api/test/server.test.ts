/**
 * HTTP 入口：生命周期、四道闸与健康清单。
 *
 * 从 `server.test.ts` 按入口分组拆出（§5.6：测试文件 500 行上限）；断言逐字未改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { call, cookieOf, login, setup } from './helpers/server-harness.ts'

// ───────────────────────────────── 生命周期与访问闸 ─────────────────────────────────

test('生命周期：端口 0 起停、地址可读、stop 幂等', async (t) => {
  const { server } = await setup(t)
  assert.ok(server.address !== undefined)
  assert.ok((server.address?.port ?? 0) > 0)
  assert.match(server.origin ?? '', /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.equal(server.listening, true)

  await server.stop()
  await server.stop()
  assert.equal(server.listening, false)
  assert.equal(server.address, undefined)
})

test('四道闸：Host、X-Requested-With、Origin、Sec-Fetch-Site', async (t) => {
  const { server } = await setup(t)

  const badHost = await call(server, '/api/health', { headers: { host: 'evil.example' } })
  assert.equal(badHost.status, 403)
  assert.equal(badHost.json.error.code, 'API_HOST_FORBIDDEN')

  const noHeader = await call(server, '/api/health', { headers: { 'x-requested-with': undefined } })
  assert.equal(noHeader.status, 403)
  assert.equal(noHeader.json.error.code, 'API_REQUEST_HEADER_REQUIRED')

  const badOrigin = await call(server, '/api/health', { headers: { origin: 'http://evil.example' } })
  assert.equal(badOrigin.status, 403)
  assert.equal(badOrigin.json.error.code, 'API_ORIGIN_FORBIDDEN')

  const crossSite = await call(server, '/api/health', { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.error.code, 'API_ORIGIN_FORBIDDEN')

  const sameOrigin = await call(server, '/api/health', {
    headers: {
      origin: `http://127.0.0.1:${server.address?.port}`,
      'sec-fetch-site': 'same-origin',
    },
  })
  assert.equal(sameOrigin.status, 200)
  assert.equal(sameOrigin.headers['access-control-allow-origin'], undefined, '不发送任何 CORS 头')
})

test('健康与清单：真实汇总、account-priority 缺失时 degraded、不编造桥', async (t) => {
  const { server } = await setup(t)
  const health = await call(server, '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.state, 'ok')
  assert.equal(health.json.bridge.connected, true)
  assert.equal(health.json.bridge.transport, 'tcp')
  assert.ok(health.json.components.some((component: any) => component.name === 'account-priority'))

  const manifest = await call(server, '/api/console/manifest')
  assert.equal(manifest.status, 200)
  assert.equal(manifest.headers['cache-control'], 'no-store')
  assert.equal(manifest.json.revision, 'manifest-1')

  const missing = await setup(t, { withoutPriority: true })
  const degraded = await call(missing.server, '/api/health')
  assert.equal(degraded.status, 200)
  assert.equal(degraded.json.state, 'degraded')
  assert.equal(degraded.json.bridge.connected, false)
  assert.equal(degraded.json.bridge.transport, null)
  assert.ok(degraded.json.components.some((component: any) => component.name === 'account-priority' && component.state === 'degraded'))
})

// ───────────────────────────────── 注册 / 登录 / 会话 ─────────────────────────────────
