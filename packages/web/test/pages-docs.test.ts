/**
 * API 文档页（`/console/api-docs`）的测试。
 *
 * 除了「页面能渲染、内容都转义」，这个文件还守一条纪律：
 * **文档里的每个错误码都必须在源码里真实存在**——owner 明确要求错误码表「以代码里
 * 实际存在的为准，不许凭记忆写」。所以这里直接读源码文件核对（不是对着文档自证）。
 *
 * 入口路径同理：`internal/httpapi/server.go` 里注册了哪些 LLM 入口，文档就必须覆盖哪些。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { apiDocsPage } from '../src/pages/api_docs.ts'
import {
  API_ENTRIES,
  CURL_EXAMPLES,
  GATEWAY_ERRORS,
  LOSSY_NOTES,
  PRODUCT_ERRORS,
  STREAM_NOTES,
} from '../src/content/api_docs.ts'
import type { PageContext } from '../src/layout.ts'
import type { SessionView, WebRuntime } from '../src/runtime.ts'

/** 仓库根目录：本文件在 `packages/web/test/` 下。 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function readSource(relative: string): string {
  return readFileSync(`${ROOT}${relative}`, 'utf8')
}

const SESSION: SessionView = {
  sessionId: 'session-1',
  userId: 7,
  user: {
    id: 7,
    name: 'alice',
    status: 'enabled',
    role: 'user',
    balance: 2_500_000n,
    balanceEnabled: true,
    avatar: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  expiresAt: '2099-10-19T00:00:00.000Z',
}

const EMPTY_SERVICES: WebRuntime = {
  user: undefined,
  auth: undefined,
  apiKey: undefined,
  usage: undefined,
  pricing: undefined,
  modelhub: undefined,
  settings: undefined,
  catalog: undefined,
  accountAdmin: undefined,
  redeem: undefined,
  billing: undefined,
  topup: undefined,
  fontSmiley: undefined,
}

async function renderDocs(query = ''): Promise<string> {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  const template = ctx.get('pageTemplate') as PageTemplateService
  const pageContext: PageContext = {
    path: '/console/api-docs',
    title: 'API 文档',
    query: new URLSearchParams(query),
    user: SESSION,
    t: template,
    services: EMPTY_SERVICES,
    notice: null,
    takeSecret: () => undefined,
  }
  return apiDocsPage.render(pageContext)
}

// ───────────────────────── 文档内容与源码一致 ─────────────────────────

test('错误码：文档里的每个 code 都在源码里真实存在', () => {
  const sources = [
    // Go 侧：错误码散在 contracts 与各模块里，直接拼起来搜。
    'contracts/contracts.go',
    'contracts/quota.go',
    'internal/engine/engine.go',
    'internal/httpapi/server.go',
    'modules/keyauth/module.go',
    'modules/accountpriority/errors.go',
    'modules/accountpriority/stage.go',
    'modules/modelroute/errors.go',
    'modules/protoconv/errors.go',
    // TS 侧：产品面的稳定码与显式状态码表。
    'packages/api/src/errors.ts',
    'packages/api/src/http.ts',
    'packages/usage/src/errors.ts',
    'packages/topup/src/errors.ts',
    'packages/redeem/src/errors.ts',
    'packages/pricing/src/errors.ts',
    'packages/billing/src/errors.ts',
    'packages/modelhub/src/errors.ts',
  ].map(readSource)

  const haystack = sources.join('\n')
  const documented = [...GATEWAY_ERRORS, ...PRODUCT_ERRORS]
  assert.ok(documented.length > 20, '错误码表不该只有几条')
  for (const item of documented) {
    assert.ok(
      haystack.includes(`'${item.code}'`) || haystack.includes(`"${item.code}"`),
      `文档里的 ${item.code} 在源码里找不到（不许凭记忆写）`,
    )
    assert.ok(item.status >= 400 && item.status <= 599, `${item.code} 的 HTTP 状态码不合法`)
    assert.ok(item.meaning.length > 0, `${item.code} 缺少说明`)
    assert.ok(item.source.length > 0, `${item.code} 缺少出处`)
  }
  // 同一张表里不能出现重复的 code。
  const codes = documented.map((item) => item.code)
  assert.equal(new Set(codes).size, codes.length, '错误码表里有重复项')
})

test('入口路径：文档覆盖 Go 侧注册的全部 LLM 入口', () => {
  const serverSource = readSource('internal/httpapi/server.go')
  const registered = [...serverSource.matchAll(/mux\.HandleFunc\("(\/v1\/[^"]+|\/healthz)"/g)].map(
    (match) => match[1],
  )
  assert.ok(registered.length >= 4, `Go 侧入口没解析出来：${registered.join(', ')}`)

  const documented = new Set(API_ENTRIES.map((entry) => entry.path))
  for (const path of registered) {
    assert.ok(documented.has(path), `文档漏了入口 ${path}`)
  }
  // 每条入口都要有方法、协议标签、请求与响应要点。
  for (const entry of API_ENTRIES) {
    assert.ok(entry.method.length > 0, `${entry.path} 缺 HTTP 方法`)
    assert.ok(entry.protocolLabel.length > 0, `${entry.path} 缺协议名`)
    assert.ok(entry.request.length > 0, `${entry.path} 缺请求要点`)
    assert.ok(entry.response.length > 0, `${entry.path} 缺响应要点`)
  }
})

test('入口协议：文档写的协议名与 contracts 里的常量一致', () => {
  const ir = readSource('contracts/ir.go')
  const protocols = [...ir.matchAll(/Protocol\w+\s+Protocol\s*=\s*"([a-z-]+)"/g)].map((match) => match[1])
  assert.ok(protocols.length >= 3, `协议常量没解析出来：${protocols.join(', ')}`)
  for (const entry of API_ENTRIES) {
    if (entry.protocol === '') continue
    assert.ok(
      protocols.includes(entry.protocol),
      `文档里的协议 ${entry.protocol} 不在 contracts 的协议常量里（${protocols.join(' / ')}）`,
    )
  }
})

test('流式终止符：文档与 codec 源码一致（[DONE] / response.completed / message_stop）', () => {
  const chatStream = readSource('modules/protoconv/codec_chat_stream.go')
  const responsesStream = readSource('modules/protoconv/codec_responses_stream.go')
  const anthropicStream = readSource('modules/protoconv/codec_anthropic_stream.go')

  const byProtocol = new Map(STREAM_NOTES.map((note) => [note.protocol, note.note]))
  assert.ok(chatStream.includes('[DONE]'), 'chat codec 应发 [DONE]')
  assert.match(byProtocol.get('openai-chat') ?? '', /\[DONE\]/)

  assert.ok(responsesStream.includes('response.completed'), 'responses codec 应发 response.completed')
  assert.match(byProtocol.get('openai-responses') ?? '', /response\.completed/)

  assert.ok(anthropicStream.includes('message_stop'), 'anthropic codec 应发 message_stop')
  assert.match(byProtocol.get('anthropic') ?? '', /message_stop/)
})

test('示例：curl 覆盖三种客户端协议与 /v1/models，且都用 Bearer 认证', () => {
  const joined = CURL_EXAMPLES.map((example) => example.command).join('\n')
  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/models']) {
    assert.ok(joined.includes(path), `示例里缺 ${path}`)
  }
  assert.ok(joined.includes('Authorization: Bearer'), '示例必须展示认证头')
  for (const example of CURL_EXAMPLES) assert.ok(example.title.length > 0)
  assert.ok(LOSSY_NOTES.length >= 3, '有损面至少列三条')
})

// ───────────────────────── 页面渲染 ─────────────────────────

test('文档页：渲染入口、错误码表、流式差异与示例', async () => {
  const html = await renderDocs()

  assert.match(html, /API 文档/)
  for (const entry of API_ENTRIES) {
    assert.ok(html.includes(entry.path), `页面缺入口 ${entry.path}`)
  }
  // 关键错误码（用户最常撞到的几个）必须在页面上。
  for (const code of [
    'INSUFFICIENT_BALANCE',
    'ALL_ACCOUNTS_SATURATED',
    'ALL_ACCOUNTS_COOLING',
    'NO_ELIGIBLE_ACCOUNT',
    'PROTOCOL_CODEC_UNAVAILABLE',
    'TOPUP_ORDER_STATE',
    'USAGE_REJECTED_STATE',
    'MISSING_API_KEY',
    'INVALID_API_KEY',
  ]) {
    assert.ok(html.includes(code), `页面缺错误码 ${code}`)
  }
  assert.match(html, /\[DONE\]/)
  assert.match(html, /response\.completed/)
  assert.match(html, /message_stop/)
  assert.match(html, /Authorization: Bearer/)
  assert.ok(!html.includes('undefined'))
})

test('文档页：base 查询参数只影响示例里的域名，且被转义', async () => {
  const html = await renderDocs('base=https%3A%2F%2Fexample.com')
  assert.ok(html.includes('https://example.com/v1/chat/completions'))

  const evil = await renderDocs(`base=${encodeURIComponent('https://x.test/"><script>alert(1)</script>')}`)
  assert.ok(!evil.includes('<script>alert(1)</script>'), 'base 必须被转义')
})

test('页面注册：两个新页面在路由表里，路径唯一', async () => {
  const { PAGES } = await import('../src/pages/index.ts')
  const paths = PAGES.map((page) => page.path)
  assert.equal(new Set(paths).size, paths.length, '路由表里有重复路径')
  assert.ok(paths.includes('/console/models'))
  assert.ok(paths.includes('/console/api-docs'))
  for (const path of ['/console/models', '/console/api-docs']) {
    const page = PAGES.find((item) => item.path === path)
    assert.ok(page !== undefined)
    assert.equal(page.auth, true)
    assert.equal(page.area, 'console')
  }
})
