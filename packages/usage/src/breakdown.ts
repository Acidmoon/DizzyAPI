/**
 * 分组明细的「截断 + 其他归并」（饼图口径的唯一实现）。
 *
 * 为什么放服务端：饼图最多 12 个扇区（含「其他」），前端若各自截断，用户页与管理页
 * 的归并结果会不一致；在这里做一次、两边都吃同一份数据，口径只有一处。
 *
 * 两条纪律：
 * 1. **按金额降序**取前 `MAX_NAMED` 项，其余按费用与 token **整数相加**成一项「其他」。
 * 2. 金额一律 bigint 整数微元，**禁止浮点**。
 */

/** 饼图扇区上限（含「其他」）。 */
export const PIE_MAX_SLICES = 12

/** 具名扇区上限（「其他」之外）。 */
export const PIE_MAX_NAMED = PIE_MAX_SLICES - 1

/** 「其他」这一项的展示标记（前端据此不显示具体名字的颜色图例）。 */
export const PIE_OTHER_LABEL = '其他'

/** 分组明细里每项都要有的最小形状。 */
export interface BreakdownTotals {
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly costMicros: string
}

/**
 * 截断 + 「其他」归并。
 *
 * `makeOther` 负责把尾部若干项合成一项（不同维度要填不同的标识字段：
 * 模型填 `model`，key 填 `apiKeyId` / `apiKeyName`，用户填 `userId`）。
 */
export function topWithOther<T extends BreakdownTotals>(
  items: readonly T[],
  makeOther: (tail: readonly T[], totals: BreakdownTotals) => T,
  maxNamed: number = PIE_MAX_NAMED,
): readonly T[] {
  if (items.length <= maxNamed) return items
  const head = items.slice(0, maxNamed)
  const tail = items.slice(maxNamed)
  return [...head, makeOther(tail, sumTotals(tail))]
}

/** 若干项求和（费用走 bigint，token 走 number —— 单组 token 远小于 2^53）。 */
export function sumTotals(items: readonly BreakdownTotals[]): BreakdownTotals {
  let costMicros = 0n
  let requests = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  for (const item of items) {
    costMicros += microsOf(item.costMicros)
    requests += item.requests
    inputTokens += item.inputTokens
    outputTokens += item.outputTokens
    cacheReadTokens += item.cacheReadTokens
    cacheWriteTokens += item.cacheWriteTokens
    reasoningTokens += item.reasoningTokens
    totalTokens += item.totalTokens
  }
  return {
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    costMicros: costMicros.toString(),
  }
}

/** 十进制微元字符串 → bigint；非法值当 0（不炸统计）。 */
function microsOf(value: string): bigint {
  return /^-?\d+$/.test(value) ? BigInt(value) : 0n
}

/** 按精确费用降序排（bigint 比较，不经浮点）；同费用按名字升序保证稳定。 */
export function compareByCostDesc(a: BreakdownTotals, b: BreakdownTotals): number {
  const left = microsOf(a.costMicros)
  const right = microsOf(b.costMicros)
  if (left === right) return 0
  return left > right ? -1 : 1
}
