/**
 * 连通性测试的**详情块**（`request` / `response`）单测。
 *
 * 这一块是 owner 2026-11-01 提的：「测试要能看探测用的提示词和上游返回的详情」。
 * 它同时是**最容易漏秘密的一屏**，所以四条口径逐字钉住：
 * 1. `request` 是**真的发出去的东西**（提示词与请求体逐字相等，端点去掉 query）；
 * 2. 200 时 `response.bodySnippet` 有正文，非 200 时是上游的错误正文；
 * 3. 超过 2000 字符要截断并标 `truncated`；
 * 4. **响应里不出现凭据**：本次 token 与疑似密钥形状一律打码；
 * 5. 详情**不持久化**（账号记录里没有这两块）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bodyOf, boot, createAccount, injectFetch } from './helpers/account-world.ts'

const TEST_KEY = 'sk-upstream-abcdefghijklmnop'

test('详情：200 时给出提示词 / 端点 / 正文，且提示词与请求体逐字一致', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'detail-ok',
      baseUrl: 'https://up.example/v1',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  const calls = injectFetch(world, async () =>
    new Response(JSON.stringify({ id: 'chatcmpl-1', choices: [{ message: { content: 'Hi there!' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)

  // 请求块：提示词就是请求体里那一条，端点不带 query。
  assert.ok(result.request !== undefined, '必须带 request 块')
  const sent = bodyOf(calls[0]!.init) as { messages: { content: string }[] }
  assert.equal(result.request.prompt, sent.messages[0]!.content)
  assert.equal(result.request.prompt, 'hi')
  assert.equal(result.request.model, 'gpt-5')
  assert.equal(result.request.protocol, 'openai-chat')
  assert.equal(result.request.endpoint, 'https://up.example/v1/chat/completions')

  // 响应块：正文原样（200 正常返回就该看到上游到底回了什么）。
  assert.ok(result.response !== undefined)
  assert.equal(result.response?.status, 200)
  assert.equal(result.response?.truncated, false)
  assert.ok(result.response?.bodySnippet.includes('Hi there!'))
})

test('详情：非 200 时 bodySnippet 装上游错误正文，error 给摘要', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'detail-429',
      baseUrl: 'https://up.example/v1',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  injectFetch(world, async () =>
    new Response(JSON.stringify({ error: { message: 'quota exhausted', type: 'rate_limit' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }),
  )

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, false)
  assert.equal(result.status, 429)
  assert.equal(result.response?.status, 429)
  assert.ok(result.response?.bodySnippet.includes('quota exhausted'))
  assert.ok(result.error?.startsWith('HTTP 429'))
})

test('详情：超过 2000 字符要截断并标 truncated', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'detail-long',
      baseUrl: 'https://up.example/v1',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  // 不能拿连续 40+ 个同字符当填充：那会被「长 base64」形状规则打码，长度就变了。
  const longText = 'lorem ipsum '.repeat(500)
  injectFetch(world, async () => new Response(JSON.stringify({ echo: longText }), { status: 200 }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.response?.truncated, true)
  assert.equal(result.response?.bodySnippet.length, 2000)
})

test('详情：响应里不出现凭据（本次 token 打码、疑似 key 形状打码）', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'detail-secret',
      baseUrl: 'https://up.example/v1',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  injectFetch(world, async () =>
    new Response(
      JSON.stringify({
        error: `invalid key ${TEST_KEY} (header Bearer ${TEST_KEY})`,
        another: 'sk-other-key-1234567890',
        blob: 'A'.repeat(48),
      }),
      { status: 401 },
    ),
  )

  const result = await world.admin.testConnection(account.id)
  const snippet = result.response?.bodySnippet ?? ''
  assert.equal(snippet.includes(TEST_KEY), false, '本次 token 不许出现在片段里')
  assert.equal(snippet.includes('sk-other-key'), false, '疑似 key 形状要打码')
  assert.equal(snippet.includes('A'.repeat(48)), false, '长 base64 要打码')
  assert.ok(snippet.includes('[REDACTED]'))
  // 摘要（error）也不许带 token。
  assert.equal(result.error?.includes(TEST_KEY), false)
})

test('详情：网络错误时 response 为 null，request 仍然给（便于排查打到了哪）', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'detail-net',
      baseUrl: 'https://up.example/v1',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  injectFetch(world, async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })
  })

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, false)
  assert.equal(result.status, null)
  assert.equal(result.response, null)
  assert.equal(result.request?.endpoint, 'https://up.example/v1/chat/completions')
})

test('详情：端点去掉 query（有的上游把 key 放在查询串里）', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'custom',
      kind: 'api_key',
      label: 'detail-query',
      baseUrl: 'https://up.example/v1/?api_key={{SECRET_qwertyui}}',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  injectFetch(world, async () => new Response('{}', { status: 200 }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.request?.endpoint.includes('?'), false, '端点不许带 query')
  assert.equal(result.request?.endpoint.includes('api_key'), false)
})

test('详情不持久化：账号记录里只有 lastTest*，没有 request / response', async (t) => {
  const world = await boot(t)
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'detail-persist',
      baseUrl: 'https://up.example/v1',
      protocol: 'openai-chat',
      models: ['gpt-5'],
    },
    { apiKey: TEST_KEY },
  )
  injectFetch(world, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))

  const result = await world.admin.testConnection(account.id)
  assert.ok(result.response !== undefined, '本次响应里必须有片段')

  const stored = world.identity.get(account.id) as unknown as Record<string, unknown>
  assert.equal(Object.hasOwn(stored, 'request'), false, 'request 不许写进账号记录')
  assert.equal(Object.hasOwn(stored, 'response'), false, 'response 不许写进账号记录')
  assert.equal(JSON.stringify(stored).includes('bodySnippet'), false)
  // 该记的运营元数据照旧记。
  assert.equal(stored.lastTestOk, true)
})
