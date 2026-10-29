/**
 * API 文档的**内容源**测试（叙述文件 + 反模式护栏 + XSS / CSP）。
 *
 * 守的纪律：
 * - 叙述真的在 `docs/api/*.md` 里，清单不漏文件；
 * - **事实清单不许手写进 markdown**（入口表 / 错误码表只能来自 `api_facts.ts` 的代码派生）；
 * - 占位符各出现且只出现一次（装配期也会校验，这里守住源文件）；
 * - `html: false` 防 XSS（内嵌 HTML、`javascript:` 链接）；
 * - 渲染结果里没有内联样式（CSP 是 `style-src 'self'`）。
 *
 * 同一主题的另外两份：`pages-docs-facts.test.ts`（派生事实与代码一致）、
 * `pages-docs-http.test.ts`（机器友好副本的 HTTP 接线）。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DOC_FILES, DOCS_DIR, FACT_PLACEHOLDERS, renderMarkdown } from '../src/content/api_docs.ts'
import { FACTS, FULL_MARKDOWN, NARRATIVE, renderDocs } from './helpers/docs-fixture.ts'

test('内容源：文档叙述真的在 docs/api/*.md 里，且清单不漏文件', () => {
  const onDisk = readdirSync(DOCS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort()
  assert.deepEqual([...DOC_FILES].sort(), onDisk, 'docs/api 下的 .md 文件与 DOC_FILES 清单必须一一对应')
  assert.ok(DOC_FILES.length >= 3, '文档至少拆成几个文件（概览 / 入口 / 错误码 / 示例）')

  for (const name of DOC_FILES) {
    const text = readFileSync(new URL(name, DOCS_DIR), 'utf8')
    assert.ok(text.trim().length > 100, `${name} 内容太少，像是没搬过来`)
    assert.match(text, /^#{1,3} /m, `${name} 必须是 markdown（至少有一个标题）`)
  }

  // 三个占位符必须各出现且只出现一次（装配期也会校验，这里守住源文件）。
  for (const marker of Object.values(FACT_PLACEHOLDERS)) {
    assert.equal(NARRATIVE.split(marker).length - 1, 1, `占位符 ${marker} 应该出现且只出现一次`)
  }
  // 装配之后不该残留任何占位符。
  assert.ok(!FULL_MARKDOWN.includes('facts:'), '整页 markdown 里残留了未展开的占位符')
  assert.ok(FULL_MARKDOWN.length > NARRATIVE.length, '事实表没被插进去（整页比叙述还短）')
})

test('反模式护栏：事实清单不许手写进 markdown（入口表 / 错误码表只能来自代码）', () => {
  const narrativeRows = NARRATIVE.split('\n').filter((line) => line.trimStart().startsWith('|'))

  // ① 入口表行：任何 markdown 表格行里都不许出现派生出来的入口路径。
  for (const entry of FACTS.entries) {
    for (const row of narrativeRows) {
      assert.ok(
        !row.includes(entry.path),
        `docs/api/*.md 里手写了入口表格行「${entry.path}」——入口表必须由 api_facts.ts 派生：${row}`,
      )
    }
  }

  // ② 错误码表行：任何表格行都不许以反引号错误码打头（那是派生表的形状）。
  for (const fact of [...FACTS.gatewayErrors, ...FACTS.productErrors]) {
    const handwritten = new RegExp(`^\\|\\s*\`?${fact.code}\`?\\s*\\|`, 'm')
    assert.ok(
      !handwritten.test(NARRATIVE),
      `docs/api/*.md 里手写了错误码表格行 ${fact.code}——错误码表必须由 api_facts.ts 派生`,
    )
  }

  // ③ 叙述里的表格（错误体形状 / 流式终止符）不能被误删。
  assert.ok(narrativeRows.length > 5, '叙述里的表格不该被误删')
})

test('内容源：markdown 里的 HTML 不会被渲染成真标签（markdown-it html:false 防 XSS）', () => {
  const html = renderMarkdown('# t\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n')
  assert.ok(!html.includes('<script>alert(1)</script>'), '内嵌 HTML 必须被当纯文本转义')
  assert.ok(!html.includes('<img src=x'), '内嵌 HTML 必须被当纯文本转义')
  assert.match(html, /&lt;script&gt;/)
})

test('内容源：`javascript:` 链接不会被渲染成可点链接（`html:false` + markdown-it 的 validateLink）', () => {
  const html = renderMarkdown('[click](javascript:alert(2))\n\n[ok](https://example.com)\n')
  // 危险协议保持字面量，不变成 <a href="javascript:…">。
  assert.ok(!/href="javascript:/i.test(html), '`javascript:` 不得成为真的 href')
  assert.ok(html.includes('[click](javascript:alert(2))'), '危险链接应原样显示成文字')
  // 但正常链接照常渲染——否则说明把整块链接能力都关了。
  assert.match(html, /<a href="https:\/\/example\.com">ok<\/a>/)
})

test('内容源：渲染结果里没有内联 style（CSP 是 style-src self，内联样式会被静默丢弃）', async () => {
  const html = await renderDocs()
  const body = html.slice(html.indexOf('<body>'))
  assert.ok(!body.includes(' style="'), '文档渲染不得写内联样式（会被 CSP 丢弃）')
  assert.ok(!body.includes(" style='"))
})
