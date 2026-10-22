/**
 * 页面渲染：HTML 骨架 + 内联 SVG 图表。
 *
 * 渲染成**字符串**而不是 DOM 树：页面是服务端一次性产出的静态 HTML，
 * 交互（筛选、分段切换、导出）交给 `client.ts` 的原生脚本。
 *
 * 视觉对齐依据见 `tokens.ts`（原站实测值）。
 */
import type { Board, DayPoint, GroupBy, ModelBoard, RangeKey } from './board.ts'
import { microsToCents } from './board.ts'
import { toChartData } from './collect.ts'
import { AXIS_LABEL_GAP, estimateAxisLabelWidth, formatAxisDate, formatCompact, formatThousands } from './tokens.ts'

/** 渲染上下文。 */
export interface RenderContext {
  readonly board: Board
  /** 页面自身的挂载前缀（本插件的 HTTP 服务根）。 */
  readonly basePath: string
  /** 控制台入口的绝对地址（侧栏的「API keys / 充值 / 账单」指向它）。 */
  readonly consoleBaseUrl: string
  /** 当前用户名（没有会话时为 null）。 */
  readonly userName: string | null
  /** 头像 URL（没有时为 null）。 */
  readonly avatarUrl: string | null
}

/** 渲染完整 HTML 文档。 */
export function renderPage(context: RenderContext): string {
  const { board } = context
  return `<!doctype html>
<html lang="zh-CN" class="dark" data-ds-dark-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,minimum-scale=1.0,user-scalable=no">
<title>用量信息</title>
<link rel="stylesheet" href="${context.basePath}/assets/usage.css">
</head>
<body>
<div class="shell">
${renderSidebar(context)}
<main class="main">
<div class="col">
${renderHeader(context)}
${renderBalances(context)}
<div class="divider"></div>
${renderFilters(context)}
${renderMetrics(context)}
${renderChartCard(context)}
${renderModels(context)}
</div>
</main>
</div>
<script src="${context.basePath}/assets/usage.js"></script>
</body>
</html>
`
}

/** 侧栏：品牌、导航、底部链接与用户行。 */
function renderSidebar(context: RenderContext): string {
  const { basePath, consoleBaseUrl } = context
  const name = context.userName ?? '未登录'
  const avatar = context.avatarUrl === null
    ? '<span class="side-avatar" aria-hidden="true">?</span>'
    : `<span class="side-avatar"><img src="${escapeAttr(context.avatarUrl)}" alt=""></span>`
  return `<aside class="side">
<div class="side-top">
<a class="side-logo" href="${consoleBaseUrl}/console/usage">
<span class="side-word">deepseek</span><span class="side-badge">开放平台</span>
</a>
</div>
<nav class="side-nav">
<a class="side-link" aria-current="page" href="${basePath}">${iconBars()}<span>用量信息</span></a>
<a class="side-link" href="${consoleBaseUrl}/console/api_keys">${iconSearch()}<span>API keys</span></a>
<a class="side-link" href="${consoleBaseUrl}/console/top_up">${iconCard()}<span>充值</span></a>
<a class="side-link" href="${consoleBaseUrl}/console/transactions">${iconReceipt()}<span>账单</span></a>
<div class="side-sep"></div>
<a class="side-link" href="https://api-docs.deepseek.com/zh-cn/" target="_blank" rel="noreferrer">${iconDoc()}<span>接口文档</span></a>
<a class="side-link" href="https://static.deepseek.com/faq/index.html" target="_blank" rel="noreferrer">${iconHelp()}<span>帮助与反馈</span></a>
<a class="side-link" href="https://api-docs.deepseek.com/zh-cn/quick_start/pricing/" target="_blank" rel="noreferrer">${iconTag()}<span>产品定价</span></a>
<a class="side-link" href="https://chat.deepseek.com" target="_blank" rel="noreferrer">${iconChat()}<span>网页版免费对话</span></a>
</nav>
<div class="side-foot">
<a class="side-user" href="${consoleBaseUrl}/console/profile">${avatar}<span class="side-name">${escapeText(name)}</span></a>
</div>
</aside>`
}

/** 页面标题与说明行。 */
function renderHeader(context: RenderContext): string {
  return `<h1 class="page-title" role="heading" aria-level="1">用量信息</h1>
<p class="page-note"><span>所有日期均按 GMT+8 时间显示，数据可能有 5 分钟延迟。</span>${iconInfo()}</p>`
}

/** 余额卡：用户余额 + 累计消费金额。 */
function renderBalances(context: RenderContext): string {
  const { board, basePath } = context
  const balance = formatCents(board.balanceMicros)
  const spent = formatCents(board.spentMicros)
  return `<div class="balances">
<div class="card">
<div class="card-col">
<div class="card-head">
<span class="card-label">余额</span>${iconInfo()}
</div>
<div class="card-value-row">
<div class="card-value"><span class="value-main">${balance}</span><span class="value-unit">CNY</span></div>
<a class="btn" href="${basePath}/console/top_up">去充值</a>
</div>
</div>
</div>
<div class="card">
<div class="card-col">
<div class="card-head">
<span class="card-label">累计消费金额</span>
</div>
<div class="card-value-row">
<div class="card-value"><span class="value-main">${spent}</span><span class="value-unit">CNY</span></div>
</div>
</div>
</div>
</div>`
}

/** 筛选行：时间维度、API Key、导出。 */
function renderFilters(context: RenderContext): string {
  const { board, basePath } = context
  const ranges: readonly { key: RangeKey; label: string }[] = [
    { key: '7d', label: '近 7 天' },
    { key: '30d', label: '近 30 天' },
    { key: '90d', label: '近 90 天' },
  ]
  const rangeItems = ranges
    .map((item) => {
      const selected = item.key === board.range
      return `<a class="menu-item" role="option" aria-selected="${selected}" data-field="range" data-value="${item.key}" href="${filterHref(basePath, { range: item.key, apiKeyId: board.apiKeyId, groupBy: board.groupBy })}">${item.label}</a>`
    })
    .join('')

  const keyItems = [
    `<a class="menu-item" role="option" aria-selected="${board.apiKeyId === null}" data-field="apiKey" data-value="" href="${filterHref(basePath, { range: board.range, apiKeyId: null, groupBy: board.groupBy })}">全部</a>`,
    ...board.apiKeys.map((key) => {
      const selected = key.id === board.apiKeyId
      return `<a class="menu-item" role="option" aria-selected="${selected}" data-field="apiKey" data-value="${escapeAttr(key.id)}" href="${filterHref(basePath, { range: board.range, apiKeyId: key.id, groupBy: board.groupBy })}">${escapeText(key.name)}</a>`
    }),
  ].join('')

  const rangeLabel = ranges.find((item) => item.key === board.range)?.label ?? '近 30 天'
  const keyLabel = board.apiKeyId === null
    ? '全部'
    : board.apiKeys.find((key) => key.id === board.apiKeyId)?.name ?? '全部'

  return `<div class="filters">
<div class="filter-group">
<span class="pill-wrap">
<button class="pill" type="button" aria-expanded="false" aria-haspopup="listbox">
<span class="pill-label">时间维度</span><span class="pill-sep"></span>
<span class="pill-value">${escapeText(rangeLabel)}</span>${iconCaret()}
</button>
<span class="menu" role="listbox">${rangeItems}</span>
</span>
<span class="pill-wrap">
<button class="pill" type="button" aria-expanded="false" aria-haspopup="listbox">
<span class="pill-label">API Key</span><span class="pill-sep"></span>
<span class="pill-value">${escapeText(keyLabel)}</span>${iconCaret()}
</button>
<span class="menu" role="listbox">${keyItems}</span>
</span>
</div>
<div class="filter-right">
<a class="btn" data-export href="${exportHref(basePath, board)}">导出</a>
<button class="icon-btn" type="button" aria-label="更多">${iconDots()}</button>
</div>
</div>`
}

/** 指标卡：消费金额 / API 请求次数 / Tokens。 */
function renderMetrics(context: RenderContext): string {
  const { board } = context
  const cost = formatCents(board.totals.costMicros)
  return `<div class="metrics">
<div class="card">
<div class="card-col">
<div class="card-head"><span class="card-label">消费金额</span></div>
<div class="card-value-row">
<div class="card-value"><span class="value-main">${cost}</span><span class="value-unit">CNY</span></div>
</div>
</div>
</div>
<div class="card">
<div class="card-col">
<div class="card-head"><span class="card-label">API 请求次数</span></div>
<div class="card-value-row">
<div class="card-value"><span class="value-main">${formatThousands(board.totals.requests)}</span></div>
</div>
</div>
</div>
<div class="card">
<div class="card-col">
<div class="card-head"><span class="card-label">Tokens</span></div>
<div class="card-value-row">
<div class="card-value"><span class="value-main">${formatThousands(board.totals.tokens)}</span></div>
</div>
</div>
</div>
</div>`
}

/** 主图卡：消费金额（CNY）+ 分组维度切换 + 堆叠柱状图。 */
function renderChartCard(context: RenderContext): string {
  const { board, basePath } = context
  const { data, groups } = toChartData(board.daily, board.groupBy)
  const total = formatCents(board.totals.costMicros)
  // 分组维度决定色板：调用类型两色，API Key 六色（原站实测）。
  const costTheme: ChartTheme = board.groupBy === 'apiKey'
    ? { ...COST_THEME, colors: COST_KEY_COLORS }
    : COST_THEME
  const groupLink = (group: GroupBy, label: string): string => {
    const selected = board.groupBy === group
    return `<a class="seg-item" role="tab" aria-selected="${selected}" href="${filterHref(basePath, {
      range: board.range,
      apiKeyId: board.apiKeyId,
      groupBy: group,
    })}">${label}</a>`
  }
  return `<div class="chart-card">
<div class="chart-head">
<div class="chart-titles">
<span class="chart-title">消费金额（CNY）</span><span class="chart-total">${total}</span>
</div>
<div class="segmented" role="tablist">
${groupLink('callKind', '调用类型')}${groupLink('apiKey', 'API Key')}
</div>
</div>
<div class="plot">
${renderStackedBarChart(data, groups, costTheme, 'currency', 'cost')}
</div>
</div>`
}

/** 模型分块：每个模型两张小图（请求次数、Tokens）。 */
function renderModels(context: RenderContext): string {
  const { board } = context
  if (board.models.length === 0) {
    return `<div class="models"><div class="empty">当前范围内没有用量记录。</div></div>`
  }
  const blocks = board.models.map((model) => renderModelBlock(model)).join('\n')
  return `<div class="models">${blocks}</div>`
}

function renderModelBlock(model: ModelBoard): string {
  const requestData = model.daily.map((point) => ({
    date: point.date,
    value: point.requests,
  }))
  const tokenData = model.daily.map((point) => ({
    date: point.date,
    series: { Tokens: point.tokens },
  }))
  return `<section class="model">
<h2 class="model-name">${escapeText(model.model)}</h2>
<div class="model-grid">
<div class="mini">
<div class="mini-head"><span class="mini-label">API 请求次数</span><span class="mini-value">${formatThousands(model.requests)}</span></div>
<div class="mini-plot">${renderAreaLineChart(requestData, MINI_THEME, 'count', `m${slug(model.model)}-req`)}</div>
</div>
<div class="mini">
<div class="mini-head"><span class="mini-label">Tokens</span><span class="mini-value">${formatThousands(model.tokens)}</span></div>
<div class="mini-plot">${renderStackedBarChart(tokenData, ['Tokens'], MINI_THEME, 'count', `m${slug(model.model)}-tok`)}</div>
</div>
</div>
</section>`
}

/** 图表主题。主图橙黄（原站口径），模型小图蓝系（原站口径）。 */
export interface ChartTheme {
  readonly width: number
  readonly height: number
  /**
   * 绘图区左边距。
   *
   * - 固定值：直接用（主图实测 40，网格线从 x=40 起）。
   * - `'auto'`：按 Y 轴刻度文字的宽度推算（原站小图会这么做——
   *   刻度 `40` 时左边距 22，刻度 `600M` 时 37，刻度 `2,000` 时 44.5）。
   */
  readonly paddingLeft: number | 'auto'
  readonly paddingRight: number
  /** 柱宽 / 槽宽。 */
  readonly barRatio: number
  readonly radius: number
  readonly colors: readonly string[]
}

/** 主图（消费金额）配色：调用类型只有两组，原站就是橙 + 黄。 */
const COST_THEME: ChartTheme = {
  width: 896,
  height: 272,
  paddingLeft: 40,
  paddingRight: 12,
  barRatio: 0.72,
  radius: 4,
  colors: ['#FD8D3C', '#FED976'],
}

/**
 * 主图按 API Key 分组时的配色（原站 6 色循环）。
 *
 * 实测自原站同一张 SVG 里 `fill-opacity="0"` 的那组隐藏柱子，
 * 说明 API Key 维度用的是另一套色板。
 */
const COST_KEY_COLORS = ['#FD8D3C', '#FED976', '#FC4E2A', '#FEB24C', '#E31A1C', '#FFFFB2'] as const

/**
 * 模型小图「Tokens」的柱状图配色。
 *
 * 原站这张图是三段堆叠（底 `#0C70F3` / 中 `#60B3FE` / 顶 `#A0DCFD`），
 * 其中顶段占 98%——所以**肉眼看到的是浅蓝**。我们的小图只有一个系列，
 * 于是直接用顶段那个浅蓝，单柱观感才与原站一致。
 */
const MINI_THEME: ChartTheme = {
  width: 422,
  height: 272,
  paddingLeft: 'auto',
  paddingRight: 12,
  barRatio: 0.72,
  radius: 2,
  colors: ['#A0DCFD', '#60B3FE', '#0C70F3'],
}

/**
 * 模型小图「API 请求次数」的面积折线配色。
 *
 * 原站这张图不是柱状图，而是**平滑面积折线**：填充 `#70B2FE` 不透明度 0.7，
 * 描边 `#0C70F3` 宽 1.5、折角连接（实测自原站 ECharts 输出的 path）。
 */
const MINI_LINE_FILL = '#70B2FE'
const MINI_LINE_STROKE = '#0C70F3'
/**
 * 堆叠柱状图。
 *
 * 几何完全对齐原站（实测自原站 ECharts 输出的 SVG）：
 *
 * - 画布 896 × 272（主图）/ 422 × 272（模型小图），绘图区 y ∈ [8, 248]；
 * - 3 条水平网格线，y = 8.5 / 128.5 / 248.5（半像素偏移，1px 线才锐利）；
 * - **Y 轴刻度左对齐在 x=0**（`text-anchor="start"`），不是右对齐到网格线；
 * - X 轴日期标签在 y = 261，取槽位 0 / 10 / 19 / 29（首、三分之一、三分之二、末）；
 * - 柱宽 = 槽宽 × 0.72（主图 20.26px / 小图 8.95px），顶部圆角、底部直角；
 * - 堆叠的各段**不是各自独立的柱子**：原站整根柱只画一条 path，
 *   用 `objectBoundingBox` 的硬停渐变（相邻两段在同一 offset 各停一次）来分段。
 *
 * 渐变段序与配色见 `COST_THEME` / `MINI_THEME`。
 */
export function renderStackedBarChart(
  data: readonly { readonly date: string; readonly series: Readonly<Record<string, number>> }[],
  groups: readonly string[],
  theme: ChartTheme = COST_THEME,
  /** 数值单位：金额（元）保留两位小数，计数取整。 */
  unit: 'currency' | 'count' = 'count',
  /** 渐变 id 前缀：同一页有多张图，id 必须互不冲突。 */
  key: string = 'chart',
): string {
  const { width, height, paddingRight, barRatio, radius, colors } = theme
  const paddingTop = 8
  const paddingBottom = 24
  const plotHeight = height - paddingTop - paddingBottom
  const plotBottom = paddingTop + plotHeight
  const plotRight = width - paddingRight

  const totals = data.map((point) => Object.values(point.series).reduce((sum, value) => sum + value, 0))
  const max = totals.reduce((best, value) => (value > best ? value : best), 0)

  const parts: string[] = []
  if (data.length === 0 || max <= 0) {
    parts.push(
      `<line class="grid-line" x1="0" y1="${round(plotBottom + 0.5)}" x2="${plotRight}" y2="${round(plotBottom + 0.5)}"></line>`,
    )
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="按天的用量柱状图">${parts.join('\n')}</svg>`
  }

  // Y 轴刻度：0 / 一半 / 满
  const tickRatios = [0, 0.5, 1] as const
  const tickTexts = tickRatios.map((ratio) => formatAxisNumber(max * ratio, unit))

  // 绘图区左边界：主图固定 40；小图按刻度文字宽度推算（原站也是这样自动排的）
  const widestTick = tickTexts.reduce((widest, text) => (text.length > widest.length ? text : widest), '')
  const paddingLeft = theme.paddingLeft === 'auto'
    ? Math.min(60, Math.max(22, Math.ceil(estimateAxisLabelWidth(widestTick) + AXIS_LABEL_GAP)))
    : theme.paddingLeft
  const plotWidth = plotRight - paddingLeft

  // 网格线：半像素偏移，1px 描边才不会有灰边
  for (const ratio of tickRatios) {
    const y = plotBottom - plotHeight * ratio
    parts.push(
      `<line class="grid-line" x1="${round(paddingLeft)}" y1="${round(y + 0.5)}" x2="${round(plotRight)}" y2="${round(y + 0.5)}"></line>`,
    )
  }

  // Y 轴刻度：左对齐在 x=0（与图表标题同一列）
  for (const [index, ratio] of tickRatios.entries()) {
    const y = plotBottom - plotHeight * ratio
    parts.push(
      `<text class="axis-text" x="0" y="${round(y)}" dominant-baseline="central" text-anchor="start">${escapeText(tickTexts[index])}</text>`,
    )
  }

  const slot = plotWidth / data.length
  const barWidth = Math.max(2, slot * barRatio)

  // 柱子：每根柱一条 path，堆叠分段靠硬停渐变表达
  const defs: string[] = []
  for (const [index, point] of data.entries()) {
    const segments = groups
      .map((group, position) => ({ group, position, value: point.series[group] ?? 0 }))
      .filter((segment) => segment.value > 0)
    if (segments.length === 0) continue

    const total = segments.reduce((sum, segment) => sum + segment.value, 0)
    const barHeight = (total / max) * plotHeight
    const top = plotBottom - barHeight
    const center = paddingLeft + slot * (index + 0.5)
    const x = round(center - barWidth / 2)

    const gradientId = `dg-${key}-${index}`
    defs.push(renderStackGradient(gradientId, segments, total, colors))

    const label = segments
      .map((segment) => `${segment.group} ${formatThousands(segment.value)}`)
      .join(' · ')
    parts.push(
      `<path class="bar" d="${roundedBarPath(x, top, barWidth, barHeight, radius)}" fill="url(#${gradientId})"><title>${escapeText(point.date)} · ${escapeText(label)}</title></path>`,
    )
  }

  // X 轴日期：首、三分之一、三分之二、末
  for (const index of pickLabelIndexes(data.length)) {
    const center = paddingLeft + slot * (index + 0.5)
    parts.push(
      `<text class="axis-text" x="${round(center)}" y="261" dominant-baseline="central" text-anchor="middle">${formatAxisDate(data[index].date)}</text>`,
    )
  }

  const defsBlock = defs.length === 0 ? '' : `<defs>\n${defs.join('\n')}\n</defs>\n`
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="按天的用量柱状图">
${defsBlock}${parts.join('\n')}
</svg>`
}

/** 堆叠段的硬停渐变：每段在自己的区间内两端各停一次，段与段之间是硬边。 */
function renderStackGradient(
  id: string,
  segments: readonly { readonly group: string; readonly position: number; readonly value: number }[],
  total: number,
  colors: readonly string[],
): string {
  const stops: string[] = []
  let acc = 0
  // 从顶部往下累积：原站的渐变 0% 在柱顶
  for (const segment of [...segments].reverse()) {
    const start = (acc / total) * 100
    acc += segment.value
    const end = (acc / total) * 100
    const color = colors[segment.position % colors.length]
    stops.push(`<stop offset="${round(start)}%" stop-color="${color}"></stop>`)
    stops.push(`<stop offset="${round(end)}%" stop-color="${color}"></stop>`)
  }
  return `<linearGradient id="${id}" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="0" y2="1">${stops.join('')}</linearGradient>`
}

/** 顶部圆角、底部直角的柱子路径（与原站 `d` 属性同构）。 */
function roundedBarPath(x: number, y: number, width: number, height: number, radius: number): string {
  const bottom = y + height
  const r = Math.max(0, Math.min(radius, height))
  if (r === 0) return `M${x} ${y}H${x + width}V${bottom}H${x}Z`
  return [
    `M${round(x)} ${round(y + r)}`,
    `L${round(x)} ${round(bottom)}`,
    `L${round(x + width)} ${round(bottom)}`,
    `L${round(x + width)} ${round(y + r)}`,
    `A${r} ${r} 0 0 1 ${round(x + width - r)} ${round(y)}`,
    `L${round(x + r)} ${round(y)}`,
    `A${r} ${r} 0 0 1 ${round(x)} ${round(y + r)}`,
    'Z',
  ].join('')
}

/**
 * 平滑面积折线图。
 *
 * 原站的模型小图「API 请求次数」用的就是这个（实测自其 ECharts 输出）：
 * 面积填充 `#70B2FE` 不透明度 0.7，描边 `#0C70F3` 宽 1.5、折角连接。
 * 曲线用**单调三次插值**（Fritsch–Carlson）：极值处切线水平，与原站曲线形状一致。
 */
export function renderAreaLineChart(
  data: readonly { readonly date: string; readonly value: number }[],
  theme: ChartTheme = MINI_THEME,
  unit: 'currency' | 'count' = 'count',
  key: string = 'line',
): string {
  const { width, height, paddingRight, colors } = theme
  const paddingTop = 8
  const paddingBottom = 24
  const plotHeight = height - paddingTop - paddingBottom
  const plotBottom = paddingTop + plotHeight
  const plotRight = width - paddingRight

  const max = data.reduce((best, point) => (point.value > best ? point.value : best), 0)
  const parts: string[] = []
  if (data.length === 0 || max <= 0) {
    parts.push(
      `<line class="grid-line" x1="0" y1="${round(plotBottom + 0.5)}" x2="${plotRight}" y2="${round(plotBottom + 0.5)}"></line>`,
    )
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="按天的用量折线图">${parts.join('\n')}</svg>`
  }

  const tickRatios = [0, 0.5, 1] as const
  const tickTexts = tickRatios.map((ratio) => formatAxisNumber(max * ratio, unit))
  const widestTick = tickTexts.reduce((widest, text) => (text.length > widest.length ? text : widest), '')
  const paddingLeft = theme.paddingLeft === 'auto'
    ? Math.min(60, Math.max(22, Math.ceil(estimateAxisLabelWidth(widestTick) + AXIS_LABEL_GAP)))
    : theme.paddingLeft
  const plotWidth = plotRight - paddingLeft
  const slot = plotWidth / data.length

  for (const ratio of tickRatios) {
    const y = plotBottom - plotHeight * ratio
    parts.push(
      `<line class="grid-line" x1="${round(paddingLeft)}" y1="${round(y + 0.5)}" x2="${round(plotRight)}" y2="${round(y + 0.5)}"></line>`,
    )
  }
  for (const [index, ratio] of tickRatios.entries()) {
    const y = plotBottom - plotHeight * ratio
    parts.push(
      `<text class="axis-text" x="0" y="${round(y)}" dominant-baseline="central" text-anchor="start">${escapeText(tickTexts[index])}</text>`,
    )
  }

  const points = data.map((point, index) => ({
    x: paddingLeft + slot * (index + 0.5),
    y: plotBottom - (point.value / max) * plotHeight,
  }))

  const curve = monotoneCurve(points)
  const areaPath = `${curve} L${round(points[points.length - 1].x)} ${round(plotBottom)} L${round(points[0].x)} ${round(plotBottom)} Z`

  parts.push(`<path class="area" d="${areaPath}" fill="${MINI_LINE_FILL}" fill-opacity="0.7"></path>`)
  parts.push(
    `<path class="line" d="${curve}" fill="none" stroke="${MINI_LINE_STROKE}" stroke-width="1.5" stroke-linejoin="bevel"></path>`,
  )

  for (const index of pickLabelIndexes(data.length)) {
    const center = paddingLeft + slot * (index + 0.5)
    parts.push(
      `<text class="axis-text" x="${round(center)}" y="261" dominant-baseline="central" text-anchor="middle">${formatAxisDate(data[index].date)}</text>`,
    )
  }

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="按天的用量折线图">
${parts.join('\n')}
</svg>`
}

/**
 * 单调三次插值（Fritsch–Carlson）生成的三次贝塞尔路径。
 *
 * 与原站曲线形状一致的原因：单调插值在**极值处切线水平**，
 * 不会像普通样条那样冲出数据范围。
 */
function monotoneCurve(points: readonly { readonly x: number; readonly y: number }[]): string {
  const n = points.length
  if (n === 0) return ''
  if (n === 1) return `M${round(points[0].x)} ${round(points[0].y)}`

  // 每个区间的斜率
  const slopes: number[] = []
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1].x - points[i].x
    slopes.push(dx === 0 ? 0 : (points[i + 1].y - points[i].y) / dx)
  }

  // 节点切线：端点取单侧，内部取相邻斜率的中点并在过零时归零
  const tangents: number[] = new Array(n).fill(0)
  tangents[0] = slopes[0]
  tangents[n - 1] = slopes[n - 2]
  for (let i = 1; i < n - 1; i += 1) {
    if (slopes[i - 1] * slopes[i] <= 0) {
      tangents[i] = 0
    } else {
      const w1 = 2 * (points[i + 1].x - points[i].x) + (points[i].x - points[i - 1].x)
      const w2 = (points[i + 1].x - points[i].x) + 2 * (points[i].x - points[i - 1].x)
      tangents[i] = (w1 + w2) / (w1 / slopes[i - 1] + w2 / slopes[i])
    }
  }

  const commands: string[] = [`M${round(points[0].x)} ${round(points[0].y)}`]
  for (let i = 0; i < n - 1; i += 1) {
    const dx = points[i + 1].x - points[i].x
    const c1x = points[i].x + dx / 3
    const c1y = points[i].y + (tangents[i] * dx) / 3
    const c2x = points[i + 1].x - dx / 3
    const c2y = points[i + 1].y - (tangents[i + 1] * dx) / 3
    commands.push(
      `C${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(points[i + 1].x)} ${round(points[i + 1].y)}`,
    )
  }
  return commands.join('')
}

/**
 * 选 4 个 X 轴标签下标。
 *
 * 原站（ECharts 分类轴 `interval: 'auto'`）在 30 个槽位上取的是
 * **0 / 10 / 19 / 29**：按 `(n-1) × k/3` 四等分后**四舍五入**，
 * 不是向下取整（向下会得到 0/9/19/29，第二个标签会偏左一格）。
 */
function pickLabelIndexes(count: number): number[] {
  if (count <= 0) return []
  if (count <= 4) return Array.from({ length: count }, (_, index) => index)
  const last = count - 1
  const indexes = [0, Math.round(last / 3), Math.round((last * 2) / 3), last]
  return [...new Set(indexes)].sort((a, b) => a - b)
}

/** 生成用于 SVG id 的短标识（模型名可能含空格与中文）。 */
function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
}

/**
 * Y 轴刻度：
 * - 金额（元）保留两位小数；
 * - 计数取整；上到万用 `800M` 这类紧凑写法。
 */
function formatAxisNumber(value: number, unit: 'currency' | 'count'): string {
  if (value === 0) return '0'
  if (unit === 'currency') {
    return formatThousands(Math.round(value * 100) / 100)
  }
  if (value >= 1000) return formatCompact(value)
  return formatThousands(Math.round(value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** 筛选链接：带上当前范围、key 与分组维度。 */
function filterHref(
  basePath: string,
  options: { readonly range: RangeKey; readonly apiKeyId: string | null; readonly groupBy?: GroupBy },
): string {
  const params = new URLSearchParams()
  params.set('range', options.range)
  if (options.apiKeyId !== null) params.set('apiKeyId', options.apiKeyId)
  if (options.groupBy !== undefined) params.set('group', options.groupBy)
  return `${basePath}?${params.toString()}`
}

/** 导出链接：带上当前筛选条件。 */
function exportHref(basePath: string, board: Board): string {
  const params = new URLSearchParams()
  params.set('range', board.range)
  if (board.apiKeyId !== null) params.set('apiKeyId', board.apiKeyId)
  return `${basePath}/api/usage/export?${params.toString()}`
}

/** 微元 → `¥1,137.94`。 */
function formatCents(micros: string): string {
  const cents = microsToCents(micros)
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}¥${formatThousands(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll("'", '&#39;')
}

// ── 图标：按原站的线性图标风格手绘（1em 视窗，currentColor 描边） ──

function iconBars(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
}

function iconSearch(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`
}

function iconCard(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M2 10h20" fill="none" stroke="currentColor" stroke-width="2"/></svg>`
}

function iconReceipt(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`
}

function iconDoc(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M14 3v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`
}

function iconHelp(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3 2.45c-.6.2-.9.7-.9 1.3v.75" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="11.6" cy="17" r="1.1" fill="currentColor"/></svg>`
}

function iconTag(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12.5V4a1 1 0 0 1 1-1h8.5L21 11.5 12.5 20z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="7.5" cy="7.5" r="1.4" fill="currentColor"/></svg>`
}

function iconChat(): string {
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9" cy="10.5" r="1.1" fill="currentColor"/><circle cx="12.5" cy="10.5" r="1.1" fill="currentColor"/><circle cx="16" cy="10.5" r="1.1" fill="currentColor"/></svg>`
}

function iconInfo(): string {
  return `<svg class="info" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7.8" r="1.2" fill="currentColor"/></svg>`
}

function iconCaret(): string {
  return `<svg class="pill-caret" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
}

function iconDots(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="19" r="1.6" fill="currentColor"/></svg>`
}
