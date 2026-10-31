/**
 * 分组归并的**唯一实现**的护栏：`topWithOther`。
 *
 * 三条要钉住的口径（2026-10-31 与 `总工` 对齐）：
 * 1. **最多 12 项含「其他」**：11 个具名 + 1 个「其他」；不超过时不产生「其他」。
 * 2. **费用整数微元相加**：归并项的费用必须等于被并各项之和，**不经浮点**。
 * 3. **不丢钱**：归并前后总费用必须相等（这是最容易悄悄出错的地方）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PIE_MAX_NAMED, PIE_OTHER_LABEL, compareByCostDesc, sumTotals, topWithOther } from '../src/breakdown.ts'

interface Row {
  readonly model: string
  readonly requests: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly costMicros: string
}

function row(model: string, costMicros: string, requests = 1): Row {
  return {
    model,
    requests,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 15,
    costMicros,
  }
}

const makeOther = (tail: readonly Row[], totals: Omit<Row, 'model'>) =>
  ({ model: PIE_OTHER_LABEL, other: true as const, ...totals }) as Row & { other?: boolean }

test('不超过 12 项：原样返回，不造「其他」', () => {
  const items = Array.from({ length: PIE_MAX_NAMED }, (_, index) => row(`m${String(index)}`, String(100 - index)))
  const result = topWithOther(items, makeOther)
  assert.equal(result.length, PIE_MAX_NAMED)
  assert.equal(result.some((item) => item.model === PIE_OTHER_LABEL), false)
})

test('13 项：取前 11 + 一个「其他」，且「其他」费用等于被并项之和', () => {
  // 费用 13..1（降序输入），第 12、13 项（费用 2、1）应被并进「其他」= 3
  const items = Array.from({ length: 13 }, (_, index) => row(`m${String(index)}`, String(13 - index)))
  const result = topWithOther(items, makeOther)

  assert.equal(result.length, PIE_MAX_NAMED + 1)
  const other = result[result.length - 1]
  assert.ok(other !== undefined)
  assert.equal(other.model, PIE_OTHER_LABEL)
  assert.equal((other as Row & { other?: boolean }).other, true)
  assert.equal(other.costMicros, '3')
  assert.equal(other.requests, 2)
})

test('归并前后总费用完全相等（不丢钱、不四舍五入）', () => {
  const items = Array.from({ length: 40 }, (_, index) => row(`m${String(index)}`, String(1_000_000 - index * 7)))
  const before = items.reduce((sum, item) => sum + BigInt(item.costMicros), 0n)
  const result = topWithOther(items, makeOther)
  const after = result.reduce((sum, item) => sum + BigInt(item.costMicros), 0n)
  assert.equal(after, before)
  // 逐项核对：前 11 项原样，最后一项是剩下的全部。
  const head = result.slice(0, PIE_MAX_NAMED)
  assert.deepEqual(head.map((item) => item.costMicros), items.slice(0, PIE_MAX_NAMED).map((item) => item.costMicros))
})

test('空列表：返回空，不造一个空「其他」', () => {
  assert.deepEqual(topWithOther([], makeOther), [])
})

test('恰好 12 项：不归并（12 = 11 具名 + 1 其他才是上限，12 项具名可以全留）', () => {
  const items = Array.from({ length: PIE_MAX_NAMED }, (_, index) => row(`m${String(index)}`, String(index + 1)))
  const result = topWithOther(items, makeOther)
  assert.equal(result.length, PIE_MAX_NAMED)
})

test('sumTotals：整数微元相加，token 逐桶相加', () => {
  const totals = sumTotals([row('a', '1000001', 3), row('b', '2', 4)])
  assert.equal(totals.costMicros, '1000003')
  assert.equal(totals.requests, 7)
  assert.equal(totals.inputTokens, 20)
  assert.equal(totals.totalTokens, 30)
})

test('sumTotals：非法费用串按 0 处理，不炸统计', () => {
  const totals = sumTotals([row('a', 'not-a-number'), row('b', '5')])
  assert.equal(totals.costMicros, '5')
})

test('compareByCostDesc：大费用在前，相等返回 0（调用方再按名字兜底）', () => {
  assert.ok(compareByCostDesc(row('a', '10'), row('b', '9')) < 0)
  assert.ok(compareByCostDesc(row('a', '9'), row('b', '10')) > 0)
  assert.equal(compareByCostDesc(row('a', '10'), row('b', '10')), 0)
})

test('超大金额（超过 2^53）也不丢精度：走 bigint 比较与相加', () => {
  const big = '9007199254740993' // 2^53 + 1
  const items = [row('a', big), row('b', '2')]
  const totals = sumTotals(items)
  assert.equal(totals.costMicros, '9007199254740995')
  assert.ok(compareByCostDesc(row('a', '9007199254740994'), row('b', big)) < 0)
})
