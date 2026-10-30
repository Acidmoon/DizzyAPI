/**
 * 把任意长度的按天序列压成**恒定 7 个时间点**（owner 明确要求过这个口径，旧 `web` 插件
 * 的用量页就是这么做的：恒 7 个 X 轴点、空桶补 0，与库里有多少天数据无关）。
 *
 * 为什么不是「有几天画几根柱」：图表宽度固定，7 天 / 30 天 / 90 天三个区间如果柱数不同，
 * 同一块区域的密度会跳变，看起来像两套图表；而且没有数据的日子会整根消失，
 * 用户会以为「那天不存在」而不是「那天 0 消费」。
 *
 * 分桶规则（纯函数，可测）：
 * - `days.length <= points` 时**每个真实日各占一个点**（左对齐），其余补 0 桶 → 总数恒为 7。
 * - 更长时把序列**按顺序均分**成 `points` 段：第 i 段覆盖 `[floor(i*n/7), floor((i+1)*n/7))`，
 *   保证不重不漏、每段至少一天。
 * - 每个桶的标签取该段**第一天**的日期（`YYYY-MM-DD`）——它代表「这一段从哪天开始」，
 *   而聚合值是该段内所有天的**和**。
 *
 * 本文件与 UI 无关（不 import React），测试在 `packages/dashboard/test/seven-points.test.ts`。
 */

/** 恒定 7 个时间点：这个数字是口径，不是可调参数（改它要 owner 点头）。 */
export const SEVEN_POINT_COUNT = 7

/** 一个按天聚合的原始点（金额用整数微元的十进制字符串，避免浮点）。 */
export interface DailyPointLike {
  readonly date: string
  readonly requests: number
  readonly tokens: number
  readonly costMicros: string
}

export interface SevenPointBucket {
  /** 桶标签：该段第一天的 `YYYY-MM-DD`（单日区间就是那天本身）。 */
  readonly date: string
  readonly requests: number
  readonly tokens: number
  readonly costMicros: string
}

/** 微元字符串相加（BigInt；非法值当 0，仍然不引入浮点）。 */
function addMicros(left: string, right: string): string {
  const parse = (value: string): bigint => (/^-?\d+$/.test(value) ? BigInt(value) : 0n)
  return (parse(left) + parse(right)).toString()
}

const EMPTY_BUCKET: SevenPointBucket = { date: '', requests: 0, tokens: 0, costMicros: '0' }

/**
 * 主入口。入参按日期升序（服务端 `daily` 就是这个顺序），返回**恰好 7 个**桶。
 *
 * 空输入 → 7 个全 0 桶，`date` 为空串（调用方渲染成「—」），而不是返回空数组：
 * 「没有数据」和「图表不存在」是两件事。
 */
export function toSevenPoints(points: readonly DailyPointLike[]): SevenPointBucket[] {
  const count = SEVEN_POINT_COUNT
  const empty = Array.from({ length: count }, () => ({ ...EMPTY_BUCKET }))
  if (points.length === 0) return empty

  // 少于 7 天：一天一个点，缺的补 0（**补在前面**，让最新的那天永远是最右边的柱子）。
  if (points.length <= count) {
    const reals: SevenPointBucket[] = points.map((point) => ({
      date: point.date,
      requests: point.requests,
      tokens: point.tokens,
      costMicros: addMicros('0', point.costMicros),
    }))
    const padding = Array.from({ length: count - reals.length }, () => ({ ...EMPTY_BUCKET }))
    return [...padding, ...reals]
  }

  const total = points.length
  const buckets: SevenPointBucket[] = []
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((index * total) / count)
    const end = Math.floor(((index + 1) * total) / count)
    const slice = points.slice(start, Math.max(end, start + 1))
    if (slice.length === 0) {
      buckets.push({ ...EMPTY_BUCKET })
      continue
    }
    let requests = 0
    let tokens = 0
    let costMicros = '0'
    for (const point of slice) {
      requests += point.requests
      tokens += point.tokens
      costMicros = addMicros(costMicros, point.costMicros)
    }
    buckets.push({ date: slice[0]?.date ?? '', requests, tokens, costMicros })
  }
  return buckets
}

/** 桶里有没有真数据（全 0 的桶在图表上不画柱子，但 X 轴标签照留）。 */
export function hasData(bucket: SevenPointBucket): boolean {
  return bucket.requests > 0 || bucket.tokens > 0 || bucket.costMicros !== '0'
}

/** 图表用的紧凑数值：微元 → 「元」的 number（只给 recharts 画图，展示一律用字符串原文）。 */
export function costMicrosToChartNumber(costMicros: string): number {
  if (!/^-?\d+$/.test(costMicros)) return 0
  // 图表不需要 6 位精度：先除到「分」，避免大数值在 SVG 坐标系里失去分辨率。
  return Number(BigInt(costMicros) / 10_000n) / 100
}
