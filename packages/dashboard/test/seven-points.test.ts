/**
 * 「恒定 7 个时间点」的护栏（owner 对用量图表的明确口径）：
 * 无论库里有多少天数据，X 轴恒 7 个点；空桶补 0；桶内金额用 BigInt 相加，不引入浮点。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as sevenPointsModule from '../app/src/app/(main)/user/_lib/seven-points.ts'
import { unwrap } from './helpers/module-interop.ts'

const { SEVEN_POINT_COUNT, costMicrosToChartNumber, hasData, toSevenPoints } =
  unwrap<typeof sevenPointsModule>(sevenPointsModule)
type DailyPointLike = Parameters<typeof toSevenPoints>[0][number]

function day(date: string, requests: number, tokens: number, costMicros: string): DailyPointLike {
  return { date, requests, tokens, costMicros }
}

function series(days: number): DailyPointLike[] {
  return Array.from({ length: days }, (_, index) => {
    const date = `2026-10-${String(index + 1).padStart(2, '0')}`
    return day(date, index + 1, (index + 1) * 10, String((index + 1) * 1000))
  })
}

describe('toSevenPoints：恒定 7 个点', () => {
  it('空输入 → 仍是 7 个全 0 桶（图表点不存在 ≠ 没有数据）', () => {
    const buckets = toSevenPoints([])
    assert.equal(buckets.length, SEVEN_POINT_COUNT)
    assert.ok(buckets.every((bucket) => bucket.requests === 0 && bucket.tokens === 0 && bucket.costMicros === '0'))
  })

  it('1 天 → 7 个点，最新那天在最后一个（补在前面）', () => {
    const buckets = toSevenPoints([day('2026-10-30', 3, 30, '3000')])
    assert.equal(buckets.length, SEVEN_POINT_COUNT)
    assert.equal(buckets.at(-1)?.date, '2026-10-30')
    assert.equal(buckets.at(-1)?.requests, 3)
    assert.equal(buckets[0]?.requests, 0)
  })

  it('7 天 → 逐日一一对应，不合并', () => {
    const buckets = toSevenPoints(series(7))
    assert.equal(buckets.length, SEVEN_POINT_COUNT)
    assert.deepEqual(
      buckets.map((bucket) => bucket.requests),
      [1, 2, 3, 4, 5, 6, 7],
    )
  })

  it('30 天 → 7 个桶，覆盖不重不漏，总量守恒', () => {
    const input = series(30)
    const buckets = toSevenPoints(input)
    assert.equal(buckets.length, SEVEN_POINT_COUNT)
    const totalRequests = (rows: readonly { requests: number }[]) => rows.reduce((sum, row) => sum + row.requests, 0)
    assert.equal(totalRequests(buckets), totalRequests(input))
    // 每段至少一天、且日期来自输入序列（取段首）
    const dates = new Set(input.map((point) => point.date))
    for (const bucket of buckets) assert.ok(dates.has(bucket.date), bucket.date)
    // 段首严格递增
    for (let index = 1; index < buckets.length; index += 1) {
      assert.ok((buckets[index]?.date ?? '') > (buckets[index - 1]?.date ?? ''))
    }
  })

  it('90 天 → 首桶从第 1 天开始、末桶含最后一天', () => {
    const input = series(90)
    const buckets = toSevenPoints(input)
    assert.equal(buckets[0]?.date, input[0]?.date)
    const lastDate = buckets.at(-1)?.date ?? ''
    assert.ok(lastDate <= (input.at(-1)?.date ?? ''))
    // 末桶起点是第 77 天（floor(6*90/7)=77，0 基）
    assert.equal(buckets.at(-1)?.date, input[77]?.date)
  })

  it('桶内金额用 BigInt 相加，超出 2^53 也精确', () => {
    // 9007199254740993 = 2^53 + 1：浮点会变成 ...992
    const input = [
      day('2026-10-01', 1, 1, '9007199254740993'),
      day('2026-10-02', 1, 1, '1'),
      day('2026-10-03', 0, 0, '0'),
      day('2026-10-04', 0, 0, '0'),
      day('2026-10-05', 0, 0, '0'),
      day('2026-10-06', 0, 0, '0'),
      day('2026-10-07', 0, 0, '0'),
      day('2026-10-08', 0, 0, '0'),
    ]
    const buckets = toSevenPoints(input)
    // 8 天压成 7 桶：第 0 桶覆盖前 1 天，第 1 桶覆盖第 2 天 → 两者各自独立
    assert.equal(buckets[0]?.costMicros, '9007199254740993')
    assert.equal(buckets[1]?.costMicros, '1')
    const merged = toSevenPoints([
      day('2026-10-01', 1, 1, '9007199254740993'),
      day('2026-10-02', 1, 1, '2'),
    ])
    assert.equal(merged.at(-2)?.costMicros, '9007199254740993')
    assert.equal(merged.at(-1)?.costMicros, '2')
  })

  it('脏金额字符串当 0，不抛错', () => {
    const buckets = toSevenPoints([day('2026-10-01', 1, 1, 'abc')])
    assert.equal(buckets.at(-1)?.costMicros, '0')
  })
})

describe('hasData / costMicrosToChartNumber', () => {
  it('全 0 桶判为无数据（图表不画柱子，但轴标签照留）', () => {
    assert.equal(hasData({ date: '2026-10-01', requests: 0, tokens: 0, costMicros: '0' }), false)
    assert.equal(hasData({ date: '2026-10-01', requests: 1, tokens: 0, costMicros: '0' }), true)
    assert.equal(hasData({ date: '2026-10-01', requests: 0, tokens: 0, costMicros: '1' }), true)
  })

  it('微元 → 元（只给画图用，先除到分避免大数丢分辨率）', () => {
    assert.equal(costMicrosToChartNumber('0'), 0)
    assert.equal(costMicrosToChartNumber('10000'), 0.01)
    assert.equal(costMicrosToChartNumber('1000000'), 1)
    assert.equal(costMicrosToChartNumber('abc'), 0)
  })
})
