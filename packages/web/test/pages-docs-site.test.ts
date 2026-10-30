/**
 * 文档站（`/console/docs`）的自证用例。
 *
 * 守的纪律（与旧页 `pages-docs-*.test.ts` 同一套强度，**不放宽**）：
 * - 分区表与 `docs/api/*.md` **一一对应**：每个源文件都被一个分区认领，没有漏登记；
 * - 正文带上**每一条**派生事实（入口 / 错误码），与旧页同源同量；
 * - 标题层级 h1 → h2 → h3/h4 合法，锚点**唯一**且带 `scroll-margin-top`；
 * - 代码块三语言标签页 + 整块复制（`data-copy`），且**零脚本也能切**（radio 在 HTML 里）；
 * - `跳到主要内容` skip link 是 `<body>` 的第一个元素；`<html lang>` 正确；
 * - 只走已有的 toast（`#dizzy-toasts`），不自造第二套提示；
 * - 零内联 `style="`、零内联 `<script>`（CSP 是 `style-src/script-src 'self'`）。
 *
 * 这批用例**不替代**旧页的三份：那三份钉的是「内容与代码一致」，这里钉的是「新页面形态」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DOC_FILES } from '../src/content/api_docs.ts'
import { DOC_SECTION_FILES, DOC_SECTIONS } from '../src/content/docs_site.ts'
import { apiDocsMarkdownCopy } from '../src/content/api_docs.ts'
import { docsPage } from '../src/pages/docs.ts'
import { FACTS } from './helpers/docs-fixture.ts'
import { emptyServices, renderPage as renderFixture } from './helpers/page-fixture.ts'

/** 渲染文档站整页 HTML（不鉴权；鉴权由 HTTP 层管，另有真进程用例）。 */
async function renderPage(query = ''): Promise<string> {
  return renderFixture(docsPage, emptyServices(), query)
}

/** 正文那一截（去掉 `<head>`，避免把样式/脚本里的字符串当成页面内容）。 */
function bodyOf(html: string): string {
  const start = html.indexOf('<body>')
  assert.ok(start > 0, '页面没有 <body>')
  return html.slice(start)
}

// ───────────────────────── 分区与内容源 ─────────────────────────

test('分区：每个 docs/api/*.md 都被一个分区认领，且没有指向不存在的文件', () => {
  assert.deepEqual(
    [...DOC_SECTION_FILES].sort(),
    [...DOC_FILES].sort(),
    'docs/api 里的每个 .md 都必须出现在文档站的分区表里（漏登记 = 内容在页面上不存在）',
  )
  assert.equal(new Set(DOC_SECTION_FILES).size, DOC_SECTION_FILES.length, '分区表里有重复文件')
  // 顶部导航的五项（owner 指定的分类）。
  assert.deepEqual(
    DOC_SECTIONS.map((section) => section.label),
    ['快速开始', '接口参考', '错误码', '示例', '限流计费'],
  )
})

test('内容：页面带上派生的每一条入口与错误码（与旧页同源，不是另抄一份）', async () => {
  const html = bodyOf(await renderPage())
  assert.ok(FACTS.entries.length >= 5)
  for (const entry of FACTS.entries) {
    assert.ok(html.includes(entry.path), `文档站缺入口 ${entry.path}`)
  }
  for (const fact of [...FACTS.gatewayErrors, ...FACTS.productErrors]) {
    assert.ok(html.includes(fact.code), `文档站缺错误码 ${fact.code}`)
  }
  // 关键段落（叙述）也都在。
  for (const text of ['[DONE]', 'response.completed', 'message_stop', 'Authorization: Bearer']) {
    assert.ok(html.includes(text), `文档站缺「${text}」`)
  }
  assert.ok(!html.includes('undefined'), '页面里出现 undefined（派生/装配断了）')
  assert.ok(!html.includes('NaN'), '页面里出现 NaN')
})

// ───────────────────────── 标题层级与锚点 ─────────────────────────

test('标题：h1 → h2 → h3/h4 合法，没有跳级、没有第二个 h1', async () => {
  const html = bodyOf(await renderPage())
  const tags = [...html.matchAll(/<h([1-6])[\s>]/g)].map((match) => Number(match[1]))
  assert.ok(tags.length > 10, `标题太少：${tags.length}`)
  assert.equal(tags.filter((level) => level === 1).length, 1, '页面必须只有一个 h1')
  assert.equal(tags[0], 1, '第一个标题必须是 h1')
  let previous = 1
  for (const level of tags.slice(1)) {
    assert.ok(level <= previous + 1, `标题跳级：h${previous} 后面直接是 h${level}`)
    previous = level
  }
  // 正文里不许出现 h5 / h6（markdown 只用到 ## 与 ###）。
  assert.ok(!tags.some((level) => level >= 5), '正文出现了 h5 / h6')
})

test('锚点：id 唯一，且每个 TOC 链接都能找到目标', async () => {
  const html = bodyOf(await renderPage())
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
  assert.equal(new Set(ids).size, ids.length, `锚点 id 重复：${ids.filter((id, index) => ids.indexOf(id) !== index).join('、')}`)

  // 每个本页内锚点链接（TOC / 分类导航 / 标题永久链接）都必须有目标。
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1])
  assert.ok(hrefs.length > 10, `页内锚点太少：${hrefs.length}`)
  for (const href of hrefs) {
    assert.ok(ids.includes(href), `锚点链接 #${href} 找不到目标（点了会没反应）`)
  }
  // 每个分区标题都被目录链到。
  for (const section of DOC_SECTIONS) {
    assert.ok(hrefs.includes(section.id), `目录里没有分区 ${section.label} 的跳转`)
  }
})

test('锚点：标题带 scroll-margin-top（别被吸顶的分类导航盖住）', async () => {
  const { DOCS_SITE_CSS } = await import('../src/content/docs_site_css.ts')
  assert.match(DOCS_SITE_CSS, /\.docs-h2[^{]*\{[^}]*scroll-margin-top:/s, '标题缺 scroll-margin-top')
  assert.match(DOCS_SITE_CSS, /\.docs-h2,[^{]*\.docs-h3,\s*\.docs-h4\s*\{\s*position: relative;\s*scroll-margin-top/s,
    'scroll-margin-top 必须同时盖住 h2 / h3 / h4')
  // 实测：吸顶导航底边在 83px，写 72px 会让标题被盖住 —— 这里钉住「至少 92px」。
  const margin = /\.docs-h2,[^{]*\.docs-h3[^{]*\{[^}]*scroll-margin-top:\s*(\d+)px/s.exec(DOCS_SITE_CSS)?.[1]
  assert.ok(margin !== undefined, '读不到 scroll-margin-top 的具体值')
  assert.ok(Number(margin) >= 92, `scroll-margin-top=${margin}px 太小，标题会被吸顶导航盖住（实测导航高 83px）`)
  // 吸顶的分类导航存在（否则 scroll-margin-top 也就没必要了）。
  assert.match(DOCS_SITE_CSS, /\.docs-cats\s*\{[^}]*position:\s*sticky/s, '分类导航必须吸顶')
})

test('样式源码：CSS 里不许出现反引号或 ${（它是 JS 模板字符串，会被截断）', async () => {
  // 这条是踩过的坑：在 CSS 注释里写 `space-between` 会把模板字符串提前闭合，
  // 表现为 esbuild 报「Expected ";" but found ...」——报错点还在几十行之后，很难查。
  const { DOCS_SITE_CSS } = await import('../src/content/docs_site_css.ts')
  assert.ok(!DOCS_SITE_CSS.includes('`'), 'CSS 正文里出现了反引号（模板字符串会断）')
  assert.ok(!DOCS_SITE_CSS.includes('${'), 'CSS 正文里出现了 ${（会被当插值）')
  // 而样式本身必须是有内容的一整块（不是被截断后的残片）。
  assert.ok(DOCS_SITE_CSS.length > 3000, `CSS 正文太短（${DOCS_SITE_CSS.length} 字符），可能被截断了`)
  assert.ok(DOCS_SITE_CSS.trimEnd().endsWith('}'), 'CSS 正文结尾不是 }，说明被截断了')
})

// ───────────────────────── 代码块：语言切换 + 复制 ─────────────────────────

test('代码块：同一示例给 curl / python / nodejs 三种标签页，且是纯 CSS 单选组', async () => {
  const html = bodyOf(await renderPage())
  // 标签页文案（curl / python / nodejs）。
  for (const label of ['curl', 'python', 'nodejs']) {
    assert.match(html, new RegExp(`<label class="docs-code-tab" for="[^"]+">${label}</label>`), `缺 ${label} 标签页`)
  }
  // radio 是「无 JS 也能切」的唯一办法：必须在 HTML 里，且 name 分组、checked 默认第一项。
  const radios = [...html.matchAll(/<input class="docs-code-radio" type="radio" name="([^"]+)" id="([^"]+)"( checked)?>/g)]
  assert.ok(radios.length >= 6, `语言标签页的 radio 太少：${radios.length}`)
  const names = new Set(radios.map((match) => match[1]))
  for (const name of names) {
    const group = radios.filter((match) => match[1] === name)
    assert.equal(group.filter((match) => (match[3] ?? '').trim() === 'checked').length, 1, `radio 组 ${name} 必须恰好一个默认选中`)
  }
  // 每个 label 的 for 都指向本组里的 radio id。
  const radioIds = new Set(radios.map((match) => match[2]))
  for (const match of html.matchAll(/<label class="docs-code-tab" for="([^"]+)">/g)) {
    assert.ok(radioIds.has(match[1]), `标签页 for=${match[1]} 指向了不存在的 radio`)
  }
  // 面板被 `:checked ~` 控制（CSS 侧），HTML 里不需要任何 hidden 属性。
  assert.ok(!/class="docs-code-pane"[^>]*\shidden/.test(html), '面板不该用 hidden 属性（无 JS 会永远看不见）')
})

test('代码块：每个面板都有整块复制按钮，走的还是已有的 data-copy 钩子', async () => {
  const html = bodyOf(await renderPage())
  const copies = [...html.matchAll(/<button class="btn small docs-copy" type="button" data-copy="([^"]*)">复制<\/button>/g)]
  assert.ok(copies.length >= 15, `代码复制按钮太少：${copies.length}`)
  // 复制内容是代码本身（含 Authorization，不是 HTML）。
  assert.ok(copies.some((match) => match[1].includes('curl https://')), '复制内容里没有 curl 命令')
  assert.ok(copies.some((match) => match[1].includes('requests.post')), '复制内容里没有 python 示例')
  assert.ok(copies.some((match) => match[1].includes('await fetch')), '复制内容里没有 nodejs 示例')
  for (const match of copies) assert.ok(!match[1].includes('<div'), '复制内容不许是渲染后的 HTML')
  // `docs-copy` 类名必须留着：CSS 靠 `.docs-code .docs-copy` 把它靠右。
  // （踩过：类名漏了之后样式规则成了死代码，页面上按钮跑到了标签页左边。）
  const { DOCS_SITE_CSS } = await import('../src/content/docs_site_css.ts')
  assert.match(DOCS_SITE_CSS, /\.docs-code \.docs-copy\s*\{[^}]*margin-left:\s*auto/s, '缺「复制靠右」的样式规则')
  // 反馈只走已有 toast 宿主，不自造第二套提示。
  assert.ok(html.includes('id="dizzy-toasts"'), '页面缺 toast 宿主')
  assert.ok(!/class="[^"]*docs-toast/.test(html), '不许自造第二套提示控件')
})

// ───────────────────────── 页内动作：复制 / 下载 ─────────────────────────

test('动作：顶部有「复制本页 Markdown」与「下载 .md」，两者都指向同一份 markdown', async () => {
  const html = bodyOf(await renderPage())
  assert.ok(html.includes('复制本页 Markdown'), '缺「复制本页 Markdown」按钮')
  assert.ok(html.includes('下载 .md'), '缺「下载 .md」链接')
  assert.match(html, /href="\/console\/api-docs\.md" download=/, '下载必须指向机器友好副本')
  const copied = [...html.matchAll(/data-copy="([^"]*)"/g)].map((match) => match[1])
  const full = copied.find((value) => value.startsWith('# DizzyAPI API 文档'))
  assert.ok(full !== undefined, '「复制本页 Markdown」必须复制整页 markdown')
  for (const entry of FACTS.entries) assert.ok(full.includes(entry.path), `复制的 markdown 缺入口 ${entry.path}`)
})

test('动作：`?base=` 只换示例域名，非法值回落默认（不注入）', async () => {
  const html = bodyOf(await renderPage('base=https%3A%2F%2Fexample.com'))
  assert.ok(html.includes('https://example.com/v1/chat/completions'), 'base 没生效')

  const evil = bodyOf(await renderPage(`base=${encodeURIComponent('https://x.test/"><script>alert(1)</script>')}`))
  assert.ok(!evil.includes('<script>alert(1)</script>'), 'base 不得被原样注入')
  assert.ok(!evil.includes('x.test'), '非法 base 必须回落默认域名')
})

// ───────────────────────── 可达性 / CSP / 无 JS 退化 ─────────────────────────

test('可达性：skip link 是 <body> 的第一个元素，指向带 tabindex 的目标', async () => {
  const html = await renderPage()
  const body = bodyOf(html)
  const firstAnchor = /<body>\s*<a class="skip-link"[^>]*>([^<]+)<\/a>/.exec(body)
  assert.ok(firstAnchor !== null, 'skip link 必须是 <body> 后第一个元素（否则跳不过侧栏）')
  assert.equal(firstAnchor[1], '跳到主要内容')
  const target = /<a class="skip-link" href="#([^"]+)"/.exec(body)?.[1]
  assert.ok(target !== undefined)
  assert.ok(body.includes(`id="${target}" tabindex="-1"`), 'skip link 的目标必须带 tabindex="-1"（焦点才真的落过去）')
  // 语言声明。
  assert.match(html, /<html lang="zh-CN"/, '<html lang> 必须是 zh-CN')
})

test('可达性：目录在无脚本时仍是一串可用锚点，窄屏折叠成 <details>', async () => {
  const html = bodyOf(await renderPage())
  assert.ok(html.includes('<details class="docs-toc-mobile">'), '窄屏目录必须是 <details>')
  assert.ok(html.includes('<summary>本页目录</summary>'), '<details> 缺 summary（否则没法展开）')
  // 两处目录（左侧固定 + 移动端折叠）都是服务端渲染的普通链接。
  const tocLinks = (html.match(/class="docs-toc-link"/g) ?? []).length
  assert.ok(tocLinks >= 20, `目录链接太少：${tocLinks}`)
  assert.ok(!/<nav class="docs-toc"[^>]*>\s*<script/.test(html), '目录不许依赖脚本')
})

test('CSP：零内联 style、零内联 script，样式都在 app.css 正文里', async () => {
  const html = await renderPage()
  const body = bodyOf(html)
  assert.ok(!body.includes(' style="'), '文档站不许写内联样式（CSP 会静默丢弃）')
  assert.ok(!/<script(?![^>]*\ssrc=)/.test(body), '不许内联 <script>')
  // 样式文本必须真的进了 `/assets/app.css` 的装配正文（否则类名有、样式没有）。
  const { APP_CSS_BODY } = await import('../src/asset-version.ts')
  for (const cls of ['docs-page', 'docs-cats', 'docs-toc', 'docs-code-pane', 'docs-table', 'skip-link']) {
    assert.ok(APP_CSS_BODY.includes(`.${cls}`), `app.css 里缺 .${cls}（页面上会是个没样式的东西）`)
  }
})

// ───────────────────────── 路由注册 ─────────────────────────

test('路由：文档站已注册，路径不覆盖旧文档页，且都要登录', async () => {
  const { PAGES } = await import('../src/pages/index.ts')
  const paths = PAGES.map((page) => page.path)
  assert.equal(new Set(paths).size, paths.length, '路由表里有重复路径')
  for (const path of ['/console/api-docs', '/console/docs']) {
    const page = PAGES.find((item) => item.path === path)
    assert.ok(page !== undefined, `路由表里缺 ${path}`)
    assert.equal(page.auth, true)
    assert.equal(page.area, 'console')
  }
  // 侧栏里有入口（否则页面只能靠记地址）。
  const { CONSOLE_NAV } = await import('../src/layout.ts')
  assert.ok(CONSOLE_NAV.some((item) => item.path === '/console/docs'), '用户在侧栏找不到文档站')
})

test('渲染是幂等的：连续两次渲染的锚点与 radio id 完全一致', async () => {
  const first = await renderPage()
  const second = await renderPage()
  assert.equal(first, second, '两次渲染结果不一致（模块级状态没重置，锚点/单选组会互相污染）')
  // 「复制本页 Markdown」复制的是 `/console/api-docs.md` 那份，逐字一致（属性值按 HTML 转义比）。
  const html = bodyOf(first)
  const copied = [...html.matchAll(/data-copy="([^"]*)"/g)].map((match) => match[1])
  const full = copied.find((value) => value.startsWith('# DizzyAPI API 文档'))
  assert.ok(full !== undefined, '页面里没有「整页 markdown」的复制按钮')
  const escaped = apiDocsMarkdownCopy()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
  assert.equal(full, escaped, '「复制本页 Markdown」的内容必须与 /console/api-docs.md 逐字一致')
})
