/**
 * 按天序列的等分聚合：把任意长度的日序列压成最多 N 个桶。
 *
 * 用量页的消费图固定显示 7 根柱：30 / 90 天范围按时间顺序均分，
 * 金额用整数微元累加（不引入浮点）。桶标签取组内第一天。
 */
export interface DailyLike {
  readonly date: string
  readonly costMicros: string
  readonly requests: number
  readonly totalTokens: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export function bucketDaily<T extends DailyLike>(points: readonly T[], buckets = 7): DailyLike[] {
  if (points.length === 0) return []
  if (points.length <= buckets) return points.map((point) => ({ ...point }))

  const result: DailyLike[] = []
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = Math.floor((bucket * points.length) / buckets)
    const end = Math.floor(((bucket + 1) * points.length) / buckets)
    if (start >= end) continue
    const group = points.slice(start, end)
    let cost = 0n
    let requests = 0
    let totalTokens = 0
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    for (const point of group) {
      cost += BigInt(point.costMicros)
      requests += point.requests
      totalTokens += point.totalTokens
      inputTokens += point.inputTokens
      outputTokens += point.outputTokens
      cacheReadTokens += point.cacheReadTokens
      cacheWriteTokens += point.cacheWriteTokens
    }
    result.push({
      date: group[0].date,
      costMicros: cost.toString(),
      requests,
      totalTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    })
  }
  return result
}

/** 单日视图的小时桶：从 `toMs` 所在小时往前共 `hours` 个整点。 */
export interface HourBucket {
  /** 本地时区的 `HH:00`。 */
  readonly label: string
  readonly costMicros: string
}

const HOUR_MS = 3_600_000

export function hourlyBuckets(
  rows: readonly { readonly startedAt: string; readonly costMicros: string }[],
  toMs: number,
  hours = 7,
): HourBucket[] {
  if (hours <= 0) return []
  // 当前小时也计入：窗口是「最近 7 个整点小时」。
  const endHour = Math.floor(toMs / HOUR_MS) + 1
  // 统一用「epoch 小时索引」作 key，避免毫秒与索引混用。
  const hoursWindow = Array.from({ length: hours }, (_, index) => endHour - hours + index)
  const sums = new Map<number, bigint>()
  for (const row of rows) {
    const at = Date.parse(row.startedAt)
    if (Number.isNaN(at)) continue
    const key = Math.floor(at / HOUR_MS)
    sums.set(key, (sums.get(key) ?? 0n) + BigInt(row.costMicros))
  }
  return hoursWindow.map((hour) => ({
    label: `${String(new Date(hour * HOUR_MS).getHours()).padStart(2, '0')}:00`,
    costMicros: (sums.get(hour) ?? 0n).toString(),
  }))
}
