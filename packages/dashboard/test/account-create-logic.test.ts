/**
 * 新建 / 导入上游账号的纯逻辑单测。
 *
 * 为什么必须被逐字钉住：这一段错了会**建出坏账号**（服务端拒、或者更糟——
 * 静默建出一个 provider 与 kind 不匹配的账号，调度时才炸）。
 * 最容易错的三处：
 * 1. `custom` 只能配 `api_key`（服务端的 `assertProviderKind`）；
 * 2. 模型映射的**格式不对要报错**，不能静默跳过；
 * 3. 凭据是可选的，且**只走 body**。
 *
 * 逻辑抽在 `.ts`（不 import React），所以能在没有 React 的仓库根测试环境里 import。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as logicModule from '../app/src/app/(main)/dashboard/_components/account-create-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const {
  accountCreateBodyOf,
  accountDraftError,
  credentialFormatLabel,
  emptyAccountDraft,
  isProviderKindValid,
  kindLabel,
  parseBaseUrl,
  parseModelList,
  parseModelMap,
  parsePriority,
  protocolLabel,
  providerLabel,
  providersForKind,
} = unwrap<typeof logicModule>(logicModule)

// ───────────────────────────── provider × kind 的组合约束 ─────────────────────────────

test('isProviderKindValid：custom 只能配 api_key（与服务端 assertProviderKind 逐字对齐）', () => {
  assert.equal(isProviderKindValid('custom', 'api_key'), true)
  assert.equal(isProviderKindValid('custom', 'oauth'), false)
  assert.equal(isProviderKindValid('claude', 'oauth'), true)
  assert.equal(isProviderKindValid('claude', 'api_key'), true)
  assert.equal(isProviderKindValid('openai', 'oauth'), true)
  assert.equal(isProviderKindValid('openai', 'api_key'), true)
})

test('providersForKind：oauth 时不给出 custom', () => {
  assert.deepEqual(providersForKind('oauth'), ['claude', 'openai'])
  assert.deepEqual(providersForKind('api_key'), ['claude', 'openai', 'custom'])
})

test('非法组合不构造出 body（不发请求，服务端会拒）', () => {
  const draft = { ...emptyAccountDraft(), kind: 'oauth' as const, provider: 'custom' as const, label: 'x' }
  assert.equal(accountCreateBodyOf(draft), 'invalid')
  assert.equal(accountDraftError(draft), '自定义上游只能用于 API Key 账号')
})

// ───────────────────────────── 必填与长度 ─────────────────────────────

test('label 必填、≤ 200 字符', () => {
  assert.equal(accountCreateBodyOf({ ...emptyAccountDraft(), label: '   ' }), 'invalid')
  assert.equal(accountCreateBodyOf({ ...emptyAccountDraft(), label: 'x'.repeat(201) }), 'invalid')
  const ok = accountCreateBodyOf({ ...emptyAccountDraft(), label: 'x'.repeat(200) })
  assert.ok(ok !== 'invalid')
  assert.equal((ok as { label: string }).label.length, 200)
})

test('label 会 trim', () => {
  const body = accountCreateBodyOf({ ...emptyAccountDraft(), label: '  主力号  ' })
  assert.ok(body !== 'invalid')
  assert.equal((body as { label: string }).label, '主力号')
})

// ───────────────────────────── 优先级 ─────────────────────────────

test('parsePriority：0..1000 的整数，空串当 0，非法给 invalid', () => {
  assert.equal(parsePriority(''), 0)
  assert.equal(parsePriority('0'), 0)
  assert.equal(parsePriority('1000'), 1000)
  assert.equal(parsePriority(' 5 '), 5)
  for (const bad of ['-1', '1001', '1.5', 'abc', '1e3']) {
    assert.equal(parsePriority(bad), 'invalid', `期望「${bad}」被判非法`)
  }
})

// ───────────────────────────── Base URL ─────────────────────────────

test('parseBaseUrl：空串 = 不填；必须是 http(s)', () => {
  assert.equal(parseBaseUrl(''), '')
  assert.equal(parseBaseUrl('  '), '')
  assert.equal(parseBaseUrl('https://api.example.com/v1'), 'https://api.example.com/v1')
  assert.equal(parseBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(parseBaseUrl('ftp://x.example'), 'invalid')
  assert.equal(parseBaseUrl('not a url'), 'invalid')
})

// ───────────────────────────── 模型名与模型映射 ─────────────────────────────

test('parseModelList：按换行或逗号切分，空项忽略', () => {
  assert.deepEqual(parseModelList('a\nb'), ['a', 'b'])
  assert.deepEqual(parseModelList('a, b'), ['a', 'b'])
  assert.deepEqual(parseModelList('a\n\n  \nb'), ['a', 'b'])
  assert.deepEqual(parseModelList(''), [])
})

test('parseModelMap：接受 = : 与空格分隔；格式不对要报错而不是静默跳过', () => {
  assert.deepEqual(parseModelMap('a=b'), { a: 'b' })
  assert.deepEqual(parseModelMap('a: b'), { a: 'b' })
  assert.deepEqual(parseModelMap('a b'), { a: 'b' })
  assert.deepEqual(parseModelMap('a=b\nc=d'), { a: 'b', c: 'd' })
  assert.deepEqual(parseModelMap(''), {})
  assert.equal(parseModelMap('a='), 'invalid')
  assert.equal(parseModelMap('=b'), 'invalid')
  assert.equal(parseModelMap('a'), 'invalid')
})

// ───────────────────────────── body 的形状 ─────────────────────────────

test('空的可选项不带这个键（服务端把 undefined 当「没给」）', () => {
  const body = accountCreateBodyOf({ ...emptyAccountDraft(), label: '账号' })
  assert.ok(body !== 'invalid')
  const record = body as unknown as Record<string, unknown>
  assert.equal('email' in record, false)
  assert.equal('subject' in record, false)
  assert.equal('baseUrl' in record, false)
  assert.equal('protocol' in record, false)
  assert.equal('models' in record, false)
  assert.equal('modelMap' in record, false)
  assert.equal('credential' in record, false)
  assert.equal(record.priority, 0)
  assert.equal(record.enabled, true)
})

test('填了就有；凭据只走 body', () => {
  const body = accountCreateBodyOf({
    ...emptyAccountDraft(),
    label: '账号',
    email: 'a@example.com',
    baseUrl: 'https://api.example.com',
    protocol: 'anthropic',
    models: 'a\nb',
    modelMap: 'a=x',
    priority: '10',
    credentialFormat: 'api-key',
    credentialPayload: 'sk-secret',
  })
  assert.ok(body !== 'invalid')
  assert.equal(body.email, 'a@example.com')
  assert.equal(body.baseUrl, 'https://api.example.com')
  assert.equal(body.protocol, 'anthropic')
  assert.deepEqual(body.models, ['a', 'b'])
  assert.deepEqual(body.modelMap, { a: 'x' })
  assert.equal(body.priority, 10)
  assert.deepEqual(body.credential, { format: 'api-key', payload: 'sk-secret' })
})

test('凭据内容留空就不带 credential 这个键（可以先建账号再导入凭据）', () => {
  const body = accountCreateBodyOf({ ...emptyAccountDraft(), label: '账号', credentialPayload: '   ' })
  assert.ok(body !== 'invalid')
  assert.equal('credential' in (body as unknown as Record<string, unknown>), false)
})

// ───────────────────────────── 标签 ─────────────────────────────

test('标签：已知值给中文，未知值不冒充', () => {
  assert.equal(providerLabel('claude'), 'Claude')
  assert.equal(providerLabel('custom'), '自定义上游')
  assert.equal(kindLabel('oauth'), 'OAuth 订阅账号')
  assert.equal(kindLabel('api_key'), 'API Key 账号')
  assert.equal(protocolLabel('openai-chat'), 'OpenAI Chat')
  assert.equal(protocolLabel('gemini'), 'Gemini')
  assert.equal(credentialFormatLabel('auto'), '自动识别')
  assert.equal(credentialFormatLabel('identity-bundle'), 'identity 凭据包')
})
