/**
 * 价格换算的纯函数用例：十进制「元」↔ 整数微元，以及按 token 计价。
 *
 * 金额铁律：全程 BigInt，不出现浮点；四舍五入只在最后一次除法发生。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MICROS_PER_YUAN,
  TOKENS_PER_PRICE_UNIT,
  formatMicrosAsYuan,
  normalizeYuan,
  parseYuanToMicros,
  priceOfModel,
  quoteMicrosOf,
  quoteMicrosOfPrice,
} from '../src/money.ts'
import type { ModelPrice, TokenCounts } from '../src/types.ts'

function price(overrides: Partial<ModelPrice> = {}): ModelPrice {
  return {
    model: 'test-model',
    inputPerMillion: '1',
    outputPerMillion: '2',
    cacheReadPerMillion: '0',
    cacheWritePerMillion: '0',
    currency: 'CNY',
    updatedAt: '2026-10-21T00:00:00.000Z',
    ...overrides,
  }
}

function tokens(overrides: Partial<TokenCounts> = {}): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  }
}

test('常量：1 元 = 1_000_000 微元，单价按百万 token', () => {
  assert.equal(MICROS_PER_YUAN, 1_000_000n)
  assert.equal(TOKENS_PER_PRICE_UNIT, 1_000_000n)
})

test('parseYuanToMicros：合法输入（表驱动）', () => {
  const cases: readonly [string | number, bigint][] = [
    ['0', 0n],
    ['1', 1_000_000n],
    ['3.75', 3_750_000n],
    ['3.750000', 3_750_000n],
    ['0.000001', 1n],
    ['12.5', 12_500_000n],
    ['0012.500000', 12_500_000n],
    ['  8.25  ', 8_250_000n],
    ['', 0n],
    [0, 0n],
    [3.75, 3_750_000n],
    [12, 12_000_000n],
  ]
  for (const [input, expected] of cases) {
    assert.equal(parseYuanToMicros(input), expected, `输入 ${JSON.stringify(input)}`)
  }
})

test('parseYuanToMicros：负数、科学计数法、超过 6 位小数与垃圾输入都明确报错', () => {
  const invalid: readonly (string | number)[] = [
    '-1',
    -1,
    '1e3',
    1e-7,
    '3.1234567',
    '0.0000001',
    'abc',
    '3.',
    '.5',
    '1 000',
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]
  for (const input of invalid) {
    assert.throws(() => parseYuanToMicros(input), TypeError, `输入 ${String(input)} 必须被拒绝`)
  }
})

test('normalizeYuan：去掉前导零与末尾零，0 保持 "0"', () => {
  const cases: readonly [string | number, string][] = [
    ['0', '0'],
    ['0.000000', '0'],
    ['3.750000', '3.75'],
    ['0012.500000', '12.5'],
    ['1.000000', '1'],
    ['0.000001', '0.000001'],
    [2.5, '2.5'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeYuan(input), expected, `输入 ${JSON.stringify(input)}`)
  }
  assert.throws(() => normalizeYuan('1.1234567'), TypeError)
})

test('formatMicrosAsYuan：整数微元还原成十进制字符串', () => {
  const cases: readonly [bigint, string][] = [
    [0n, '0'],
    [1n, '0.000001'],
    [999_999n, '0.999999'],
    [1_000_000n, '1'],
    [3_750_000n, '3.75'],
    [10_000_000n, '10'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(formatMicrosAsYuan(input), expected)
  }
  assert.throws(() => formatMicrosAsYuan(-1n), TypeError)
})

test('quoteMicrosOfPrice：四个 token 桶分别按各自单价计费', () => {
  const quoted = quoteMicrosOfPrice(
    price({
      inputPerMillion: '1',
      outputPerMillion: '2',
      cacheReadPerMillion: '4',
      cacheWritePerMillion: '8',
    }),
    tokens({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    }),
  )
  // 1 + 2 + 4 + 8 = 15 元 = 15_000_000 微元。
  assert.equal(quoted, 15_000_000n)
})

test('quoteMicrosOfPrice：只做一次除法，按微元四舍五入', () => {
  // 0.000001 元 / 百万 token = 1 微元 / 百万 token。
  const tiny = price({ inputPerMillion: '0.000001' })
  assert.equal(quoteMicrosOfPrice(tiny, tokens({ inputTokens: 1 })), 0n, '0.000001 微元舍去')
  assert.equal(quoteMicrosOfPrice(tiny, tokens({ inputTokens: 500_000 })), 1n, '0.5 微元进位')

  // 1 元 / 百万 token、1 个 token = 1 微元。
  assert.equal(quoteMicrosOfPrice(price({ inputPerMillion: '1' }), tokens({ inputTokens: 1 })), 1n)
  // 负 token 数按 0 处理，不会变成负费用。
  assert.equal(quoteMicrosOfPrice(price(), tokens({ inputTokens: -100 })), 0n)
})

test('quoteMicrosOfPrice：超大数字不溢出（BigInt）', () => {
  const quoted = quoteMicrosOfPrice(
    price({ inputPerMillion: '1000000000000' }),
    tokens({ inputTokens: 1_000_000_000 }),
  )
  // 1e12 元/M × 1e9 token = 1e21 微元，远超 Number 的安全整数范围。
  assert.equal(quoted, 1_000_000_000_000_000_000_000n)
  assert.ok(quoted > BigInt(Number.MAX_SAFE_INTEGER))
})

test('quoteMicrosOf / priceOfModel：精确名优先，其次 *，都没有就是 0 且 priceOfModel 为 null', () => {
  const table = new Map<string, ModelPrice>([
    ['*', price({ model: '*', inputPerMillion: '2' })],
    ['exact', price({ model: 'exact', inputPerMillion: '1' })],
  ])
  const usage = tokens({ inputTokens: 1_000_000 })

  assert.equal(quoteMicrosOf(table, 'exact', usage), 1_000_000n, '精确条目优先于兜底')
  assert.equal(quoteMicrosOf(table, 'unknown', usage), 2_000_000n, '没有精确条目时用 *')
  assert.equal(priceOfModel(table, 'exact')?.model, 'exact')
  assert.equal(priceOfModel(table, 'unknown')?.model, '*')

  const empty = new Map<string, ModelPrice>()
  assert.equal(quoteMicrosOf(empty, 'anything', usage), 0n)
  assert.equal(priceOfModel(empty, 'anything'), null)
})
