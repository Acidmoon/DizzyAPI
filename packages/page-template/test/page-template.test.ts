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
  AXIS_LABEL_GAP,
  AXIS_PADDING_MAX,
  AXIS_PADDING_MIN,
  CLIENT_JS,
  COMPONENT_CSS,
  COST_KEY_COLORS,
  COST_THEME,
  DARK_TOKENS,
  FONT_ROLES,
  FONT_STACK,
  LETTER_SPACING,
  METRICS,
  PAGE_CSS,
  PageTemplateService,
  VENDOR_CSS_ORDER,
  VENDOR_ASSET_PREFIX,
  VENDOR_SCRIPT_ORDER,
  vendorHash,
  vendorHref,
  axisPaddingLeft,
  estimateAxisLabelWidth,
  formatAxisDate,
  formatCents,
  formatCompact,
  formatThousands,
  readVendorFile,
  renderAreaLineChart,
  renderChartCard,
  renderDocument,
  renderEmpty,
  renderFilterBar,
  renderModelGrid,
  renderShell,
  renderStackedBarChart,
  renderStatCards,
  vendorCss,
} from '../src/index.ts'

// ───────────────────────────── token ─────────────────────────────

test('token：沿用原站实测值，不做“近似”', () => {
  assert.equal(DARK_TOKENS.bgBase, '#151517')
  assert.equal(DARK_TOKENS.sidebarFill, '#1B1B1C')
  assert.equal(DARK_TOKENS.chartPrimary, '#FD8D3C')
  assert.equal(METRICS.sidebarWidth, 260)
  assert.equal(METRICS.cardRadius, 16)
  // 2026-10-29：全站字号整体上调一档（owner 要求「加大两号」），
  // 指标大数字随 `FONT_ROLES.metric` 由 29 → 34。
  // 这是**改规格**（不是放宽断言）：原值 29 已不在任何地方使用，
  // 层级关系（metric 必须大于 title）由下面那条断言守着。
  assert.equal(FONT_ROLES.metric.size, 34)
  assert.ok(FONT_ROLES.metric.size > FONT_ROLES.title.size, 'metric 必须比 title 大，否则指标数字与页面标题层级塌掉')
  assert.ok(FONT_ROLES.title.size > FONT_ROLES.emphasis.size)
  assert.ok(FONT_ROLES.emphasis.size > FONT_ROLES.body.size)
  assert.ok(FONT_ROLES.body.size > FONT_ROLES.caption.size)
  assert.ok(FONT_STACK.startsWith('Inter,'))
})

test('字号单一源：FONT_ROLES 与 CSS 里的 --fs-<role> / --lh-<role> 逐条相等', () => {
  // 这条用例是**防漂移护栏**：字号有两个可能被改的地方（TS 表 / CSS 变量），
  // 只改一边会让人以为「改了没生效」。表是唯一源，CSS 的值必须与它相等。
  for (const [role, spec] of Object.entries(FONT_ROLES)) {
    const fs = new RegExp(`--fs-${role}:\\s*calc\\(([0-9.]+)px \\* var\\(--font-scale\\)\\)`).exec(PAGE_CSS)
    assert.ok(fs !== null, `PAGE_CSS 里缺少 --fs-${role}，或没写成 calc(<n>px * var(--font-scale))`)
    assert.equal(Number(fs[1]), spec.size, `--fs-${role} 与 FONT_ROLES.${role}.size 不一致`)

    const lh = new RegExp(`--lh-${role}:\\s*([0-9.]+);`).exec(PAGE_CSS)
    assert.ok(lh !== null, `PAGE_CSS 里缺少 --lh-${role}`)
    assert.equal(Number(lh[1]), spec.lineHeight, `--lh-${role} 与 FONT_ROLES.${role}.lineHeight 不一致`)
  }

  // 行高必须是**无单位倍数**：写成 px 的话用户调大字号时文字会重叠。
  // 做法上靠「CSS 里不许再有裸 line-height: Npx」这条断言守着。
  assert.equal((PAGE_CSS.match(/line-height:\s*[0-9.]+px/g) ?? []).length, 0, 'PAGE_CSS 里还有硬编码 px 行高')
  assert.equal((PAGE_CSS.match(/font-size:\s*[0-9.]+px/g) ?? []).length, 0, 'PAGE_CSS 里还有硬编码 px 字号')

  // 字号档位用乘数表达，用户改字号只覆盖 --font-scale 一个变量。
  assert.ok(PAGE_CSS.includes('--font-scale: 1;'))

  // 字距按角色分：品牌字保留负值，正文放宽。
  assert.equal(LETTER_SPACING.tight.startsWith('-'), true)
  assert.equal(LETTER_SPACING.normal, '0.01em')
  assert.ok(PAGE_CSS.includes(`--ls-tight: ${LETTER_SPACING.tight};`))
  assert.ok(PAGE_CSS.includes(`--ls-normal: ${LETTER_SPACING.normal};`))
})

test('图表轴宽：按字号派生，不再用「12px 下的 7.5」硬算', () => {
  // 原实现 `text.length * 7.5` 是按 12px 轴文字反推的；字号涨到 14px 后
  // 字宽被低估约 17%，y 轴刻度会被 SVG 左边界裁掉。
  const text = '2,000' // 5 字符，最宽刻度
  assert.equal(estimateAxisLabelWidth(text, 12), 37.5)
  assert.equal(estimateAxisLabelWidth(text, 14), 43.75)
  assert.ok(
    estimateAxisLabelWidth(text, 14) > estimateAxisLabelWidth(text, 12),
    '字号变大时估算宽度必须跟着变大',
  )

  // 左内边距：默认字号下落在上下限区间内，且随字号单调不减。
  const at12 = axisPaddingLeft(text, 12)
  const at14 = axisPaddingLeft(text, 14)
  assert.ok(at12 >= AXIS_PADDING_MIN && at12 <= AXIS_PADDING_MAX)
  assert.ok(at14 > at12, '字号变大时左内边距必须变大，否则刻度被裁')

  // 上限也要跟着字号放大：7 字符刻度（如 `800,000`）在 14px 下会顶到 60。
  const wide = '800,000'
  assert.ok(
    axisPaddingLeft(wide, 14) > AXIS_PADDING_MAX,
    '大字号下 60px 的上限不够用，上限必须同比缩放',
  )
  // 下限：极窄刻度（`0`）在默认字号下取下限，不再更窄。
  // 注意下限本身不随字号缩放，但「所需宽度 + gap」会随字号涨，
  // 所以大字号下允许超过下限。
  assert.equal(axisPaddingLeft('0', 12), AXIS_PADDING_MIN)
  assert.ok(axisPaddingLeft('0', 24) >= AXIS_PADDING_MIN)

  // gap 常量仍然存在且被 chart 用到（防止有人把它删了但公式还引用）
  assert.equal(AXIS_LABEL_GAP, 7)
})

test('CSS 与客户端脚本完整带过来', () => {
  assert.ok(PAGE_CSS.includes('.shell { display: flex;'))
  assert.ok(PAGE_CSS.includes('--bg-base: #151517;'))
  assert.ok(PAGE_CSS.includes('.chart-card {'))
  assert.ok(CLIENT_JS.includes("querySelectorAll('.pill[aria-expanded=\"true\"]')"))
})

// ─────────────────────────── vendor 库 ───────────────────────────

test('vendor：脚本顺序是契约，app.js 必须最后', () => {
  // 顺序为什么是契约：
  // 1. floating-ui.dom 的 UMD 读全局 FloatingUICore，必须在 core 之后；
  // 2. /assets/app.js 要初始化控件、并在 htmx 已加载后改 htmx.config。
  // 顺序错了的后果是实测过的：htmx 会用默认配置注入内联 <style>（被 CSP 拦）。
  //
  // **这张表 = 现在真的有代码在调的库**，不是「白名单里有的库」：
  // 曾经把 htmx(52 KB) + floating-ui(22 KB) 挂在每一页，而全站 `hx-*` 与
  // `FloatingUIDOM` 调用各 0 处——74 KB 死代码连登录页都在下载。
  assert.deepEqual(
    [...VENDOR_SCRIPT_ORDER],
    ['tom-select/tom-select.complete.min.js', 'flatpickr/flatpickr.min.js'],
  )

  // 还没用上的库不许留在引用列表里（白名单里保留字节与 LICENSE，要用时加回来）
  for (const unused of ['htmx/htmx.min.js', 'floating-ui/floating-ui.core.umd.min.js', 'floating-ui/floating-ui.dom.umd.min.js']) {
    assert.equal(VENDOR_SCRIPT_ORDER.includes(unused as never), false, `${unused} 现在没人用，不该加载`)
    // 但字节必须还在：加回来时不用重新 vendor
    assert.ok(readVendorFile(unused) !== undefined, `${unused} 的白名单字节丢了`)
  }

  // floating-ui 一旦被加回来，core 必须排在 dom 之前（这条守卫在加回来后立刻生效）
  const coreIdx = VENDOR_SCRIPT_ORDER.indexOf('floating-ui/floating-ui.core.umd.min.js')
  const domIdx = VENDOR_SCRIPT_ORDER.indexOf('floating-ui/floating-ui.dom.umd.min.js')
  if (coreIdx >= 0 || domIdx >= 0) {
    assert.ok(coreIdx >= 0 && domIdx > coreIdx, 'floating-ui.core 必须排在 floating-ui.dom 之前')
  }
  // htmx 一旦被加回来，必须在第一个（app.js 要在它之后改 config）
  const htmxIdx = VENDOR_SCRIPT_ORDER.indexOf('htmx/htmx.min.js')
  if (htmxIdx >= 0) assert.equal(htmxIdx, 0)

  // app.js 不在 vendor 列表里——它由调用方接在最后，不能混进来
  assert.equal(VENDOR_SCRIPT_ORDER.includes('/assets/app.js' as never), false)
})

test('vendor：URL 必须带内容哈希（否则 immutable 缓存永远发不出新版本）', () => {
  for (const name of [...VENDOR_SCRIPT_ORDER, ...VENDOR_CSS_ORDER]) {
    const href = vendorHref(name)
    assert.equal(href, `${VENDOR_ASSET_PREFIX}${name}?v=${vendorHash(name)}`)
    // 8 位十六进制
    assert.match(href, /\?v=[0-9a-f]{8}$/)
    // 稳定：同一份字节算两次必须一样（否则每次渲染都换 URL，缓存全失效）
    assert.equal(vendorHref(name), href)
  }
  // 不同文件的哈希必须不同（防「哈希其实算的是名字」）
  const [a, b] = [...VENDOR_SCRIPT_ORDER]
  assert.notEqual(vendorHash(a), vendorHash(b))
  // 白名单之外没有哈希，也没有 URL
  assert.equal(vendorHash('nope.js'), undefined)
  assert.throws(() => vendorHref('nope.js' as never), /不在白名单/)
})

test('vendor：只认白名单，未知名字不发字节（无路径穿越面）', () => {
  const js = readVendorFile('htmx/htmx.min.js')
  assert.ok(js !== undefined)
  assert.equal(js?.contentType, 'text/javascript; charset=utf-8')
  assert.ok((js?.body.length ?? 0) > 10_000, 'htmx.min.js 应该是个真文件')
  assert.ok(js?.body.toString('utf8').includes('htmx'), '内容确实像 htmx')

  // 白名单之外一律 undefined：这些都不是「拼路径再过滤」，而是查表
  for (const bad of [
    'nope.js',
    '../package.json',
    'htmx/../../../../package.json',
    'htmx/',
    '',
    'LICENSE',
  ]) {
    assert.equal(readVendorFile(bad), undefined, `${bad} 不该被发出`)
  }

  // 每个白名单文件都真的存在且非空（防「登记了却没 vendor」）
  for (const name of VENDOR_SCRIPT_ORDER) {
    const file = readVendorFile(name)
    assert.ok(file !== undefined, `${name} 登记了但读不到`)
    assert.ok((file?.body.length ?? 0) > 0, `${name} 是空文件`)
  }
  for (const name of VENDOR_CSS_ORDER) {
    const file = readVendorFile(name)
    assert.ok(file !== undefined, `${name} 登记了但读不到`)
    assert.equal(file?.contentType, 'text/css; charset=utf-8')
  }
})

test('vendor：CSS 合并进 app.css，htmx indicator 样式走服务端', () => {
  const css = vendorCss()
  assert.ok(css.includes('tom-select'), 'vendorCss 应含 Tom Select 样式')
  assert.ok(css.includes('flatpickr'), 'vendorCss 应含 flatpickr 样式')

  // htmx 默认会自己注入这段内联 <style>，被 CSP 拦；所以必须由**服务端 CSS**提供，
  // 而不是等 app.js 补（否则首屏第一次请求 indicator 会裸奔）。
  assert.ok(COMPONENT_CSS.includes('.htmx-indicator'), 'COMPONENT_CSS 必须自带 indicator 样式')
  assert.ok(COMPONENT_CSS.includes('.htmx-request'))
  // app.js 负责关掉 htmx 的注入
  assert.ok(
    CLIENT_JS.includes('includeIndicatorStyles = false'),
    'app.js 必须在 htmx 之后关掉 indicator 样式注入',
  )
})

test('文档：jsHrefs 按给定顺序输出 <script src>', () => {
  const html = renderDocument({
    title: 't',
    body: '',
    assets: { cssHref: '/assets/app.css', jsHrefs: ['/a.js', '/b.js', '/assets/app.js'] },
  })
  const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])
  assert.deepEqual(order, ['/a.js', '/b.js', '/assets/app.js'])
  // 旧字段 jsHref 已删除：传了也不该被渲染出来
  assert.equal(html.includes('jsHref"'), false)
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
    // 旧字段 `jsHref` 已按方案删除（只留 jsHrefs，不留双源）；断言对象同步换名，
    // 强度不变：仍然断言外链 href/src 都出现、且不再内联。
    assets: { cssHref: '/console/usage/assets/usage.css', jsHrefs: ['/console/usage/assets/usage.js'] },
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

test('柱状图：数据点 label 优先作为轴标签（小时图）', () => {
  const svg = renderStackedBarChart(
    [{ date: '2026-10-23T12', label: '12:00', series: { 消费金额: 1 } }],
    ['消费金额'],
    COST_THEME,
    'currency',
    'hourly',
  )
  assert.ok(svg.includes('>12:00</text>'))
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
