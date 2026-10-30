/**
 * 悬浮提示（Tooltip）与轻提示（Toast）的渲染契约。
 *
 * 这两样都是「替掉浏览器默认控件」的一部分（owner 第 3 条）：
 * - tooltip 替掉 `title` 属性 / SVG `<title>`（浏览器绘制的提示，CSS 碰不到）；
 * - toast 是动作反馈（复制成功等不刷新页面的动作），与页面级 notice 分工不同。
 *
 * 断言的重点和下拉 / 日历那批一致：**无 JS 时不能把信息弄丢**。
 * tooltip 的兜底是元素自己的 `<title>`（脚本接管后才摘掉），
 * 所以这里既断言钩子在，也断言兜底在、且脚本确实会摘。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CLIENT_JS,
  TOAST_CSS,
  TOAST_HOST_ID,
  TOOLTIP_ATTR,
  TOOLTIP_CSS,
  TOOLTIP_HOST_ID,
  TOOLTIP_VENDOR_FILES,
  VENDOR_SCRIPT_ORDER,
  needsTooltips,
  renderDocument,
  renderStackedBarChart,
  renderToastHost,
  renderTooltipHost,
  tooltipAttr,
  vendorScriptsFor,
} from '../src/index.ts'
import { COST_THEME } from '../src/charts.ts'

// ─────────────────────── 悬浮提示 ───────────────────────

test('提示：属性片段带前导空格，可直接拼进属性位', () => {
  const attr = tooltipAttr('复制完整 key')
  assert.equal(attr, ' data-tooltip="复制完整 key"')
  assert.equal(attr.startsWith(' '), true)
  assert.equal(TOOLTIP_ATTR, 'data-tooltip')
})

test('提示：文案转义，塞不进真标签也破不了引号', () => {
  const attr = tooltipAttr('"><script>alert(1)</script>')
  assert.ok(!attr.includes('<script>'), '文案没转义')
  assert.ok(!attr.slice(1).slice(TOOLTIP_ATTR.length + 1).includes('"><'), '引号没转义会提前闭合属性')
  assert.match(attr, /&lt;script&gt;/)
  assert.match(attr, /&quot;/)
})

test('提示：浮层壳只输出一次，隐藏状态由 hidden 属性承担', () => {
  const host = renderTooltipHost()
  assert.ok(host.includes(`id="${TOOLTIP_HOST_ID}"`))
  assert.ok(host.includes('role="tooltip"'))
  // 默认 hidden：没有 JS 时它不该出现在页面上（tooltip 不是内容）
  assert.match(host, /\bhidden\b/)
  // 壳是空的：文案在客户端写，避免每个提示元素各带一份浮层
  assert.equal(host.replace(/<[^>]+>/g, ''), '')
})

test('提示：CSP 是 style-src self，浮层坐标只能用 CSSOM 赋值', () => {
  // style 属性会被 style-src 'self' 丢掉，所以浮层定位必须在脚本里用 el.style.x 赋值。
  // 这里守的是「别有人图省事在 HTML 里写 style="left:…"」。
  assert.ok(!renderTooltipHost().includes('style='))
  assert.match(CLIENT_JS, /host\.style\.left/)
  assert.match(CLIENT_JS, /host\.style\.top/)
  // setAttribute('style', …) 会被 CSP 拦（实测见 AGENTS.md），不许出现在脚本里
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(CLIENT_JS), '客户端脚本里出现了 setAttribute(style)')
})

test('提示：定位用 Floating UI（computePosition），不用手写坐标', () => {
  // 手写定位要自己处理「上方放不下翻到下面」「左右不出视口」，这套边界踩过坑
  // （flatpickr 的日历在弹窗里被挤出边界）。用库就别退回去。
  assert.match(CLIENT_JS, /FloatingUIDOM/)
  assert.match(CLIENT_JS, /computePosition/)
  // flip / shift 是「放不下就翻、出不界就推」的两条中间件，缺了等于没定位
  assert.match(CLIENT_JS, /ui\.flip\(\)/)
  assert.match(CLIENT_JS, /ui\.shift\(/)
  // fixed：浮层按视口算，不受 .main 这个滚动容器影响
  assert.match(CLIENT_JS, /strategy:\s*'fixed'/)
})

test('提示：库没加载成功时什么都不做，原生 <title> 兜底还在', () => {
  // 关键取舍：不删兜底就不会出现「有钩子、没反应」。
  const script = CLIENT_JS.slice(CLIENT_JS.indexOf("var ui = window.FloatingUIDOM"))
  const guard = script.indexOf('return')
  const removeAt = script.indexOf('.remove()')
  assert.ok(guard > 0 && guard < removeAt, '必须先确认库可用，再摘 <title> 兜底')
})

test('提示：脚本接管后才摘掉 <title> 兜底（否则两个提示一起弹）', () => {
  assert.match(CLIENT_JS, /function dropFallback/)
  assert.match(CLIENT_JS, /removeAttribute\('title'\)/)
  // 局部刷新换进来的元素不走初始化扫描，显示时再补摘一次
  assert.match(CLIENT_JS, /dropFallback\(reference\)/)
})

test('提示：ESC / 焦点 / 移出元素都会收起', () => {
  assert.match(CLIENT_JS, /event\.key === 'Escape'/)
  assert.match(CLIENT_JS, /'focusin'/)
  assert.match(CLIENT_JS, /'mouseout'/)
})

test('提示：滚动时跟随（autoUpdate），不是算一次就不管了', () => {
  assert.match(CLIENT_JS, /autoUpdate/)
  // 自动更新必须在收起时停掉，否则每张图都留一个监听
  assert.match(CLIENT_JS, /stopAutoUpdate\(\)/)
})

test('提示：CSS 不吃鼠标事件（否则浮层一出现就触发 mouseleave，开始闪）', () => {
  assert.ok(TOOLTIP_CSS.includes('pointer-events: none'))
})

// ─────────────────────── 要不要引 vendor 库 ───────────────────────

test('提示：没有提示的页面不引 floating-ui（22 KB 不白下）', () => {
  assert.equal(needsTooltips('<p>普通内容</p>'), false)
  assert.equal(needsTooltips(`<span${tooltipAttr('提示')}>x</span>`), true)

  // 过滤后两个库都不在；有提示时才出现，且顺序与总表一致
  const plain = vendorScriptsFor({ tooltips: needsTooltips('<p>x</p>') })
  for (const name of TOOLTIP_VENDOR_FILES) assert.equal(plain.includes(name), false)
  const rich = vendorScriptsFor({ tooltips: needsTooltips(`<i${tooltipAttr('a')}></i>`) })
  assert.deepEqual([...rich], [...VENDOR_SCRIPT_ORDER])
})

test('提示：图表页才需要它——柱子上挂了钩子，所以判据为真', () => {
  const svg = renderStackedBarChart(
    [{ date: '2026-10-30', series: { 消费金额: 3 } }],
    ['消费金额'],
    COST_THEME,
    'currency',
    'tips',
  )
  assert.equal(needsTooltips(svg), true)
  assert.match(svg, /data-tooltip="2026-10-30 · 消费金额 3"/)
})

test('提示：图表柱子同时留一份 <title> 作无 JS 兜底', () => {
  const svg = renderStackedBarChart(
    [{ date: '2026-10-30', series: { 消费金额: 3 } }],
    ['消费金额'],
    COST_THEME,
    'currency',
    'tips2',
  )
  assert.match(svg, /<title>2026-10-30 · 消费金额 3<\/title>/)
})

// ─────────────────────── 轻提示 ───────────────────────

test('轻提示：每页输出一个空宿主，带 aria-live 让读屏念出来', () => {
  const host = renderToastHost()
  assert.ok(host.includes(`id="${TOAST_HOST_ID}"`))
  assert.match(host, /role="status"/)
  assert.match(host, /aria-live="polite"/)
  // 宿主里不预渲染任何消息：服务端消息走 notice，否则每次刷新都重弹
  assert.equal(host.replace(/<[^>]+>/g, ''), '')
})

test('轻提示：声明式与命令式两个入口都在', () => {
  // 声明式：元素上写 data-toast，点一下就弹（页面里零脚本）
  assert.match(CLIENT_JS, /data-toast/)
  // 命令式：复制按钮这种已有脚本的地方直接调
  assert.match(CLIENT_JS, /window\.dizzyToast = toast/)
})

test('轻提示：文案按文本写入，不当 HTML 解析', () => {
  // 复制失败提示里会带文件名 / 模型名，用 innerHTML 就是一个 XSS 面
  assert.match(CLIENT_JS, /node\.textContent = message/)
  // 只禁「赋值」而不是禁出现这个词：注释里故意写着「不用 innerHTML」，那是解释不是用法
  assert.ok(!/\.innerHTML\s*=/.test(CLIENT_JS), '客户端脚本里出现了 innerHTML 赋值')
})

test('轻提示：有上限与自动消失，连点不会堆一列', () => {
  assert.match(CLIENT_JS, /var MAX = 4/)
  assert.match(CLIENT_JS, /host\.children\.length > MAX/)
  assert.match(CLIENT_JS, /setTimeout/)
})

test('轻提示：CSS 不吃鼠标事件、尊重减少动效偏好', () => {
  assert.ok(TOAST_CSS.includes('pointer-events: none'))
  assert.ok(TOAST_CSS.includes('prefers-reduced-motion'))
})

test('文档：tooltip 与 toast 的宿主都由 renderDocument 输出一次', () => {
  const html = renderDocument({ title: 't', body: '' })
  assert.ok(html.includes(`id="${TOOLTIP_HOST_ID}"`))
  assert.ok(html.includes(`id="${TOAST_HOST_ID}"`))
  // 各一次，不要重复
  assert.equal(html.split(`id="${TOOLTIP_HOST_ID}"`).length - 1, 1)
  assert.equal(html.split(`id="${TOAST_HOST_ID}"`).length - 1, 1)
  // 内联模式下它们的样式也要在（测试环境只有内联这一条路）
  assert.ok(html.includes('.tooltip {'))
  assert.ok(html.includes('.toasts {'))
})
