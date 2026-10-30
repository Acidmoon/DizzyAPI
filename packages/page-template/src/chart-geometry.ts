/**
 * 图表的**几何计算**：路径、插值、坐标取值。
 *
 * 为什么从 `charts.ts` 拆出来：那个文件同时装「两张图的渲染流程」与「一堆纯几何函数」，
 * 加 tooltip 钩子时顶到 400 行软上限（AGENTS.md §5.6：已有超限文件只许缩短）。
 * 拆开之后职责也变干净了：这里全是**不碰 HTML 结构**的纯函数，
 * `charts.ts` 只负责把它们的返回值拼成 SVG。
 */
import { formatCompact, formatThousands } from './tokens.ts'

/** SVG 坐标保留两位小数（原站 ECharts 输出的精度）。 */
export function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 堆叠段的硬停渐变：每段在自己的区间内两端各停一次，段与段之间是硬边。
 *
 * 原站整根柱只画一条 path，用 `objectBoundingBox` 的硬停渐变来分段，
 * 不是把各段各画一根柱子（那会在段与段之间留缝）。
 */
export function renderStackGradient(
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
export function roundedBarPath(x: number, y: number, width: number, height: number, radius: number): string {
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
 * 单调三次插值（Fritsch–Carlson）生成的三次贝塞尔路径。
 *
 * 与原站曲线形状一致的原因：单调插值在**极值处切线水平**，
 * 不会像普通样条那样冲出数据范围。
 */
export function monotoneCurve(points: readonly { readonly x: number; readonly y: number }[]): string {
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
export function pickLabelIndexes(count: number): number[] {
  if (count <= 0) return []
  if (count <= 7) return Array.from({ length: count }, (_, index) => index)
  const last = count - 1
  const indexes = [0, Math.round(last / 3), Math.round((last * 2) / 3), last]
  return [...new Set(indexes)].sort((a, b) => a - b)
}

/**
 * Y 轴刻度：
 * - 金额（元）保留两位小数；
 * - 计数取整；上到万用 `800M` 这类紧凑写法。
 */
export function formatAxisNumber(value: number, unit: 'currency' | 'count'): string {
  if (value === 0) return '0'
  if (unit === 'currency') {
    return formatThousands(Math.round(value * 100) / 100)
  }
  if (value >= 1000) return formatCompact(value)
  return formatThousands(Math.round(value))
}
