/**
 * 图表组件：从 deepseek-usage 的像素级实现原样抽出，数值与路径一个未改。
 *
 * 几何对齐依据见 tokens.ts（原站 ECharts 输出的实测值）。
 */
import { escapeText } from './escape.ts'
import {
  FONT_ROLES,
  axisPaddingLeft,
  formatAxisDate,
  formatCompact,
  formatThousands,
} from './tokens.ts'

/**
 * 图表渲染选项。
 *
 * `fontScale` 是用户的字号档位。为什么图表要知道字号：`paddingLeft: 'auto'` 的
 * 左边距是**服务端**按轴文字宽度算出来的，而字号是**用户可选**的。
 * 用户选「特大」时轴文字真的变大了，若仍按默认档算左边距，y 轴刻度就会被裁。
 */
export interface ChartOptions {
  /** 用户字号档位（1 = 默认）。默认 1。 */
  readonly fontScale?: number
}

/** 轴文字的实际字号：caption 档 × 用户档位。 */
function axisFontSizeOf(options: ChartOptions): number {
  return FONT_ROLES.caption.size * (options.fontScale ?? 1)
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
export const COST_THEME: ChartTheme = {
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
export const COST_KEY_COLORS = ['#FD8D3C', '#FED976', '#FC4E2A', '#FEB24C', '#E31A1C', '#FFFFB2'] as const

/**
 * 模型小图「Tokens」的柱状图配色。
 *
 * 原站这张图是三段堆叠（底 `#0C70F3` / 中 `#60B3FE` / 顶 `#A0DCFD`），
 * 其中顶段占 98%——所以**肉眼看到的是浅蓝**。我们的小图只有一个系列，
 * 于是直接用顶段那个浅蓝，单柱观感才与原站一致。
 */
export const MINI_THEME: ChartTheme = {
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
  data: readonly { readonly date: string; readonly label?: string; readonly series: Readonly<Record<string, number>> }[],
  groups: readonly string[],
  theme: ChartTheme = COST_THEME,
  /** 数值单位：金额（元）保留两位小数，计数取整。 */
  unit: 'currency' | 'count' = 'count',
  /** 渐变 id 前缀：同一页有多张图，id 必须互不冲突。 */
  key: string = 'chart',
  options: ChartOptions = {},
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
    ? axisPaddingLeft(widestTick, axisFontSizeOf(options))
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
      `<path class="bar" d="${roundedBarPath(x, top, barWidth, barHeight, radius)}" fill="url(#${gradientId})"><title>${escapeText(point.label ?? point.date)} · ${escapeText(label)}</title></path>`,
    )
  }

  // X 轴标签：有 `label` 用 label（小时图），否则按日期短格式。
  for (const index of pickLabelIndexes(data.length)) {
    const center = paddingLeft + slot * (index + 0.5)
    parts.push(
      `<text class="axis-text" x="${round(center)}" y="261" dominant-baseline="central" text-anchor="middle">${escapeText(data[index].label ?? formatAxisDate(data[index].date))}</text>`,
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
  options: ChartOptions = {},
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
    ? axisPaddingLeft(widestTick, axisFontSizeOf(options))
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
 * 选 X 轴标签下标。
 *
 * - 不超过 7 个槽位：全部标出（用量页固定 7 根柱，要看到 7 个日期）。
 * - 更长的序列：原站（ECharts 分类轴 `interval: 'auto'`）在 30 个槽位上取的是
 *   **0 / 10 / 19 / 29**：按 `(n-1) × k/3` 四等分后**四舍五入**，
 *   不是向下取整（向下会得到 0/9/19/29，第二个标签会偏左一格）。
 */
function pickLabelIndexes(count: number): number[] {
  if (count <= 0) return []
  if (count <= 7) return Array.from({ length: count }, (_, index) => index)
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


