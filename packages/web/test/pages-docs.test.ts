/**
 * API 文档页（`/console/api-docs`）的测试。
 *
 * 除了「页面能渲染、内容都转义」，这个文件还守一条纪律：
 * **文档里的每个错误码都必须在源码里真实存在**——owner 明确要求错误码表「以代码里
 * 实际存在的为准，不许凭记忆写」。所以这里直接读源码文件核对（不是对着文档自证）。
 *
 * 入口路径同理：`internal/httpapi/server.go` 里注册了哪些 LLM 入口，文档就必须覆盖哪些。
 *
 * **2026-10-29 改造**：内容源从 `src/content/api_docs.ts`（硬编码 TS 常量）搬到了
 * `docs/api/*.md`（真 markdown 文件）。断言强度**一条都没降**——只是断言对象从
 * 「TS 常量」换成了「从 `.md` 源解析出来的事实」（`parseApiDocsFacts()`）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { apiDocsPage } from '../src/pages/api_docs.ts'
import {
  apiDocsMarkdown,
  apiDocsResource,
  DOC_FILES,
  DOCS_DIR,
  parseApiDocsFacts,
  renderLlmsTxt,
  renderMarkdown,
} from '../src/content/api_docs.ts'
import type { PageContext } from '../src/layout.ts'
import type { SessionView, WebRuntime } from '../src/runtime.ts'

/** 仓库根目录：本文件在 `packages/web/test/` 下。 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function readSource(relative: string): string {
  return readFileSync(`${ROOT}${relative}`, 'utf8')
}

/** 从 `.md` 源解析出来的事实（自证对象）。 */
const FACTS = parseApiDocsFacts()

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
  audit: undefined,
  observability: undefined,
  contentAudit: undefined,
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

// ───────────────────────── 内容源：真 markdown 文件 ─────────────────────────

test('内容源：文档内容真的在 docs/api/*.md 里，且清单不漏文件', () => {
  const onDisk = readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
  assert.deepEqual([...DOC_FILES].sort(), onDisk, 'docs/api 下的 .md 文件与 DOC_FILES 清单必须一一对应')
  assert.ok(DOC_FILES.length >= 3, '文档至少拆成几个文件（概览 / 入口 / 错误码 / 示例）')

  for (const name of DOC_FILES) {
    const text = readFileSync(new URL(name, DOCS_DIR), 'utf8')
    assert.ok(text.trim().length > 100, `${name} 内容太少，像是没搬过来`)
    // 内容必须真的是 markdown（有标题），不是把 TS 常量塞进 .md 字符串。
    assert.match(text, /^#{1,3} /m, `${name} 必须是 markdown（至少有一个标题）`)
  }

  // `apiDocsMarkdown()` 是这些文件按清单顺序拼起来的：文件名清单不是装饰，真的被读了。
  const markdown = apiDocsMarkdown()
  for (const name of DOC_FILES) {
    const firstLine = readFileSync(new URL(name, DOCS_DIR), 'utf8').split('\n')[0]
    assert.ok(markdown.includes(firstLine), `${name} 的首行没出现在整页 markdown 里（顺序或读取逻辑坏了）`)
  }
  assert.ok(markdown.length > 8000, '整页 markdown 太短，可能只读到一部分文件')
})

test('内容源：markdown 里的 HTML 不会被渲染成真标签（markdown-it html:false 防 XSS）', () => {
  const html = renderMarkdown('# t\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n')
  assert.ok(!html.includes('<script>alert(1)</script>'), '内嵌 HTML 必须被当纯文本转义')
  assert.ok(!html.includes('<img src=x'), '内嵌 HTML 必须被当纯文本转义')
  assert.match(html, /&lt;script&gt;/)
})

test('内容源：渲染结果里没有内联 style（CSP 是 style-src self，内联样式会被静默丢弃）', async () => {
  const html = await renderDocs()
  const body = html.slice(html.indexOf('<body>'))
  assert.ok(!body.includes(' style="'), '文档渲染不得写内联样式（会被 CSP 丢弃）')
  assert.ok(!body.includes(" style='"))
})

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
  const documented = [...FACTS.gatewayErrors, ...FACTS.productErrors]
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

test('错误码：出处文件真的存在（文档指到哪，代码就在哪）', () => {
  for (const item of [...FACTS.gatewayErrors, ...FACTS.productErrors]) {
    // `source` 必须是仓库里真实存在的源码路径，否则出处就是编的。
    const text = readSource(item.source)
    assert.ok(text.length > 0, `${item.code} 的出处 ${item.source} 读不到`)
    assert.ok(
      text.includes(item.code) || item.source.startsWith('contracts/') || item.source.startsWith('internal/'),
      `${item.code} 的出处 ${item.source} 里找不到该码`,
    )
  }
})

test('入口路径：文档覆盖 Go 侧注册的全部 LLM 入口', () => {
  const serverSource = readSource('internal/httpapi/server.go')
  const registered = [...serverSource.matchAll(/mux\.HandleFunc\("([^"]+)"/g)].map((match) => match[1])
  assert.ok(registered.length >= 5, `Go 侧入口没解析出来：${registered.join(', ')}`)

  const documented = new Set(FACTS.entries.map((entry) => entry.path))

  // 精确路径：文档必须原样列出。
  let exact = 0
  for (const path of registered) {
    if (path.endsWith('/')) continue
    exact += 1
    assert.ok(documented.has(path), `文档漏了入口 ${path}`)
  }
  assert.ok(exact >= 5, `精确路径解析数量不对：${registered.join(', ')}`)

  // 前缀路由：`/v1beta/models/` 是**前缀**注册，具体方法名在路径后缀里
  // （Gemini 官方的 `:generateContent` / `:streamGenerateContent`）。
  // 这里从 gemini.go 里读出两个方法名，要求文档把它们**都**列出来。
  const prefixes = registered.filter((path) => path.endsWith('/'))
  assert.deepEqual(prefixes, ['/v1beta/models/'], '前缀路由清单变了，文档要同步')
  const geminiSource = readSource('internal/httpapi/gemini.go')
  const methods = [
    ...geminiSource.matchAll(/geminiMethod(?:Stream)?GenerateContent\s*=\s*"([A-Za-z]+)"/g),
  ].map((match) => match[1])
  assert.deepEqual(methods.sort(), ['generateContent', 'streamGenerateContent'])
  for (const prefix of prefixes) {
    for (const method of methods) {
      const concrete = `${prefix}{model}:${method}`
      assert.ok(documented.has(concrete), `文档漏了 ${concrete}`)
    }
  }

  // 每条入口都要有方法、协议标签、请求与响应要点。
  for (const entry of FACTS.entries) {
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
  for (const entry of FACTS.entries) {
    if (entry.protocol === '') continue
    assert.ok(
      protocols.includes(entry.protocol),
      `文档里的协议 ${entry.protocol} 不在 contracts 的协议常量里（${protocols.join(' / ')}）`,
    )
  }
})

test('流式终止符：文档与 codec 源码一致（[DONE] / response.completed / message_stop / 无终止哨兵）', () => {
  const chatStream = readSource('modules/protoconv/codec_chat_stream.go')
  const responsesStream = readSource('modules/protoconv/codec_responses_stream.go')
  const anthropicStream = readSource('modules/protoconv/codec_anthropic_stream.go')
  const geminiStream = readSource('modules/protoconv/codec_gemini_stream.go')

  const byProtocol = new Map(FACTS.streamNotes.map((note) => [note.protocol, note.note]))
  assert.ok(chatStream.includes('[DONE]'), 'chat codec 应发 [DONE]')
  assert.match(byProtocol.get('openai-chat') ?? '', /\[DONE\]/)

  assert.ok(responsesStream.includes('response.completed'), 'responses codec 应发 response.completed')
  assert.match(byProtocol.get('openai-responses') ?? '', /response\.completed/)

  assert.ok(anthropicStream.includes('message_stop'), 'anthropic codec 应发 message_stop')
  assert.match(byProtocol.get('anthropic') ?? '', /message_stop/)

  // Gemini：编码器不发 [DONE]（源码里没有这个哨兵），靠 finishReason 收尾。
  assert.ok(!geminiStream.includes('[DONE]'), 'gemini 流式不该发 [DONE]')
  const geminiNote = byProtocol.get('gemini') ?? ''
  assert.match(geminiNote, /\[DONE\]/, '文档要明说「不发 [DONE]」')
  assert.match(geminiNote, /alt=sse/, 'Gemini 流式必须带 alt=sse')
  assert.match(geminiNote, /finishReason/, '文档要说明靠 finishReason 收尾')
})

test('错误体形状：文档里的每个键都在 contracts/protocol.go 的 RenderError 里出现', () => {
  const protocolSource = readSource('contracts/protocol.go')
  for (const shape of FACTS.errorShapes) {
    assert.ok(shape.protocols.length > 0, '错误体形状必须写明适用协议')
    assert.ok(shape.note.length > 0, '错误体形状必须有说明')
    for (const key of shape.keys) {
      assert.ok(
        protocolSource.includes(`"${key}"`),
        `文档说错误体里有 ${key}，但 RenderError 里找不到`,
      )
      assert.ok(shape.shape.includes(key), `形状串里漏了键 ${key}`)
    }
  }

  // Gemini 的 code 是**整数** HTTP 状态、status 是 Google 枚举名——这两条不能写反。
  const geminiShape = FACTS.errorShapes.find((shape) => shape.protocols.includes('gemini'))
  assert.ok(geminiShape !== undefined)
  assert.match(geminiShape.note, /整数/)
  assert.match(geminiShape.note, /reason/, '网关稳定码要写明放在 reason 里')
  const statusSource = protocolSource.slice(protocolSource.indexOf('func geminiErrorStatus'))
  for (const status of ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL']) {
    assert.ok(statusSource.includes(status), `geminiErrorStatus 里没有 ${status}`)
    assert.ok(geminiShape.note.includes(status), `文档漏了 Gemini 枚举名 ${status}`)
  }
})

test('示例：curl 覆盖四种客户端协议（含 Gemini 两种方法）与 /v1/models，且都用 Bearer 认证', () => {
  const joined = FACTS.curlExamples.map((example) => example.command).join('\n')
  for (const path of [
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/models',
    '/v1beta/models/gemini-2.0-flash:generateContent',
    '/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
  ]) {
    assert.ok(joined.includes(path), `示例里缺 ${path}`)
  }
  assert.ok(joined.includes('Authorization: Bearer'), '示例必须展示认证头')
  // 上游的 x-goog-api-key 是内部事，不能出现在对外文档里。
  assert.ok(!joined.includes('x-goog-api-key'), '示例不该出现上游鉴权头')
  for (const example of FACTS.curlExamples) assert.ok(example.title.length > 0)
  assert.ok(FACTS.lossyNotes.length >= 3, '有损面至少列三条')
})

// ───────────────────────── 机器友好副本（三件套） ─────────────────────────

test('/console/api-docs.md：返回纯 markdown（不是 HTML、不是 JSON）', () => {
  const resource = apiDocsResource('/console/api-docs.md')
  assert.ok(resource !== null, '这条路由必须存在')
  assert.equal(resource.status, 200)
  assert.match(resource.contentType, /^text\/markdown;/)
  const body = resource.body
  // 纯 markdown：有标题、有表格分隔行、没有被包成 HTML 文档。
  assert.match(body, /^# DizzyAPI API 文档/)
  assert.match(body, /^\| --- \|/m, 'markdown 表格的分隔行要在（说明表格没被渲染成 HTML）')
  assert.ok(!body.includes('<!doctype html>'), '不得返回 HTML 文档')
  assert.ok(!body.includes('<div class="panel">'), '不得返回渲染后的 HTML')
  // 整页内容都在：入口、错误码、示例。
  assert.ok(body.includes('/v1/chat/completions'))
  assert.ok(body.includes('INSUFFICIENT_BALANCE'))
  assert.ok(body.includes('Authorization: Bearer'))
  // agent 直接抓：末尾必须有换行。
  assert.ok(body.endsWith('\n'))
})

test('/llms.txt：返回站点索引，指向 .md 副本与关键页面', () => {
  const resource = apiDocsResource('/llms.txt')
  assert.ok(resource !== null, '这条路由必须存在')
  assert.equal(resource.status, 200)
  assert.match(resource.contentType, /^text\/plain;/)
  const body = renderLlmsTxt()
  assert.match(body, /^# DizzyAPI/, 'llms.txt 第一行是一级标题')
  assert.match(body, /^> /m, 'llms.txt 要有一句话摘要（引用块）')
  assert.ok(body.includes('/console/api-docs.md'), 'llms.txt 必须指向干净 markdown')
  assert.ok(body.includes('/console/api-docs'), 'llms.txt 要指向 HTML 页面')
  assert.ok(body.includes('/console/models'), 'llms.txt 要指向模型广场')
  assert.ok(body.includes('/healthz'))
})

test('未知路径不接管（只认那两条副本路由）', () => {
  assert.equal(apiDocsResource('/'), null)
  assert.equal(apiDocsResource('/console/api-docs'), null)
  assert.equal(apiDocsResource('/llms.txt/x'), null)
  assert.equal(apiDocsResource('/api/docs'), null)
})

// ───────────────────────── 页面渲染 ─────────────────────────

test('文档页：渲染入口、错误码表、流式差异与示例', async () => {
  const html = await renderDocs()

  assert.match(html, /API 文档/)
  for (const entry of FACTS.entries) {
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

test('文档页：表格与代码块用模板已有的 class（不写内联样式）', async () => {
  const html = await renderDocs()
  assert.ok(html.includes('<table class="table">'), 'markdown 表格要映射到 .table（模板样式）')
  assert.ok(html.includes('class="panel"'), '表格外层用 .panel 容器')
  assert.ok(html.includes('<code class="mono">'), '行内代码用 .mono')
  assert.ok(html.includes('<pre class="code mono'), '代码块用 .code .mono')
  assert.ok(html.includes('class="section-title"'), 'markdown 标题映射到 .section-title')
})

test('文档页：有「复制整页 Markdown」按钮，复制的是那份 markdown', async () => {
  const html = await renderDocs()
  assert.ok(html.includes('复制整页 Markdown'), '页面要有复制整页的按钮')
  const match = /data-copy="([^"]*)"/.exec(html)
  assert.ok(match !== null, '复制按钮必须用 data-copy（页面脚本已支持）')
  const copied = match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
  assert.match(copied, /^# DizzyAPI API 文档/, '复制出来的必须是整页 markdown')
  assert.ok(copied.includes('INSUFFICIENT_BALANCE'), '复制内容要含错误码表')
  assert.ok(!copied.includes('<div class="panel">'), '复制内容不许是渲染后的 HTML')
})

test('文档页：HTML 里有 rel=alternate(text/markdown) 与 rel=describedby', async () => {
  const html = await renderDocs()
  assert.match(
    html,
    /<link rel="alternate" type="text\/markdown" href="\/console\/api-docs\.md"/,
    '要给 agent 留「纯 markdown 副本在哪」的链接',
  )
  assert.match(html, /<link rel="describedby" type="text\/plain" href="\/llms\.txt"/, '要指到 llms.txt')
  // 链接必须在 <head> 里（不是正文里）。
  const head = html.slice(0, html.indexOf('</head>'))
  assert.ok(head.includes('rel="alternate"'))
  assert.ok(head.includes('rel="describedby"'))
})

test('文档页：base 查询参数只影响示例里的域名，且非法值回落到默认（不注入）', async () => {
  const html = await renderDocs('base=https%3A%2F%2Fexample.com')
  assert.ok(html.includes('https://example.com/v1/chat/completions'))

  // 恶意 base 里有引号 / 尖括号：sanitizeBase 直接回落到默认域名，一个字符都不进页面。
  const evilBase = 'https://x.test/"><script>alert(1)</script>'
  const evil = await renderDocs(`base=${encodeURIComponent(evilBase)}`)
  assert.ok(!evil.includes('<script>alert(1)</script>'), 'base 不得被原样注入')
  assert.ok(!evil.includes('x.test'), '非法 base 必须回落到默认域名')
  assert.ok(evil.includes('/v1/chat/completions'))
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
