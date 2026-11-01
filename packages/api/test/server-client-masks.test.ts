/**
 * HTTP 入口：管理面客户端指纹档案（`/api/admin/client-masks`）。
 *
 * 这批用例要钉住四件事：
 * 1. **读面**：列表带 `status`，档案形状逐字段（`headers` 只留 `{name, value}`）；
 * 2. **写面**：新增 / 改 / 删 / 恢复出厂都真的走到了服务方法，且**逐条留审计**；
 * 3. **该拒的拒**：未知字段 400、未知 id 404、内置档案删除 400（插件拒、路由透码）、
 *    普通用户 403、插件缺席 503；
 * 4. **写面不把整份档案抄进审计** —— 审计只记 id 与字段名。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { call, login, setup } from './helpers/server-harness.ts'

test('客户端档案：列表带 status，形状只透 name / value', async (t) => {
  const { server } = await setup(t)
  const { cookie } = await login(server)

  const listed = await call(server, '/api/admin/client-masks', { cookie })
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.json.items.length, 3)
  assert.equal(listed.json.items[0].id, 'opencode')
  assert.equal(listed.json.items[0].builtin, true)
  assert.deepEqual(listed.json.items[0].headers, [{ name: 'x-opencode-session', value: '{{session}}' }])
  assert.equal(listed.json.status.profiles, 3)
  assert.equal(listed.json.status.builtin, 2)
  assert.equal(listed.json.status.custom, 1)
  assert.equal(listed.json.status.enabledProfiles, 2)

  // 单条：未知 id 是 404，不是 500（页面要能区分「被删了」与「服务坏了」）。
  const one = await call(server, '/api/admin/client-masks/opencode', { cookie })
  assert.equal(one.status, 200, one.text)
  assert.equal(one.json.profile.label, 'opencode')
  const missing = await call(server, '/api/admin/client-masks/nope', { cookie })
  assert.equal(missing.status, 404, missing.text)
})

test('客户端档案：新建 / 改 / 删 / 恢复出厂都走服务方法，且各记一条审计', async (t) => {
  const { server, clientMask, audit } = await setup(t)
  const { cookie } = await login(server)

  const created = await call(server, '/api/admin/client-masks', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      id: 'my-cli',
      label: '我的 CLI',
      enabled: true,
      userAgent: 'dizzy-cli/1.0',
      headers: [{ name: 'x-client', value: 'cli' }],
    }),
  })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.json.profile.id, 'my-cli')
  assert.deepEqual(created.json.profile.headers, [{ name: 'x-client', value: 'cli' }])
  assert.deepEqual(
    clientMask.calls.find((entry) => entry.method === 'upsert')?.args,
    ['@dizzyapi/plugin-api', { id: 'my-cli', label: '我的 CLI', enabled: true, userAgent: 'dizzy-cli/1.0', headers: [{ name: 'x-client', value: 'cli' }] }],
  )

  const patched = await call(server, '/api/admin/client-masks/my-cli', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ enabled: false, userAgent: null }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.profile.enabled, false)
  assert.equal(patched.json.profile.userAgent, null)

  const removed = await call(server, '/api/admin/client-masks/my-cli', { method: 'DELETE', cookie })
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.json.removed, true)

  const reset = await call(server, '/api/admin/client-masks/opencode/reset', {
    method: 'POST',
    cookie,
    body: '{}',
  })
  assert.equal(reset.status, 200, reset.text)
  assert.equal(reset.json.profile.builtin, true)

  const actions = audit.calls.map((entry) => entry.action)
  for (const action of ['client_mask.create', 'client_mask.update', 'client_mask.remove', 'client_mask.reset']) {
    assert.ok(actions.includes(action), `缺少审计动作 ${action}`)
  }
  // 审计里不许出现头值（模板也是数据，没必要扩散到审计表）。
  assert.equal(JSON.stringify(audit.calls).includes('x-opencode-session'), false)
})

test('客户端档案：内置预置不能删（插件拒 → 400），未知字段 400', async (t) => {
  const { server } = await setup(t)
  const { cookie } = await login(server)

  const builtinDelete = await call(server, '/api/admin/client-masks/opencode', {
    method: 'DELETE',
    cookie,
  })
  assert.equal(builtinDelete.status, 400, builtinDelete.text)
  assert.equal(builtinDelete.json.error.code, 'CLIENT_MASK_INPUT_INVALID')

  const unknownField = await call(server, '/api/admin/client-masks/opencode', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ secrets: 'nope' }),
  })
  assert.equal(unknownField.status, 400, unknownField.text)

  const emptyPatch = await call(server, '/api/admin/client-masks/opencode', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({}),
  })
  assert.equal(emptyPatch.status, 400, emptyPatch.text)
})

test('客户端档案：普通用户 403、插件缺席 503、非管理员一律不写', async (t) => {
  const { server } = await setup(t)
  const member = await login(server, 'alice@example.com', 'password2')

  const denied = await call(server, '/api/admin/client-masks', { cookie: member.cookie })
  assert.equal(denied.status, 403, denied.text)

  const missing = await setup(t, { withoutClientMask: true })
  const admin = await login(missing.server)
  const unavailable = await call(missing.server, '/api/admin/client-masks', { cookie: admin.cookie })
  assert.equal(unavailable.status, 503, unavailable.text)
  assert.equal(unavailable.json.error.code, 'CLIENT_MASK_UNAVAILABLE')
})

test('账号：PATCH 带 clientProfile 走 update，批量 patch 里禁止它', async (t) => {
  const { server, accountAdmin } = await setup(t)
  const { cookie } = await login(server)

  const patched = await call(server, '/api/accounts/acc_1', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ clientProfile: 'codex' }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.deepEqual(
    accountAdmin.calls.find((entry) => entry.method === 'update')?.args,
    ['@dizzyapi/plugin-api', 'acc_1', { clientProfile: 'codex' }],
  )

  // 清空也是合法值（null = 不伪装）。
  const cleared = await call(server, '/api/accounts/acc_1', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ clientProfile: null }),
  })
  assert.equal(cleared.status, 200, cleared.text)

  // 批量不许改档案：一个账号一个决定，一刀切会让本来能通的账号悄悄失效。
  const bulk = await call(server, '/api/accounts/bulk', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ action: 'update', ids: ['acc_1'], patch: { clientProfile: 'codex' } }),
  })
  assert.equal(bulk.status, 400, bulk.text)
})

test('写路径：畸形的 headers 必须 400，且不许把已有头清空', async (t) => {
  const { server, clientMask } = await setup(t)
  const { cookie } = await login(server)

  // 漏了 value（最危险的一种：宽松过滤会变成 `[]` = 清空所有头，然后报「保存成功」）。
  const missingValue = await call(server, '/api/admin/client-masks/opencode', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ headers: [{ name: 'x-opencode-session' }] }),
  })
  assert.equal(missingValue.status, 400, missingValue.text)
  assert.match(missingValue.json.error.message, /第 1 行/)

  // 大小写/空 name、非字符串 value、非数组一律拒。
  for (const headers of [
    [{ name: '', value: 'x' }],
    [{ value: 'x' }],
    [{ name: 'x', value: 123 }],
    ['not-an-object'],
    'not-an-array',
  ]) {
    const bad = await call(server, '/api/admin/client-masks/opencode', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ headers }),
    })
    assert.equal(bad.status, 400, `${JSON.stringify(headers)} → ${bad.text}`)
  }

  // **关键**：被拒之后档案的头必须原样还在（没有被清空），而且 update 一次都没被调用。
  const after = await call(server, '/api/admin/client-masks/opencode', { cookie })
  assert.equal(after.status, 200, after.text)
  assert.deepEqual(after.json.profile.headers, [{ name: 'x-opencode-session', value: '{{session}}' }])
  assert.equal(clientMask.calls.some((entry) => entry.method === 'update'), false)

  // 新建路径同样严格。
  const created = await call(server, '/api/admin/client-masks', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ id: 'broken', headers: [{ name: 'x' }] }),
  })
  assert.equal(created.status, 400, created.text)
})

test('读路径：插件里混进畸形头不让整页 502，过滤掉就行', async (t) => {
  const { server, clientMask } = await setup(t)
  const { cookie } = await login(server)

  // 模拟脏数据：一好一坏（坏的那行缺 value 且不是字符串）。
  ;(clientMask.profiles as unknown as Record<string, unknown>[]).push({
    id: 'dirty',
    label: 'dirty',
    description: null,
    enabled: true,
    userAgent: null,
    headers: [{ name: 'ok-header', value: 'yes' }, { name: 'broken' }, null],
    builtin: false,
  })

  const listed = await call(server, '/api/admin/client-masks', { cookie })
  assert.equal(listed.status, 200, listed.text)
  const dirty = listed.json.items.find((item: { id: string }) => item.id === 'dirty')
  assert.deepEqual(dirty.headers, [{ name: 'ok-header', value: 'yes' }])
})
