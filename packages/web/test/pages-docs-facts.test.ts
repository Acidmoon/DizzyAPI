/**
 * API 文档的**派生事实与代码一致性**测试（自证机制的主体）。
 *
 * 守的纪律：
 * - 页面必须真的带上派生出的**每一条**入口与错误码（漏一条 = 装配断了）；
 * - 入口详情小节里的路径必须是真实入口，且每个真实入口都要有详情节（双向）；
 * - 派生出的出处文件真的存在，且文件里真有这个码；
 * - 协议名与 `contracts/ir.go` 一致；错误体键 ⊆ `RenderError`；
 * - 流式终止符与四个 codec 源码一致；示例覆盖四种客户端协议。
 *
 * 同一主题的另外两份：`pages-docs-source.test.ts`（内容源与反模式护栏）、
 * `pages-docs-http.test.ts`（机器友好副本的 HTTP 接线）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FACTS,
  FULL_MARKDOWN,
  NARRATIVE,
  fencedBlocks,
  plain,
  readSource,
  splitSections,
  tableRows,
  type Section,
} from './helpers/docs-fixture.ts'

test('入口表：页面与整页 markdown 都覆盖派生出的全部入口（方法 + 路径 + 协议）', () => {
  assert.ok(FACTS.entries.length >= 5, `派生出的入口太少：${FACTS.entries.length}`)
  for (const entry of FACTS.entries) {
    const row = `| \`${entry.method}\` | \`${entry.path}\` |`
    assert.ok(FULL_MARKDOWN.includes(row), `整页 markdown 缺入口行 ${row}`)
    assert.ok(FULL_MARKDOWN.includes(entry.method), `入口 ${entry.path} 缺方法`)
    if (entry.protocol !== '') {
      assert.ok(
        FULL_MARKDOWN.includes(`\`${entry.protocol}\``),
        `入口 ${entry.path} 的协议名 ${entry.protocol} 没出现在文档里`,
      )
      assert.ok(
        FULL_MARKDOWN.includes(entry.protocolConst),
        `文档要能对回源码常量 ${entry.protocolConst}`,
      )
    }
  }
  // 派生表必须真的被插到「入口一览」小节里，而不是插错位置。
  const endpointSection = splitSections(FULL_MARKDOWN).find((section) => section.heading.includes('入口一览'))
  assert.ok(endpointSection !== undefined, '缺「入口一览」小节')
  for (const entry of FACTS.entries) {
    assert.ok(endpointSection.body.includes(entry.path), `「入口一览」里缺 ${entry.path}`)
  }
})

test('入口详情：每一节的路径都是真实入口，且每个真实入口都有详情节（双向）', () => {
  const detailed = new Map<string, Section>()
  for (const section of splitSections(NARRATIVE)) {
    const match = /^(GET|POST)\s+(\S+)$/.exec(section.heading)
    if (match === null) continue
    detailed.set(`${match[1]} ${match[2]}`, section)
  }
  assert.ok(detailed.size >= 5, `入口详情小节太少：${detailed.size}`)

  const derived = new Set(FACTS.entries.map((entry) => `${entry.method} ${entry.path}`))
  // ① 详情里写的每一条都必须是真实入口（代码删了入口，这一节就是过时的，必须报错）。
  for (const key of detailed.keys()) {
    assert.ok(derived.has(key), `docs/api/*.md 里有「${key}」的详情，但代码里没有这个入口（过时了）`)
  }
  // ② 每个真实入口都必须有详情节。
  for (const entry of FACTS.entries) {
    const key = `${entry.method} ${entry.path}`
    assert.ok(detailed.has(key), `入口 ${key} 缺详情小节`)
  }
  // ③ 每节都要有请求与响应要点。
  for (const [key, section] of detailed) {
    assert.ok(section.body.includes('**请求**'), `${key} 的详情缺「请求」`)
    assert.ok(section.body.includes('**响应**'), `${key} 的详情缺「响应」`)
    // `/healthz` 本身没什么可说，门槛不能设成「一律很长」；只要求不是占位一句话。
    assert.ok(section.body.trim().length > 40, `${key} 的详情太薄`)
  }
})

test('错误码表：页面带上派生的每一条（Go 侧含说明与出处，TS 侧含出处）', () => {
  assert.ok(FACTS.gatewayErrors.length >= 10, `Go 侧派生的错误码太少：${FACTS.gatewayErrors.length}`)
  assert.ok(FACTS.productErrors.length >= 20, `TS 侧派生的错误码太少：${FACTS.productErrors.length}`)

  for (const fact of [...FACTS.gatewayErrors, ...FACTS.productErrors]) {
    assert.ok(fact.code.length > 0, '派生出空错误码')
    assert.ok(fact.status >= 400 && fact.status <= 599, `${fact.code} 的 HTTP 状态码不合法：${fact.status}`)
    assert.ok(fact.source.length > 0, `${fact.code} 缺出处`)
    const row = `| \`${fact.code}\` | ${fact.status} |`
    assert.ok(FULL_MARKDOWN.includes(row), `整页 markdown 缺错误码行 ${row}`)
    assert.ok(FULL_MARKDOWN.includes(fact.source), `${fact.code} 的出处 ${fact.source} 没进文档`)
  }

  // Go 侧的码必须在文档里能看到人话说明（说明直接来自源码字面量）。
  for (const fact of FACTS.gatewayErrors) {
    if (fact.message === '') continue
    assert.ok(
      FULL_MARKDOWN.includes(fact.message),
      `${fact.code} 的说明「${fact.message}」没进文档`,
    )
  }

  // 同一张表里不能出现重复的 code。
  const codes = [...FACTS.gatewayErrors, ...FACTS.productErrors].map((fact) => fact.code)
  assert.equal(new Set(codes).size, codes.length, '派生的错误码里有重复项')
})

test('错误码出处：派生出来的出处文件真的存在，且文件里真有这个码', () => {
  for (const fact of [...FACTS.gatewayErrors, ...FACTS.productErrors]) {
    const text = readSource(fact.source)
    assert.ok(text.length > 0, `${fact.code} 的出处 ${fact.source} 读不到`)
    assert.ok(
      text.includes(fact.code),
      `${fact.code} 的出处 ${fact.source} 里找不到该码（出处是编的）`,
    )
  }
})

test('入口协议：入口表里的协议名与 contracts/ir.go 的常量一致', () => {
  const ir = readSource('contracts/ir.go')
  const protocols = [...ir.matchAll(/Protocol\w+\s+Protocol\s*=\s*"([a-z-]+)"/g)].map((match) => match[1])
  assert.ok(protocols.length >= 3, `协议常量没解析出来：${protocols.join(', ')}`)
  assert.deepEqual(
    FACTS.protocols.map((item) => item.value).sort(),
    [...protocols].sort(),
    '派生的协议清单与 ir.go 里的常量不一致',
  )
  for (const entry of FACTS.entries) {
    if (entry.protocol === '') continue
    assert.ok(
      protocols.includes(entry.protocol),
      `入口 ${entry.path} 的协议 ${entry.protocol} 不在 contracts 的协议常量里（${protocols.join(' / ')}）`,
    )
  }
})

test('流式终止符：文档与 codec 源码一致（[DONE] / response.completed / message_stop / 无哨兵）', () => {
  const chatStream = readSource('modules/protoconv/codec_chat_stream.go')
  const responsesStream = readSource('modules/protoconv/codec_responses_stream.go')
  const anthropicStream = readSource('modules/protoconv/codec_anthropic_stream.go')
  const geminiStream = readSource('modules/protoconv/codec_gemini_stream.go')

  const section = splitSections(NARRATIVE).find((item) => item.heading.includes('流式终止符'))
  assert.ok(section !== undefined, '缺「流式终止符」小节')
  const byProtocol = new Map<string, string>()
  for (const row of tableRows(section.body)) {
    assert.equal(row.length, 2, `流式终止符表应该是两列：${row.join(' | ')}`)
    byProtocol.set(plain(row[0]), row[1])
  }
  assert.equal(byProtocol.size, 4, `流式终止符应该覆盖四个协议，实际 ${byProtocol.size}`)

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
  const section = splitSections(NARRATIVE).find((item) => item.heading.includes('错误体形状'))
  assert.ok(section !== undefined, '缺「错误体形状」小节')

  const shapes = tableRows(section.body).map((row) => ({
    protocols: plain(row[0]).split('/').map((item) => plain(item)),
    shape: row[1],
    keys: row[2].split(',').map((key) => plain(key)),
    note: row[3] ?? '',
  }))
  assert.ok(shapes.length >= 3, `错误体形状应该覆盖默认 / anthropic / gemini，实际 ${shapes.length}`)

  for (const shape of shapes) {
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
  const geminiShape = shapes.find((shape) => shape.protocols.includes('gemini'))
  assert.ok(geminiShape !== undefined, '缺 gemini 的错误体形状')
  assert.match(geminiShape.note, /整数/)
  assert.match(geminiShape.note, /reason/, '网关稳定码要写明放在 reason 里')
  const statusSource = protocolSource.slice(protocolSource.indexOf('func geminiErrorStatus'))
  for (const status of ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'INTERNAL']) {
    assert.ok(statusSource.includes(status), `geminiErrorStatus 里没有 ${status}`)
    assert.ok(geminiShape.note.includes(status), `文档漏了 Gemini 枚举名 ${status}`)
  }
})

test('示例：curl 覆盖四种客户端协议（含 Gemini 两种方法）与 /v1/models，且都用 Bearer 认证', () => {
  const blocks = fencedBlocks(NARRATIVE).filter((block) => block.lang === 'bash')
  assert.ok(blocks.length >= 5, `示例代码块太少：${blocks.length}`)
  for (const block of blocks) assert.match(block.body, /^\s*curl /, '示例块里必须是 curl 命令')

  const joined = blocks.map((block) => block.body).join('\n')
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
  // 每段示例都要带认证头，不能有的带有的不带。
  for (const block of blocks) {
    assert.ok(block.body.includes('Authorization: Bearer'), `这段示例没带认证头：${block.body.slice(0, 60)}`)
  }

  // 有损面至少列三条。
  const lossy = splitSections(NARRATIVE).find((item) => item.heading.includes('有损转换'))
  assert.ok(lossy !== undefined, '缺「有损转换」小节')
  const bullets = lossy.body.split('\n').filter((line) => line.trimStart().startsWith('- '))
  assert.ok(bullets.length >= 3, `有损面至少列三条，实际 ${bullets.length}`)
})
