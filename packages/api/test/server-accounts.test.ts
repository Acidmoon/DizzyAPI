/**
 * HTTP 入口：管理面上游账号（列表 / 详情 / 探测 / 导入）。
 *
 * 从 `server.test.ts` 按入口分组拆出（§5.6：测试文件 500 行上限）；断言逐字未改。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { API_ACTOR, ApiServer } from '../src/http.ts'
import { call, cookieOf, login, setup } from './helpers/server-harness.ts'

test('管理员账号：列表 / 详情剥掉 credentialRef，PATCH enabled 走 enable/disable', async (t) => {
  const { server, accountAdmin } = await setup(t)
  const { cookie } = await login(server)

  const listed = await call(server, '/api/accounts?provider=openai&limit=1', { cookie })
  assert.equal(listed.status, 200, listed.text)
  assert.equal(listed.json.items.length, 1)
  assert.equal(listed.json.nextCursor, null)
  assert.equal(listed.json.items[0].id, 'acc_1')
  assert.deepEqual(
    Object.keys(listed.json.items[0]).sort(),
    [
      'accessExpiresAt',
      'backoffUntil',
      'baseUrl',
      'clientProfile',
      'createdAt',
      'email',
      'enabled',
      'failureCount',
      'id',
      'kind',
      'label',
      'lastError',
      'lastRefreshAt',
      'lastTestAt',
      'lastTestError',
      'lastTestLatencyMs',
      'lastTestOk',
      'models',
      'modelMap',
      'priority',
      'protocol',
      'provider',
      'refreshDueAt',
      'status',
      'subject',
      'updatedAt',
    ].sort(),
    '账号响应必须逐字段挑选，不能漏出 credentialRef / credentialConfigured',
  )
  assert.ok(!listed.text.includes('credentialRef'))
  assert.ok(!listed.text.includes('credentialConfigured'))

  const one = await call(server, '/api/accounts/acc_1', { cookie })
  assert.equal(one.status, 200)
  assert.ok(!one.text.includes('credentialRef'))

  const created = await call(server, '/api/accounts', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      provider: 'openai',
      kind: 'api_key',
      label: 'new account',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 7,
      credential: { payload: 'sk-upstream', format: 'auto' },
    }),
  })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.json.label, 'new account')
  assert.equal(created.json.protocol, 'openai-chat')
  assert.deepEqual(created.json.models, ['gpt-5', 'gpt-5-codex'])
  assert.deepEqual(created.json.modelMap, { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' })
  assert.ok(!created.text.includes('credentialRef'))
  const createCall = accountAdmin.calls.find((entry) => entry.method === 'create')
  assert.deepEqual(createCall?.args, [
    API_ACTOR,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'new account',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 7,
      credential: { payload: 'sk-upstream', format: 'auto' },
    },
  ])

  const patched = await call(server, '/api/accounts/acc_1', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({
      label: 'renamed',
      baseUrl: 'https://new.example.com/v1',
      protocol: 'anthropic',
      models: ['o3'],
      modelMap: { o3: 'o3-mini' },
      priority: 9,
      enabled: false,
    }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.label, 'renamed')
  assert.equal(patched.json.baseUrl, 'https://new.example.com/v1')
  assert.equal(patched.json.protocol, 'anthropic')
  assert.deepEqual(patched.json.models, ['o3'])
  assert.deepEqual(patched.json.modelMap, { o3: 'o3-mini' })
  assert.equal(patched.json.priority, 9)
  assert.equal(patched.json.enabled, false)
  const updateCall = accountAdmin.calls.find((entry) => entry.method === 'update')
  assert.deepEqual(updateCall?.args, [
    API_ACTOR,
    'acc_1',
    {
      label: 'renamed',
      baseUrl: 'https://new.example.com/v1',
      protocol: 'anthropic',
      models: ['o3'],
      modelMap: { o3: 'o3-mini' },
      priority: 9,
    },
  ])
  assert.ok(accountAdmin.calls.some((entry) => entry.method === 'disable'))
  assert.ok(!accountAdmin.calls.some((entry) => entry.method === 'enable'), 'enabled 不能被塞进 update')

  const credentials = await call(server, '/api/accounts/acc_1/credentials', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ payload: 'sk-upstream', format: 'api-key' }),
  })
  assert.equal(credentials.status, 200, credentials.text)
  assert.ok(!credentials.text.includes('credentialRef'))
  assert.ok(accountAdmin.calls.some((entry) => entry.method === 'importCredentials'))

  const preview = await call(server, '/api/accounts/import/preview', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ payload: 'sk-upstream' }),
  })
  assert.equal(preview.status, 200)
  assert.equal(preview.json.format, 'api-key')

  const bulk = await call(server, '/api/accounts/import', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ items: [{ payload: 'sk-upstream' }] }),
  })
  assert.equal(bulk.status, 200, bulk.text)
  assert.ok(!bulk.text.includes('credentialRef'))

  const removed = await call(server, '/api/accounts/acc_2', { method: 'DELETE', cookie })
  assert.equal(removed.status, 200)
})

test('管理员账号：连通性测试只回状态与耗时，普通用户 403', async (t) => {
  const { server, accountAdmin } = await setup(t)
  const { cookie } = await login(server)

  const replied = await call(server, '/api/accounts/acc_1/test', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ model: 'gpt-5', protocol: 'openai-chat' }),
  })
  assert.equal(replied.status, 200, replied.text)
  assert.equal(replied.json.ok, true)
  assert.equal(replied.json.status, 200)
  assert.equal(replied.json.latencyMs, 123)
  assert.equal(replied.json.model, 'gpt-5')
  assert.equal(replied.json.protocol, 'openai-chat')
  assert.ok(!replied.text.includes('credentialRef'))
  assert.ok(!replied.text.includes('credentialConfigured'))
  assert.ok(!replied.text.includes('credential-ref-acc-1'))
  // 详情块：提示词与响应片段要透出去（管理台弹窗靠它显示「上游到底回了什么」）。
  assert.deepEqual(replied.json.request, {
    prompt: 'hi',
    model: 'gpt-5',
    protocol: 'openai-chat',
    endpoint: 'https://api.openai.com/v1/chat/completions',
  })
  assert.deepEqual(replied.json.response, {
    status: 200,
    bodySnippet: '{"id":"chatcmpl-1"}',
    truncated: false,
  })
  assert.deepEqual(
    accountAdmin.calls.find((entry) => entry.method === 'testConnection')?.args,
    ['acc_1', { model: 'gpt-5', protocol: 'openai-chat' }],
  )

  const member = await login(server, 'alice@example.com', 'password2')
  const denied = await call(server, '/api/accounts/acc_1/test', { method: 'POST', cookie: member.cookie })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'API_FORBIDDEN')
})

test('管理员账号：导入 body 带 source 时走来源预检 / 导入，响应不含凭据', async (t) => {
  const { server, accountAdmin } = await setup(t)
  const { cookie } = await login(server)

  const preview = await call(server, '/api/accounts/import/preview', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ source: 'plain-keys', payload: 'sk-a\nsk-b' }),
  })
  assert.equal(preview.status, 200, preview.text)
  assert.equal(preview.json.source, 'plain-keys')
  assert.equal(preview.json.total, 1)
  assert.equal(preview.json.items[0].label, 'from-source')
  assert.ok(!preview.text.includes('sk-a'))
  assert.ok(!preview.text.includes('sk-b'))
  assert.deepEqual(
    accountAdmin.calls.find((entry) => entry.method === 'previewImportSource')?.args,
    [{ source: 'plain-keys', payload: 'sk-a\nsk-b' }],
  )

  const imported = await call(server, '/api/accounts/import', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      source: 'sub2api',
      payload: '{"type":"sub2api-data","accounts":[]}',
      defaults: { provider: 'openai' },
    }),
  })
  assert.equal(imported.status, 200, imported.text)
  assert.equal(imported.json.created, 1)
  assert.equal(imported.json.items[0].account.id, 'acc_1')
  assert.ok(!imported.text.includes('credentialRef'))
  assert.ok(!imported.text.includes('credential-ref-acc-1'))
})


test('管理员账号：POST /api/accounts/bulk 批量启停 / 改字段，patch 不许带 enabled', async (t) => {
  const { server, accountAdmin } = await setup(t)
  const { cookie } = await login(server)

  const enabled = await call(server, '/api/accounts/bulk', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ action: 'enable', ids: ['acc_1', 'acc_2'] }),
  })
  assert.equal(enabled.status, 200, enabled.text)
  assert.equal(enabled.json.total, 2)
  assert.equal(enabled.json.succeeded, 2)
  assert.deepEqual(
    accountAdmin.calls.find((entry) => entry.method === 'bulkEnable')?.args,
    [API_ACTOR, ['acc_1', 'acc_2']],
  )
  // 批量响应里也不许出现凭据引用。
  assert.ok(!enabled.text.includes('credentialRef'))

  const disabled = await call(server, '/api/accounts/bulk', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ action: 'disable', ids: ['acc_1'] }),
  })
  assert.equal(disabled.status, 200, disabled.text)
  assert.deepEqual(
    accountAdmin.calls.find((entry) => entry.method === 'bulkDisable')?.args,
    [API_ACTOR, ['acc_1']],
  )

  const patched = await call(server, '/api/accounts/bulk', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ action: 'update', ids: ['acc_1'], patch: { priority: 42, protocol: null } }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.deepEqual(
    accountAdmin.calls.find((entry) => entry.method === 'bulkUpdate')?.args,
    [API_ACTOR, ['acc_1'], { priority: 42, protocol: null }],
  )

  // enabled 混进 patch：服务端直接拒（启停是独立通道，由 action 表达）。
  const withEnabled = await call(server, '/api/accounts/bulk', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ action: 'update', ids: ['acc_1'], patch: { enabled: false } }),
  })
  assert.equal(withEnabled.status, 400, withEnabled.text)

  // 空 ids / 未知 action / 未知字段都是 400，不会静默成功。
  for (const body of [
    { action: 'enable', ids: [] },
    { action: 'detonate', ids: ['acc_1'] },
    { action: 'update', ids: ['acc_1'], patch: { nickname: 'x' } },
  ]) {
    const bad = await call(server, '/api/accounts/bulk', {
      method: 'POST',
      cookie,
      body: JSON.stringify(body),
    })
    assert.equal(bad.status, 400, `${JSON.stringify(body)} → ${bad.text}`)
  }

  // 普通用户一律 403（这条路要管理员权限）。
  const member = await login(server, 'alice@example.com', 'password2')
  const denied = await call(server, '/api/accounts/bulk', {
    method: 'POST',
    cookie: member.cookie,
    body: JSON.stringify({ action: 'enable', ids: ['acc_1'] }),
  })
  assert.equal(denied.status, 403)
})
