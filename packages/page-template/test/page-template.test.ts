/**
 * 页面模板的测试。
 *
 * 重点是「像素级实现被原样搬过来」这件事本身：
 * 文档外壳、侧栏/卡片 DOM、图表几何、token 数值、转义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import {
  CLIENT_JS,
  COST_KEY_COLORS,
  COST_THEME,
  DARK_TOKENS,
  FONT_STACK,
  METRICS,
  PAGE_CSS,
  PageTemplateService,
  formatAxisDate,
  formatCents,
  formatCompact,
  formatThousands,
  renderAreaLineChart,
  renderChartCard,
  renderDocument,
  renderEmpty,
  renderFilterBar,
  renderModelGrid,
  renderShell,
  renderStackedBarChart,
  renderStatCards,
} from '../src/index.ts'

// ───────────────────────────── token ─────────────────────────────

test('token：沿用原站实测值，不做“近似”', () => {
  assert.equal(DARK_TOKENS.bgBase, '#151517')
  assert.equal(DARK_TOKENS.sidebarFill, '#1B1B1C')
  assert.equal(DARK_TOKENS.chartPrimary, '#FD8D3C')
  assert.equal(METRICS.sidebarWidth, 260)
  assert.equal(METRICS.cardRadius, 16)
  assert.equal(METRICS.metricValueSize, 29)
  assert.ok(FONT_STACK.startsWith('Inter,'))
})

test('CSS 与客户端脚本完整带过来', () => {
  assert.ok(PAGE_CSS.includes('.shell { display: flex;'))
  assert.ok(PAGE_CSS.includes('--bg-base: #151517;'))
  assert.ok(PAGE_CSS.includes('.chart-card {'))
  assert.ok(CLIENT_JS.includes("querySelectorAll('.pill[aria-expanded=\"true\"]')"))
})

// ───────────────────────────── 文档 ─────────────────────────────

test('文档：默认内联样式与脚本', () => {
  const html = renderDocument({ title: '测试页', body: '<p>hi</p>' })
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(html.includes('<title>测试页</title>'))
  assert.ok(html.includes('<style>'))
  assert.ok(html.includes('--bg-base: #151517;'))
  assert.ok(html.includes('<script>'))
  assert.ok(html.includes('<p>hi</p>'))
})

test('文档：给出 assets 时走外链，不再内联', () => {
  const html = renderDocument({
    title: 't',
    body: '',
    assets: { cssHref: '/console/usage/assets/usage.css', jsHref: '/console/usage/assets/usage.js' },
  })
  assert.ok(html.includes('href="/console/usage/assets/usage.css"'))
  assert.ok(html.includes('src="/console/usage/assets/usage.js"'))
  assert.ok(!html.includes('<style>'))
})

// ───────────────────────────── 外壳 ─────────────────────────────

test('外壳：当前项、品牌徽标、底部链接与用户行', () => {
  const html = renderShell({
    brand: { word: 'deepseek', badge: '开放平台', href: '/console/usage' },
    nav: [
      { label: '用量信息', href: '/console/usage', icon: 'bars', current: true },
      { label: 'API keys', href: '/console/api_keys', icon: 'search' },
    ],
    foot: [{ label: '接口文档', href: 'https://example.com', icon: 'doc', external: true }],
    user: { name: '测试用户', href: '/console/profile' },
    content: '<p>content</p>',
  })
  assert.ok(html.includes('class="side"'))
  assert.ok(html.includes('aria-current="page"'))
  assert.ok(html.includes('<span class="side-badge">开放平台</span>'))
  assert.ok(html.includes('target="_blank" rel="noreferrer"'))
  assert.ok(html.includes('class="side-name">测试用户'))
  assert.ok(html.includes('<p>content</p>'))
  // 没有头像时是「?」占位
  assert.ok(html.includes('aria-hidden="true">?</span>'))
})

test('外壳：没有 foot / user 时不渲染空块', () => {
  const html = renderShell({
    brand: { word: 'x', href: '/' },
    nav: [],
    content: '',
  })
  assert.ok(!html.includes('side-sep'))
  assert.ok(!html.includes('side-user'))
})

// ───────────────────────────── 组件 ─────────────────────────────

test('指标卡：数值与动作按钮，动态文本必须转义', () => {
  const html = renderStatCards([
    { label: '余额', value: '¥1,137.94', unit: 'CNY', info: true, action: { label: '去充值', href: '/top_up' } },
    { label: '<b>请求</b>', value: '<script>alert(1)</script>' },
  ], 'balances')
  assert.ok(html.startsWith('<div class="balances">'))
  assert.ok(html.includes('<span class="value-unit">CNY</span>'))
  assert.ok(html.includes('href="/top_up"'))
  assert.ok(html.includes('&lt;b&gt;请求&lt;/b&gt;'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
})

test('过滤行：选中态在菜单项上，胶囊显示当前值', () => {
  const html = renderFilterBar([
    {
      label: '时间维度',
      value: '近 30 天',
      items: [
        { label: '近 7 天', href: '?range=7d' },
        { label: '近 30 天', href: '?range=30d', selected: true },
      ],
    },
  ], '<a class="btn">导出</a>')
  assert.ok(html.includes('aria-selected="true" href="?range=30d"'))
  assert.ok(html.includes('<span class="pill-value">近 30 天</span>'))
  assert.ok(html.includes('<div class="filter-right">'))
  assert.ok(html.includes('aria-haspopup="listbox"'))
})

test('图表卡：标题、合计与分段控件', () => {
  const html = renderChartCard({
    title: '消费金额（CNY）',
    total: '¥12.00',
    segments: [
      { label: '调用类型', href: '?group=callKind', selected: true },
      { label: 'API Key', href: '?group=apiKey' },
    ],
    chart: '<svg></svg>',
  })
  assert.ok(html.includes('class="chart-card"'))
  assert.ok(html.includes('<span class="chart-total">¥12.00</span>'))
  assert.ok(html.includes('aria-selected="true" href="?group=callKind"'))
  assert.ok(html.includes('<svg></svg>'))
})

test('模型分块：空列表给空状态，有内容按模型分组', () => {
  assert.ok(renderModelGrid([]).includes('class="empty"'))
  const html = renderModelGrid([
    { title: 'deepseek-chat', items: [{ label: 'API 请求次数', value: '1,024', chart: '<svg></svg>' }] },
  ])
  assert.ok(html.includes('<h2 class="model-name">deepseek-chat</h2>'))
  assert.ok(html.includes('<div class="model-grid">'))
})

// ───────────────────────────── 图表 ─────────────────────────────

test('柱状图：空数据只画基线', () => {
  const svg = renderStackedBarChart([], ['调用类型'], COST_THEME, 'currency', 'empty')
  assert.ok(svg.includes('class="grid-line"'))
  assert.ok(!svg.includes('class="bar"'))
})

test('柱状图：堆叠段用硬停渐变，id 带 key 避免同页冲突', () => {
  const data = [
    { date: '2026-10-20', series: { 命中缓存: 10, 未命中: 20 } },
    { date: '2026-10-21', series: { 命中缓存: 5, 未命中: 15 } },
  ]
  const a = renderStackedBarChart(data, ['命中缓存', '未命中'], COST_THEME, 'currency', 'main')
  assert.ok(a.includes('id="dg-main-0"'))
  assert.ok(a.includes('id="dg-main-1"'))
  assert.ok(a.includes('<path class="bar"'))
  assert.ok(a.includes('stop-color="#FD8D3C"'))
  // 硬停：同一段两端 offset 相同颜色，段间是硬边
  assert.ok(a.includes('<stop offset="0%" stop-color="#FED976">'))

  const b = renderStackedBarChart(data, ['命中缓存'], COST_THEME, 'count', 'mini')
  assert.ok(b.includes('id="dg-mini-0"'))
  assert.ok(!b.includes('dg-main-0'))
})

test('柱状图：7 个槽位逐个标出日期', () => {
  const data = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-10-0${index + 1}`,
    series: { 消费金额: index + 1 },
  }))
  const svg = renderStackedBarChart(data, ['消费金额'], COST_THEME, 'currency', 'seven')
  for (let day = 1; day <= 7; day += 1) {
    assert.ok(svg.includes(`>10/${day}</text>`), `缺少 10/${day} 的轴标签`)
  }
})

test('面积图：填充 + 描边两条 path', () => {
  const svg = renderAreaLineChart(
    [
      { date: '2026-10-20', value: 12 },
      { date: '2026-10-21', value: 30 },
      { date: '2026-10-22', value: 18 },
    ],
    { ...COST_THEME, width: 422, paddingLeft: 'auto' },
    'count',
    'line',
  )
  assert.ok(svg.includes('class="area"'))
  assert.ok(svg.includes('class="line"'))
  assert.ok(svg.includes('stroke="#0C70F3"'))
})

test('图表主题：API Key 六色与主图两色都保留', () => {
  assert.equal(COST_THEME.colors.length, 2)
  assert.equal(COST_KEY_COLORS.length, 6)
  assert.equal(COST_KEY_COLORS[5], '#FFFFB2')
})

// ───────────────────────────── 格式化 ─────────────────────────────

test('格式化：金额、紧凑数、轴日期', () => {
  assert.equal(formatCents(113794), '¥1,137.94')
  assert.equal(formatCents(-5), '-¥0.05')
  assert.equal(formatThousands(1234567), '1,234,567')
  assert.equal(formatCompact(600_000_000), '600M')
  assert.equal(formatCompact(2500), '2,500')
  assert.equal(formatAxisDate('2026-09-03'), '9/3')
  assert.equal(formatAxisDate('bad'), 'bad')
})

// ───────────────────────────── 服务 ─────────────────────────────

test('服务：装载后经 ctx.pageTemplate 拿到同一套模板', async () => {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  const template = ctx.get('pageTemplate') as PageTemplateService
  assert.equal(template.styles.pageCss, PAGE_CSS)
  assert.equal(template.chartThemes.cost, COST_THEME)
  const html = template.renderDocument({ title: 'x', body: '' })
  assert.ok(html.includes('--bg-base: #151517;'))
  assert.ok(template.renderEmpty('空').includes('空'))
})
