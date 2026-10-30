/**
 * `@/lib/format` 的护栏：金额是整数微元、禁止浮点，未知就是未知（不是 0）。
 *
 * 这些用例是 owner 那条硬要求的机器化版本：「余额/金额一律整数最小单位，禁止浮点」。
 * 任何一条挂掉都说明有人把金额改成了 `Number` / `toFixed` / `/` 运算。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as formatModule from '../app/src/lib/format.ts'
import { unwrap } from './helpers/module-interop.ts'

const { formatCentsAsYuan, formatDate, formatDateTime, formatDurationMs, formatMonthDayLabel, formatPercent } =
  unwrap<typeof formatModule>(formatModule)
const { formatTokens, formatTtftMs, formatYuan, NOT_COLLECTED, UNKNOWN_AMOUNT } =
  unwrap<typeof formatModule>(formatModule)

describe('formatMicrosAsYuan（1 元 = 1_000_000 微元，整数运算）', () => {
  it('0 不是「空」，是 0.00', () => {
    assert.equal(formatYuan('0'), '0.00 元')
  })

  it('小额消费必须看得见（不是 0.00）', () => {
    assert.equal(formatYuan('161'), '0.000161 元')
    assert.equal(formatYuan('1'), '0.000001 元')
  })

  it('整数元补两位小数', () => {
    assert.equal(formatYuan('1000000'), '1.00 元')
    assert.equal(formatYuan('12000000'), '12.00 元')
  })

  it('六位精度不丢：1.234567', () => {
    assert.equal(formatYuan('1234567'), '1.234567 元')
  })

  it('浮点会算错的加法在这里逐位精确（1000001 微元 = 1.000001 元）', () => {
    assert.equal(formatYuan('1000001'), '1.000001 元')
    // 0.1 + 0.2 那种误差不会出现：这两笔合起来正好 0.000003 元
    assert.equal(formatYuan('3'), '0.000003 元')
  })

  it('余额允许为负（后付费欠费）', () => {
    assert.equal(formatYuan('-161'), '-0.000161 元')
    assert.equal(formatYuan('-1000000'), '-1.00 元')
  })

  it('千位分隔', () => {
    assert.equal(formatYuan('1000000000000'), '1,000,000.00 元')
  })

  it('非整数 / 空串一律「—」，不猜成 0', () => {
    for (const bad of ['', '  ', 'abc', '1.5', '1e6', null, undefined]) {
      assert.equal(formatYuan(bad as string | null | undefined), UNKNOWN_AMOUNT, `输入 ${String(bad)}`)
    }
  })
})

describe('formatCentsAsYuan（整数分）', () => {
  it('分 → 元，两位小数', () => {
    assert.equal(formatCentsAsYuan(0), '0.00')
    assert.equal(formatCentsAsYuan(1), '0.01')
    assert.equal(formatCentsAsYuan(123456), '1,234.56')
  })

  it('负数与精度', () => {
    assert.equal(formatCentsAsYuan(-161), '-1.61')
    assert.equal(formatCentsAsYuan(90071992547409), '900,719,925,474.09')
  })

  it('非有限数 → —', () => {
    assert.equal(formatCentsAsYuan(Number.NaN), UNKNOWN_AMOUNT)
    assert.equal(formatCentsAsYuan(null), UNKNOWN_AMOUNT)
  })
})

describe('formatTokens', () => {
  it('千位分隔', () => {
    assert.equal(formatTokens(0), '0')
    assert.equal(formatTokens(999), '999')
    assert.equal(formatTokens(1000), '1,000')
    assert.equal(formatTokens(1234567), '1,234,567')
  })

  it('非法输入 → —', () => {
    assert.equal(formatTokens(Number.NaN), UNKNOWN_AMOUNT)
    assert.equal(formatTokens(null), UNKNOWN_AMOUNT)
  })
})

describe('formatDurationMs / formatTtftMs', () => {
  it('小于 1 秒用毫秒', () => {
    assert.equal(formatDurationMs(0), '0 毫秒')
    assert.equal(formatDurationMs(999), '999 毫秒')
  })

  it('秒级保留最多两位小数，尾部零去掉', () => {
    assert.equal(formatDurationMs(1000), '1 秒')
    assert.equal(formatDurationMs(1234), '1.23 秒')
    assert.equal(formatDurationMs(1500), '1.5 秒')
    assert.equal(formatDurationMs(59_999), '60 秒')
  })

  it('TTFT 为 null 是「未采集」，不是 0 毫秒', () => {
    assert.equal(formatTtftMs(null), NOT_COLLECTED)
    assert.equal(formatTtftMs(undefined), NOT_COLLECTED)
    assert.equal(formatTtftMs(0), '0 毫秒')
    assert.equal(formatTtftMs(1500), '1.5 秒')
  })
})

describe('时间口径', () => {
  const iso = '2026-10-30T05:36:00.000Z'

  it('按指定时区渲染（UTC+8 是 13:36）', () => {
    assert.equal(formatDateTime(iso, 'Asia/Shanghai'), '2026-10-30 13:36')
    assert.equal(formatDateTime(iso, 'UTC'), '2026-10-30 05:36')
  })

  it('跨日：UTC 23:30 在上海是次日 07:30', () => {
    assert.equal(formatDateTime('2026-10-30T23:30:00.000Z', 'Asia/Shanghai'), '2026-10-31 07:30')
    assert.equal(formatDate('2026-10-30T23:30:00.000Z', 'Asia/Shanghai'), '2026-10-31')
  })

  it('非法 / 空 → —', () => {
    assert.equal(formatDateTime(''), '—')
    assert.equal(formatDateTime('not-a-date'), '—')
    assert.equal(formatDate(null), '—')
  })

  it('图表轴标签只切字符串，不经 Date（不会被时区挪一天）', () => {
    assert.equal(formatMonthDayLabel('2026-10-30'), '10/30')
    assert.equal(formatMonthDayLabel('2026-01-01'), '01/01')
  })
})

describe('formatPercent', () => {
  it('小数 → 百分比', () => {
    assert.equal(formatPercent(0.126), '12.6%')
    assert.equal(formatPercent(1), '100%')
    assert.equal(formatPercent(0), '0%')
  })

  it('非有限 → —', () => {
    assert.equal(formatPercent(Number.NaN), UNKNOWN_AMOUNT)
  })
})
