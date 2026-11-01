/**
 * 连通性测试**贴客户端指纹头**的用例。
 *
 * 这块的教训：客户端档案原先只在 Go 的 `modules/transport` 里生效，管理台的
 * 「测试连通性」是 TS 自己发的裸请求 → opencode 那条账号永远 400，而档案明明配好了。
 *
 * ## 两类断言，缺一不可
 *
 * 1. **固定向量**：`8defb1d7…` / `ccfd15ab…` / `c90407fb…` 这三个值是 `性能` 在 Go 侧用
 *    两条独立实现（PowerShell .NET / Node crypto）算出来再写死进 `clientmask_test.go` 的，
 *    这里**照抄同一个字符串**。两边各写一份算法，只有同一个向量能锁住漂移。
 * 2. **假上游亲眼看到头**：只测纯函数证明不了「头到底贴没贴」—— 必须让 fetch 那一层
 *    真的收到 `x-opencode-session`。
 *
 * 另外钉住「伪装是增强不是前置依赖」：档案缺席 / 被禁用 / 没挂档案时，
 * 请求里**一个额外的头都不许多**，测试也不能因此失败。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  applyAccountMask,
  firstUserText,
  PROTECTED_REQUEST_HEADERS,
  sessionIDFor,
} from '../src/client-mask-apply.ts'

import { boot, createAccount, headersOf, injectFetch, jsonResponse } from './helpers/account-world.ts'

// ───────────────────────────── 固定向量（与 Go 侧同一组） ─────────────────────────────

/** 与 Go `clientmask_test.go` 里写死的期望值逐字相同（性能用两个独立实现交叉验算过）。 */
const VECTOR_HI = '8defb1d7ad2e28e789863e433266cf9c'
const VECTOR_EMPTY = 'ccfd15abe421f177d596bfc2200c34c1'
const VECTOR_OTHER_ACCOUNT = 'c90407fb1f5748150ad635737ee8c022'

/** responses 形状的请求体（首条 user 消息是 `Hi`）。 */
function responsesBody(text: string): string {
  return JSON.stringify({
    model: 'gpt-5',
    input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
    max_output_tokens: 32,
  })
}

test('固定向量：三组期望值与 Go 侧同一串（漂移会两边同时红）', () => {
  assert.equal(sessionIDFor('acc-test', responsesBody('Hi')), VECTOR_HI)
  // 取不到用户文本 → 按空串算，仍然是稳定值（不是随机、也不是按整份体哈希）。
  assert.equal(sessionIDFor('acc-test', undefined), VECTOR_EMPTY)
  assert.equal(sessionIDFor('acc-test', ''), VECTOR_EMPTY)
  assert.equal(sessionIDFor('acc-test', 'not json'), VECTOR_EMPTY)
  assert.equal(
    sessionIDFor('acc-test', JSON.stringify({ messages: [{ role: 'assistant', content: 'Hi' }] })),
    VECTOR_EMPTY,
  )
  // 账号不同 → 值不同（亲和是按账号的）。
  assert.equal(sessionIDFor('acc-other', responsesBody('Hi')), VECTOR_OTHER_ACCOUNT)
})

test('取文本口径：四个协议形状取到同一句 → 同一个 session', () => {
  const shapes = [
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'Hi' }] }),
    JSON.stringify({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] }),
    JSON.stringify({ model: 'm', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }] }),
    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] }),
  ]
  for (const body of shapes) {
    assert.equal(firstUserText(body), 'Hi', `取不到 ${body} 的首条用户文本`)
    assert.equal(sessionIDFor('acc-test', body), VECTOR_HI, `${body} 的 session 与 Go 不一致`)
  }
})

test('取文本口径：role 大小写不敏感、先 trim；human 也算用户', () => {
  for (const role of ['user', 'USER', ' User ', 'human', 'HUMAN ']) {
    const body = JSON.stringify({ messages: [{ role, content: 'Hi' }] })
    assert.equal(firstUserText(body), 'Hi', `role=${role} 没被认成用户`)
    assert.equal(sessionIDFor('acc-test', body), VECTOR_HI)
  }
  // 首条 user 之前有 system / assistant：跳过它们，取第一条 user。
  const withSystem = JSON.stringify({
    input: [
      { role: 'system', content: 'you are a bot' },
      { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'second' }] },
    ],
  })
  assert.equal(firstUserText(withSystem), 'Hi')
  assert.equal(sessionIDFor('acc-test', withSystem), VECTOR_HI)
})

test('亲和语义：首条 user 相同、后面越长 → session 不变', () => {
  const short = JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] })
  const long = JSON.stringify({
    messages: [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'and another question' },
    ],
  })
  assert.equal(sessionIDFor('acc-test', long), sessionIDFor('acc-test', short))
  assert.equal(sessionIDFor('acc-test', long), VECTOR_HI)
})

// ───────────────────────────── 贴头规则 ─────────────────────────────

test('贴头：模板展开、UA 覆盖、受保护头一个都不许被顶掉', () => {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: 'Bearer real-token',
  }
  applyAccountMask(
    headers,
    {
      userAgent: 'opencode-cli/1.2.3',
      headers: [
        { name: 'x-opencode-session', value: '{{session}}' },
        { name: 'x-opencode-client', value: 'cli' },
        { name: 'x-request-at', value: '{{timestamp}}' },
        { name: 'x-trace', value: 'trace-{{uuid}}' },
        // 这三个就算档案里写了也不许生效（服务端装载时就该拦，这里再挡一次）。
        { name: 'Authorization', value: 'Bearer forged' },
        { name: 'Accept', value: 'text/html' },
        { name: 'Content-Type', value: 'text/plain' },
      ],
    },
    {
      accountId: 'acc-test',
      body: responsesBody('Hi'),
      now: () => 1_700_000_000_000,
      uuid: () => '11111111-2222-4333-8444-555555555555',
    },
  )

  assert.equal(headers['x-opencode-session'], VECTOR_HI)
  assert.equal(headers['x-opencode-client'], 'cli')
  assert.equal(headers['x-request-at'], '1700000000000')
  assert.equal(headers['x-trace'], 'trace-11111111-2222-4333-8444-555555555555')
  assert.equal(headers['user-agent'], 'opencode-cli/1.2.3')
  // 受保护头保持原值。
  assert.equal(headers.authorization, 'Bearer real-token')
  assert.equal(headers.accept, 'application/json')
  assert.equal(headers['content-type'], 'application/json')
})

test('贴头：一个档案里多个头引用 {{session}} 必须同值', () => {
  const headers: Record<string, string> = {}
  applyAccountMask(
    headers,
    {
      userAgent: null,
      headers: [
        { name: 'x-session-a', value: '{{session}}' },
        { name: 'x-session-b', value: 'v:{{session}}' },
      ],
    },
    { accountId: 'acc-test', body: responsesBody('Hi') },
  )
  assert.equal(headers['x-session-a'], VECTOR_HI)
  assert.equal(headers['x-session-b'], `v:${VECTOR_HI}`)
})

test('受保护头名单与 contracts 一致（少一个就是绕过口）', () => {
  for (const name of [
    'authorization',
    'x-api-key',
    'x-goog-api-key',
    'content-type',
    'accept',
    'host',
    'user-agent',
    'cookie',
  ]) {
    assert.ok(PROTECTED_REQUEST_HEADERS.includes(name), `${name} 不在受保护名单里`)
  }
})

// ───────────────────────────── 端到端：假上游真的收到了头 ─────────────────────────────

test('连通性测试：挂了 opencode 档案，上游真的收到 x-opencode-session', async (t) => {
  const world = await boot(t, { withClientMask: true })
  const account = await createAccount(
    world,
    {
      provider: 'openai',
      kind: 'api_key',
      label: 'opencode-go',
      baseUrl: 'https://up.example/v1',
      // responses 形状：请求体是 `input[]`，提示词是小写的 `hi`（探针的实际取值）。
      protocol: 'openai-responses',
      models: ['opencode-go'],
      clientProfile: 'opencode',
    },
    { apiKey: '{{SECRET_1abcdefg}}' },
  )
  const calls = injectFetch(world, async () => jsonResponse({ id: 'resp-1' }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)

  const headers = headersOf(calls[0]!.init)
  // 期望值用**独立实现**现算（不是调 sessionIDFor 自证）：算法本身由上面的固定向量锁住。
  const expected = createHash('sha256')
    .update(account.id)
    .update(Buffer.from([0]))
    .update('hi')
    .digest('hex')
    .slice(0, 32)
  assert.equal(headers['x-opencode-session'], expected, '上游没收到会话头（或值与算法不一致）')
  assert.equal(headers['x-opencode-client'], 'cli')

  // 同一段对话再测一次 → 同一个 session（这是 opencode 要的会话亲和）。
  await world.admin.testConnection(account.id)
  assert.equal(headersOf(calls[1]!.init)['x-opencode-session'], expected)
})

test('连通性测试：没挂档案 / 档案服务不在运行时，一个多余的头都不加', async (t) => {
  // 1) 装了 client-mask，但账号没挂档案。
  const withPlugin = await boot(t, { withClientMask: true })
  const plain = await createAccount(
    withPlugin,
    { provider: 'openai', kind: 'api_key', label: 'plain', baseUrl: 'https://up.example/v1', protocol: 'openai-chat', models: ['gpt-5'] },
    { apiKey: '{{SECRET_2abcdefg}}' },
  )
  const calls = injectFetch(withPlugin, async () => jsonResponse({ ok: true }))
  await withPlugin.admin.testConnection(plain.id)
  const plainHeaders = headersOf(calls[0]!.init)
  for (const name of ['x-opencode-session', 'x-opencode-client']) {
    assert.equal(Object.hasOwn(plainHeaders, name), false, `没挂档案却带了 ${name}`)
  }

  // 2) 根本没装 client-mask（插件被禁用）：账号管理照旧可用。
  const withoutPlugin = await boot(t)
  const orphan = await createAccount(
    withoutPlugin,
    { provider: 'openai', kind: 'api_key', label: 'orphan', baseUrl: 'https://up.example/v1', protocol: 'openai-chat', models: ['gpt-5'] },
    { apiKey: '{{SECRET_3abcdefg}}' },
  )
  const orphanCalls = injectFetch(withoutPlugin, async () => jsonResponse({ ok: true }))
  const result = await withoutPlugin.admin.testConnection(orphan.id)
  assert.equal(result.ok, true, '没有客户端档案服务时测试必须照旧成功（伪装是增强，不是前置依赖）')
  assert.deepEqual(Object.keys(headersOf(orphanCalls[0]!.init)).sort(), ['accept', 'authorization', 'content-type'])
})
