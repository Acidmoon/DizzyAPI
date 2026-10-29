/**
 * API 文档的**页面渲染 + HTTP 接线**测试。
 *
 * 守的纪律：
 * - 页面渲染带齐派生事实、表格 / 代码块映射到模板 class（不写内联样式）；
 * - 「复制整页 Markdown」按钮复制的就是那份 markdown；
 * - `<head>` 里有 `rel=alternate` 与 `rel=describedby` 两条机器可读链接；
 * - `base` 查询参数只影响示例域名，非法值回落（不注入）；
 * - **`/llms.txt` 与 `/console/api-docs.md` 由 web 插件真的发出来**（真进程 HTTP），
 *   且不要求登录（这两条就是给 agent 抓的）。
 *
 * 同一主题的另外两份：`pages-docs-source.test.ts`（内容源与反模式护栏）、
 * `pages-docs-facts.test.ts`（派生事实与代码一致）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { apiDocsMarkdown, apiDocsResource, renderLlmsTxt } from '../src/content/api_docs.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import { FACTS, renderDocs } from './helpers/docs-fixture.ts'

// ───────────────────────── 机器友好副本（纯函数层） ─────────────────────────

test('/console/api-docs.md：返回纯 markdown（不是 HTML、不是 JSON）', () => {
  const resource = apiDocsResource('/console/api-docs.md')
  assert.ok(resource !== null, '这条路由必须存在')
  assert.equal(resource.status, 200)
  assert.match(resource.contentType, /^text\/markdown;/)
  const body = resource.body
  assert.match(body, /^# DizzyAPI API 文档/)
  assert.match(body, /^\| --- \|/m, 'markdown 表格的分隔行要在（说明表格没被渲染成 HTML）')
  assert.ok(!body.includes('<!doctype html>'), '不得返回 HTML 文档')
  assert.ok(!body.includes('<div class="panel">'), '不得返回渲染后的 HTML')
  assert.ok(body.includes('/v1/chat/completions'))
  assert.ok(body.includes('INSUFFICIENT_BALANCE'))
  assert.ok(body.includes('Authorization: Bearer'))
  assert.ok(body.endsWith('\n'), 'agent 直接抓：末尾必须有换行')
  assert.equal(body, `${apiDocsMarkdown()}\n`, '副本必须就是整页 markdown（不许另一套生成逻辑）')
})

test('/llms.txt：返回站点索引，指向 .md 副本与关键页面，且与派生的入口数一致', () => {
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
  // 索引里的数量是派生的，不写死。
  assert.ok(body.includes(`${FACTS.entries.length} 个`), 'llms.txt 的入口数量必须与派生结果一致')
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
  for (const fact of [...FACTS.gatewayErrors, ...FACTS.productErrors]) {
    assert.ok(html.includes(fact.code), `页面缺错误码 ${fact.code}`)
  }
  assert.match(html, /\[DONE\]/)
  assert.match(html, /response\.completed/)
  assert.match(html, /message_stop/)
  assert.match(html, /Authorization: Bearer/)
  assert.ok(!html.includes('undefined'))
  assert.ok(!html.includes('NaN'))
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
  for (const entry of FACTS.entries) assert.ok(copied.includes(entry.path), `复制内容缺入口 ${entry.path}`)
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
  const head = html.slice(0, html.indexOf('</head>'))
  assert.ok(head.includes('rel="alternate"'))
  assert.ok(head.includes('rel="describedby"'))
})

test('文档页：base 查询参数只影响示例里的域名，且非法值回落到默认（不注入）', async () => {
  const html = await renderDocs('base=https%3A%2F%2Fexample.com')
  assert.ok(html.includes('https://example.com/v1/chat/completions'))

  const evilBase = 'https://x.test/"><script>alert(1)</script>'
  const evil = await renderDocs(`base=${encodeURIComponent(evilBase)}`)
  assert.ok(!evil.includes('<script>alert(1)</script>'), 'base 不得被原样注入')
  assert.ok(!evil.includes('x.test'), '非法 base 必须回落到默认域名')
  assert.ok(evil.includes('/v1/chat/completions'))
})

test('页面注册：文档页与模型广场都在路由表里，路径唯一', async () => {
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

// ───────────────────────── HTTP 接线（真进程） ─────────────────────────

async function bootWeb(): Promise<{ base: string; close(): Promise<void> }> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let i = 0; i < 100; i += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(web.address !== undefined, 'web 服务没有启动')
    return {
      app: web,
      port: web.address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  return { base: started.base, close: started.close }
}

test('HTTP：/llms.txt 与 /console/api-docs.md 由 web 发，且不要求登录', async () => {
  const app = await bootWeb()
  try {
    const llms = await fetch(`${app.base}/llms.txt`)
    assert.equal(llms.status, 200, 'agent 不该被登录挡住')
    assert.match(llms.headers.get('content-type') ?? '', /^text\/plain;/)
    const llmsBody = await llms.text()
    assert.match(llmsBody, /^# DizzyAPI/)
    assert.ok(llmsBody.includes('/console/api-docs.md'))

    const md = await fetch(`${app.base}/console/api-docs.md`)
    assert.equal(md.status, 200)
    assert.match(md.headers.get('content-type') ?? '', /^text\/markdown;/)
    const mdBody = await md.text()
    assert.match(mdBody, /^# DizzyAPI API 文档/)
    assert.ok(mdBody.includes('/v1/chat/completions'))
    assert.ok(mdBody.endsWith('\n'))

    // 子路径不接管。
    const nested = await fetch(`${app.base}/console/api-docs.md/x`)
    assert.equal(nested.status, 404)
  } finally {
    await app.close()
  }
})

test('HTTP：文档页本体仍要登录（机器副本不鉴权 ≠ 页面不鉴权）', async () => {
  const app = await bootWeb()
  try {
    const page = await fetch(`${app.base}/console/api-docs`, { redirect: 'manual' })
    assert.equal(page.status, 302)
    assert.equal(page.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))
  } finally {
    await app.close()
  }
})
