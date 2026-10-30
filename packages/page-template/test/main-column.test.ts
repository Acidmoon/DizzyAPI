/**
 * 主列片段（第 4 批：侧栏切换只刷新右侧内容）的**渲染契约**。
 *
 * 为什么单独一个文件：这一批最容易出的错不是「实现写错」，而是**两条渲染路径漂移**——
 * 整页一份、片段另一份，看着都对，切起来才发现差一个属性。所以这里的核心断言是
 * 「片段 === 整页里 `<main>` 那一截（逐字）」，任何一边改动都会被它抓住。
 *
 * 另外守住两条退化条件：
 * - **无 JS 时一切照常**：`href` 是真的，`hx-*` 只是属性，脚本没跑就是普通链接；
 * - **底部链接不许被 boost / 拖动**：`/logout` 是 GET + 303 到登录页，
 *   被 htmx 换进主列就是「页面里嵌一个登录页」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLIENT_JS,
  MAIN_COLUMN_OPEN,
  extractMainColumn,
  renderDocument,
  renderMainColumn,
  renderShell,
} from '../src/index.ts'

const SHELL = {
  brand: { word: 'Dizzy', badge: 'API', href: '/console/usage' },
  nav: [
    { label: '用量信息', href: '/console/usage', icon: 'bars' as const, current: true },
    { label: 'API keys', href: '/console/api-keys', icon: 'search' as const },
  ],
  foot: [{ label: '退出登录', href: '/logout', icon: 'help' as const }],
  user: { name: '测试用户', href: '/console/profile' },
  content: '<p>主列内容</p>',
  pageTitle: '用量信息 · DizzyAPI',
  pagePath: '/console/usage',
  navArea: 'console' as const,
  navOrderAction: '/console/profile?action=nav-order',
} as const

test('主列：整页里 `<main>` 那一截与 renderMainColumn 逐字相同', () => {
  const shell = renderShell(SHELL)
  const extracted = extractMainColumn(shell)
  assert.ok(extracted !== undefined, '外壳里必须能找到 <main>')
  assert.equal(
    extracted,
    renderMainColumn({ content: SHELL.content, pageTitle: SHELL.pageTitle, pagePath: SHELL.pagePath }),
  )
  // 反过来：切出来的一定是整页的子串（不是另一套拼法）
  assert.ok(shell.includes(extracted))
})

test('主列：整页 = 外壳 + 同一份 main（外面还包着 .shell）', () => {
  const shell = renderShell(SHELL)
  assert.ok(shell.startsWith('<div class="shell">'))
  assert.ok(shell.endsWith('</div>'))
  assert.equal(shell.indexOf(MAIN_COLUMN_OPEN) > shell.indexOf('<aside class="side">'), true)
  // 侧栏里不许再出现第二个 <main>（那会让「切第一段」这种实现悄悄错位）
  assert.equal(shell.split('<main').length - 1, 1)
})

test('主列：data-page-title / data-page-path 都带上（客户端据此同步标题与高亮）', () => {
  const shell = renderShell(SHELL)
  assert.ok(shell.includes(`data-page-title="${SHELL.pageTitle}"`))
  assert.ok(shell.includes(`data-page-path="${SHELL.pagePath}"`))
  // 片段同样带（否则换进来之后就没有依据同步了）
  const fragment = extractMainColumn(shell) ?? ''
  assert.ok(fragment.includes(`data-page-title="${SHELL.pageTitle}"`))
  assert.ok(fragment.includes(`data-page-path="${SHELL.pagePath}"`))
})

test('主列：整页 `<title>` 与 data-page-title 是同一个变量（不许两处各拼）', () => {
  const html = renderDocument({ title: SHELL.pageTitle, body: renderShell(SHELL) })
  assert.ok(html.includes(`<title>${SHELL.pageTitle}</title>`))
  const fragment = extractMainColumn(html) ?? ''
  assert.ok(fragment.includes(`data-page-title="${SHELL.pageTitle}"`))
})

test('主列：标题里的引号等特殊字符会转义，不会把属性写坏', () => {
  const fragment = renderMainColumn({ content: 'x', pageTitle: 'a"b<c>&d', pagePath: '/p' })
  assert.ok(fragment.includes('data-page-title="a&quot;b&lt;c&gt;&amp;d"'))
  assert.ok(!fragment.includes('data-page-title="a"b'))
})

test('主列：切不出来时返回 undefined（调用方回整页，不回半截 HTML）', () => {
  assert.equal(extractMainColumn('<div>没有主列</div>'), undefined)
  assert.equal(extractMainColumn(''), undefined)
  // 只有开始标记、没有结束标记：也不能给出截断的结果
  assert.equal(extractMainColumn(`${MAIN_COLUMN_OPEN}>`), undefined)
})

test('主列：正文里出现 `</main>` 时按最后一个闭合切（页面里贴 HTML 的边界）', () => {
  const shell = renderShell({ ...SHELL, content: '<pre>&lt;/main&gt;</pre>' })
  const fragment = extractMainColumn(shell)
  assert.ok(fragment !== undefined)
  // 切出来的仍以 <main 开头、以 </main> 结尾，且包含正文
  assert.ok(fragment.startsWith(MAIN_COLUMN_OPEN))
  assert.ok(fragment.endsWith('</main>'))
  assert.ok(fragment.includes('<pre>'))
})

// ─────────────────────────── 无 JS 退化 ───────────────────────────

test('无 JS：导航链接都是真 href，hx-* 只是附加属性', () => {
  const shell = renderShell(SHELL)
  // 每个主导航项都有真 href（脚本没跑 / 加载失败时就是普通链接整页跳）
  assert.ok(shell.includes('href="/console/usage"'))
  assert.ok(shell.includes('href="/console/api-keys"'))
  assert.ok(shell.includes('hx-boost="true"'))
  // hx-* 只在属性里，不许出现内联 onclick / javascript: 之类
  assert.ok(!shell.includes('javascript:'))
  assert.ok(!shell.includes(' onclick='))
})

test('无 JS：没有 navArea 时不加任何 hx-* 与拖动钩子（登录卡走这条）', () => {
  const { navArea: _area, navOrderAction: _action, ...plain } = SHELL
  const html = renderShell(plain)
  assert.ok(!html.includes('hx-boost'))
  assert.ok(!html.includes('hx-target'))
  assert.ok(!html.includes('data-nav-order-url'))
  // 主列仍在（只是没有局部刷新能力）
  assert.ok(html.includes(MAIN_COLUMN_OPEN))
})

test('底部链接（退出登录）不许 hx-boost，也不许进拖动范围', () => {
  const html = renderShell(SHELL)
  const logout = html.slice(html.indexOf('href="/logout"'))
  const anchor = logout.slice(0, logout.indexOf('</a>'))
  assert.ok(!anchor.includes('hx-boost'), '/logout 走 GET + 303，不能被 htmx 换进主列')
  assert.ok(!anchor.includes('data-nav-path'), '退出登录不该被拖进排序结果')
})

test('侧栏容器带拖动所需的两条契约属性（脚本不认具体路由）', () => {
  const html = renderShell(SHELL)
  assert.ok(html.includes('data-nav-area="console"'))
  assert.ok(html.includes('data-nav-order-url="/console/profile?action=nav-order"'))
  // 主导航项带路径键，脚本按它排序/回滚
  assert.ok(html.includes('data-nav-path="/console/usage"'))
})

test('侧栏：可拖项显式关掉浏览器原生拖拽（否则 pointermove 会被 pointercancel 打断）', () => {
  // 实机踩过：<a> 默认 draggable，按下再移动会起一次原生 DnD，
  // 我们的 Pointer Events 拖动完全不动。`draggable="false"` 是**关掉**它，
  // 不是用 HTML5 DnD 实现排序（排序在 client-nav-order.ts 里走指针事件）。
  const html = renderShell(SHELL)
  for (const path of ['/console/usage', '/console/api-keys']) {
    const at = html.indexOf(`data-nav-path="${path}"`)
    const tag = html.slice(html.lastIndexOf('<a ', at), html.indexOf('>', at) + 1)
    assert.ok(tag.includes('draggable="false"'), `${path} 必须显式 draggable="false"`)
  }
  // 底部链接没被拖动逻辑碰过，也就不需要这个属性
  const logout = html.slice(html.indexOf('href="/logout"'))
  assert.ok(!logout.slice(0, logout.indexOf('</a>')).includes('draggable'))
})

// ───────────────────── 客户端脚本（行为契约）─────────────────────

test('客户端：用 Pointer Events，不用 HTML5 DnD', () => {
  assert.match(CLIENT_JS, /addEventListener\('pointerdown'/)
  assert.match(CLIENT_JS, /addEventListener\('pointermove'/)
  assert.match(CLIENT_JS, /addEventListener\('pointerup'/)
  // 原生 draggable 在 iOS Safari 不触发，owner 要的正是触屏「按住拖动」；
  // 排序逻辑里只许出现指针事件，不许出现 DnD 的那几个事件名。
  for (const banned of ['dragstart', 'dragover', 'dragend', 'dataTransfer']) {
    assert.ok(!CLIENT_JS.includes(banned), `不许用 HTML5 DnD 的 ${banned}`)
  }
})

test('客户端：阈值内当点击放行（否则链接点不开）', () => {
  assert.match(CLIENT_JS, /THRESHOLD = 5/)
  assert.match(CLIENT_JS, /if \(!state\.moved\) return/)
})

test('客户端：拖动中只改 DOM，松手才落库；失败回滚', () => {
  // 落库只在一处发生（persist），且由 pointerup 触发
  const persistCount = (CLIENT_JS.match(/function persist\(/g) ?? []).length
  assert.equal(persistCount, 1, '落库只能有一个入口')
  assert.match(CLIENT_JS, /finish\(event, true\)/)
  // 失败回滚成服务端顺序（不是「只改 DOM 假装成功」）
  assert.match(CLIENT_JS, /function fail\(snapshot, anchor\)/)
  assert.match(CLIENT_JS, /restore\(snapshot, anchor\)/)
  // 回滚必须真的动 DOM
  assert.match(CLIENT_JS, /nav\.insertBefore\(snapshot\[i\], anchor\)/)
})

test('客户端：htmx 的历史缓存关掉（秘密纪律 + 后退一致性）', () => {
  // 缓存会把整页 HTML（含「新建 key 后那一次」的明文）写进 sessionStorage
  assert.match(CLIENT_JS, /historyCacheSize = 0/)
  // 后退 / 前进 = 整页重载：侧栏高亮与内容由服务端一起重新渲染，天然一致
  assert.match(CLIENT_JS, /refreshOnHistoryMiss = true/)
  // 关 eval：CSP 没有 'unsafe-eval'
  assert.match(CLIENT_JS, /allowEval = false/)
})

test('客户端：换入后同步标题与侧栏高亮，且非片段响应退回整页跳转', () => {
  assert.match(CLIENT_JS, /htmx:afterSwap/)
  assert.match(CLIENT_JS, /document\.title = title/)
  assert.match(CLIENT_JS, /setAttribute\('aria-current', 'page'\)/)
  // 未登录被 302 到登录页时拿到的不是片段：不许塞进主列
  assert.match(CLIENT_JS, /htmx:beforeSwap/)
  assert.match(CLIENT_JS, /shouldSwap = false/)
})
