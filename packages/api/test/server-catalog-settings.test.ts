/**
 * HTTP 入口：管理面目录与管理面设置。
 *
 * 从 `server.test.ts` 按入口分组拆出（§5.6：测试文件 500 行上限）；断言逐字未改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_ACTOR, ApiServer } from '../src/http.ts'
import { call, cookieOf, login, setup } from './helpers/server-harness.ts'

test('管理员目录：catalog.query 映射成 CatalogResponse，pages 按 owner/package 匹配', async (t) => {
  const { server } = await setup(t, {
    pages: [
      {
        id: 'api.admin.entry',
        owner: '@dizzyapi/plugin-api',
        area: 'admin',
        path: '/admin/api',
        title: 'API',
      },
    ],
  })
  const { cookie } = await login(server)
  const reply = await call(server, '/api/catalog/modules', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.generatedAt, '2026-10-19T00:00:00.000Z', 'generatedAt 来自 catalog.query()')
  const api = reply.json.modules.find((module: any) => module.id === 'api')
  assert.equal(api.kind, 'plugin')
  assert.equal(api.state, 'active')
  assert.deepEqual(api.pages, ['/admin/api'])
  assert.ok(api.provides.includes('http-api'))
  const off = reply.json.modules.find((module: any) => module.id === 'off')
  assert.equal(off.state, 'disabled')
})

test('管理员设置：描述 / 写入 / 恢复基线，actor 固定为 plugin-api', async (t) => {
  const { server, settings } = await setup(t)
  const { cookie } = await login(server)

  const described = await call(server, '/api/settings', { cookie })
  assert.equal(described.status, 200)
  assert.equal(described.json.namespaces[0].ns, 'mailer')

  const updated = await call(server, '/api/settings/mailer', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ patch: { from: 'robot@example.com' }, expectedRevision: 'rev-1' }),
  })
  assert.equal(updated.status, 200, updated.text)
  const updateCall = settings.calls.find((entry) => entry.method === 'update')
  assert.deepEqual(updateCall?.args, [API_ACTOR, 'mailer', { from: 'robot@example.com' }, 'rev-1'])

  const reset = await call(server, '/api/settings/mailer', { method: 'DELETE', cookie })
  assert.equal(reset.status, 200)
  assert.deepEqual(settings.calls.find((entry) => entry.method === 'reset')?.args, [API_ACTOR, 'mailer'])
})

test('设置插件缺失时 503', async (t) => {
  const { server } = await setup(t, { withSettings: false })
  const { cookie } = await login(server)
  const reply = await call(server, '/api/settings', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'API_SETTINGS_UNAVAILABLE')
})

