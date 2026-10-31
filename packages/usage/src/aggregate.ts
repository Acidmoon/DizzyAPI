/**
 * 聚合累加器与 SQL 折叠（从 `service.ts` 拆出来）。
 *
 * 为什么单独成文件：`service.ts` 已经 1414 行、远超 500 行上限（AGENTS.md §5.6
 * 「已有超限文件只许缩短，不许加长」）。这次要给它加「按 API key / 按用户」两个聚合维度，
 * 就把同一职责的「GROUP BY 折叠 + 费用累加」整块搬出来，让 `service.ts` 净减。
 *
 * 三条口径：
 * 1. **费用按模型单价分别算再相加**：同一组里混了不同模型时，不能拿混合 token 套一个单价。
 * 2. **金额一律 bigint 整数微元**，不经浮点。
 * 3. **探测流量按 `api_key_name` 前缀排除**（`__probe__`），在 SQL 的 WHERE 里排除，
 *    不是在页面里藏 —— 否则列表和导出还是脏的。
 */
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import { queryWhere } from './query.ts'
import type { PricingPort, TokenCountsLike, UsageQuery, UsageTokenTotals } from './types.ts'

/** 一个分组的累加器。 */
export interface TotalsAccumulator {
  requests: bigint
  inputTokens: bigint
  outputTokens: bigint
  cacheReadTokens: bigint
  cacheWriteTokens: bigint
  reasoningTokens: bigint
  totalTokens: bigint
  costMicros: bigint
}

/** 空累加器。 */
export function emptyAccumulator(): TotalsAccumulator {
  return {
    requests: 0n,
    inputTokens: 0n,
    outputTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    reasoningTokens: 0n,
    totalTokens: 0n,
    costMicros: 0n,
  }
}

/** 累加器 → 对外 DTO（token 是 number，费用是十进制字符串）。 */
export function totalsOf(acc: TotalsAccumulator): UsageTokenTotals {
  return {
    requests: safeNumber(acc.requests),
    inputTokens: safeNumber(acc.inputTokens),
    outputTokens: safeNumber(acc.outputTokens),
    cacheReadTokens: safeNumber(acc.cacheReadTokens),
    cacheWriteTokens: safeNumber(acc.cacheWriteTokens),
    reasoningTokens: safeNumber(acc.reasoningTokens),
    totalTokens: safeNumber(acc.totalTokens),
    costMicros: acc.costMicros.toString(),
  }
}

/** 把两个累加器相加（给「其他」归并用）。 */
export function addAccumulator(target: TotalsAccumulator, source: TotalsAccumulator): void {
  target.requests += source.requests
  target.inputTokens += source.inputTokens
  target.outputTokens += source.outputTokens
  target.cacheReadTokens += source.cacheReadTokens
  target.cacheWriteTokens += source.cacheWriteTokens
  target.reasoningTokens += source.reasoningTokens
  target.totalTokens += source.totalTokens
  target.costMicros += source.costMicros
}

/**
 * 一次 `GROUP BY` 聚合，结果按 `keyOf` 折成 Map。
 *
 * **调用方必须把 `model` 放进维度**：费用要按模型单价算，不带 model 就无法正确计价。
 * `keyOf` 省略时结果只有 `''` 一个键（全量 totals）。
 */
export function foldAggregates(
  db: DatabaseSync,
  query: UsageQuery,
  dimensions: readonly string[],
  pricing: PricingPort | undefined,
  keyOf?: (row: Record<string, SQLOutputValue>) => string,
): Map<string, TotalsAccumulator> {
  const where = queryWhere(query, false)
  const statement = db.prepare(`
    SELECT ${dimensions.join(', ')},
           COUNT(*) AS requests,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM usage_records
    WHERE ${where.sql}
    GROUP BY ${dimensions.join(', ')}
  `)
  statement.setReadBigInts(true)
  const rows = statement.all(...where.params) as Record<string, SQLOutputValue>[]

  const groups = new Map<string, TotalsAccumulator>()
  for (const row of rows) {
    const model = String(row.model ?? '')
    const inputTokens = toBigInt(row.input_tokens)
    const outputTokens = toBigInt(row.output_tokens)
    const cacheReadTokens = toBigInt(row.cache_read_tokens)
    const cacheWriteTokens = toBigInt(row.cache_write_tokens)
    const costMicros = quoteCostMicros(pricing, model, {
      inputTokens: Number(inputTokens),
      outputTokens: Number(outputTokens),
      cacheReadTokens: Number(cacheReadTokens),
      cacheWriteTokens: Number(cacheWriteTokens),
    })
    const key = keyOf === undefined ? '' : keyOf(row)
    const acc = groups.get(key) ?? emptyAccumulator()
    acc.requests += toBigInt(row.requests)
    acc.inputTokens += inputTokens
    acc.outputTokens += outputTokens
    acc.cacheReadTokens += cacheReadTokens
    acc.cacheWriteTokens += cacheWriteTokens
    acc.reasoningTokens += toBigInt(row.reasoning_tokens)
    acc.totalTokens += toBigInt(row.total_tokens)
    acc.costMicros += costMicros
    groups.set(key, acc)
  }
  return groups
}

/** 按模型单价算一条聚合行的费用（微元）；没价按 0，不让一条坏数据毁掉整页。 */
export function quoteCostMicros(
  pricing: PricingPort | undefined,
  model: string,
  tokens: TokenCountsLike,
): bigint {
  if (pricing === undefined) return 0n
  try {
    return BigInt(pricing.quote(model, tokens))
  } catch {
    return 0n
  }
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  return 0n
}

function safeNumber(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (value > max) return Number.MAX_SAFE_INTEGER
  if (value < -max) return Number.MIN_SAFE_INTEGER
  return Number(value)
}
