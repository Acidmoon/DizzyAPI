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
