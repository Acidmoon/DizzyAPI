/**
 * 饼图纯逻辑的护栏：**占比是整数算出来的，不是浮点**。
 *
 * 三条要钉住的口径：
 * 1. **分母是服务端 totals**（不是「列表之和」）—— 列表可能有上限，用列表之和会让占比
 *    偷偷凑成 100%，而实际不是。
 * 2. **占比是万分比整数**、合计正好 10000（末项吃余数，不靠四舍五入凑）。
 * 3. **截断在服务端做**，前端不再归并：服务端给的 12 项（含「其他」）原样画。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as pieModule from '../app/src/lib/usage-pie.ts'
import type { PieGroup } from '../app/src/lib/usage-pie.ts'
import { unwrap } from './helpers/module-interop.ts'

const {
  PIE_COLORS,
  OTHER_LABEL,
  isSelectable,
  measureOf,
  microsOf,
  shareText,
  toPieSlices,
  userPieLabel,
} = unwrap<typeof pieModule>(pieModule)

function group(label: string, costMicros: string, tokens: number, requests = 1) {
  return { label, costMicros, tokens, requests }
}

describe('microsOf', () => {
  it('解析十进制微元字符串', () => {
    assert.equal(microsOf('1000000'), 1000000n)
    assert.equal(microsOf('0'), 0n)
    assert.equal(microsOf('-5'), -5n)
  })

  it('空值与非法值一律 0（不炸页面）', () => {
    assert.equal(microsOf(null), 0n)
    assert.equal(microsOf(undefined), 0n)
    assert.equal(microsOf(''), 0n)
    assert.equal(microsOf('1.5'), 0n)
    assert.equal(microsOf('abc'), 0n)
  })
})

describe('measureOf', () => {
  it('按费用口径取微元绝对值', () => {
    assert.equal(measureOf(group('a', '123', 9), 'cost'), 123n)
    assert.equal(measureOf(group('a', '-123', 9), 'cost'), 123n)
  })

  it('按 token 口径取 token（负数当 0）', () => {
    assert.equal(measureOf(group('a', '1', 42), 'tokens'), 42n)
    assert.equal(measureOf(group('a', '1', -5), 'tokens'), 0n)
  })
})

describe('toPieSlices：空数据', () => {
  it('没有分组 → 空数组（调用方画空态，不画空圆）', () => {
    assert.deepEqual(toPieSlices([], 'cost'), [])
  })

  it('全是 0 费用 → 空数组（0% 的扇区没有意义）', () => {
    assert.deepEqual(toPieSlices([group('a', '0', 0), group('b', '0', 0)], 'cost'), [])
  })
})

describe('toPieSlices：占比与排序', () => {
  it('按度量从大到小排，占比合计正好 10000', () => {
    const slices = toPieSlices(
      [group('small', '100', 1), group('big', '900', 9), group('mid', '0', 0)],
      'cost',
    )
    assert.deepEqual(slices.map((slice) => slice.label), ['big', 'small'])
    assert.equal(slices.reduce((sum, slice) => sum + slice.share, 0), 10000)
  })

  it('三分之一的三项：末项吃掉余数，合计仍是 10000', () => {
    const slices = toPieSlices(
      [group('a', '1', 1), group('b', '1', 1), group('c', '1', 1)],
      'cost',
    )
    assert.deepEqual(slices.map((slice) => slice.share), [3333, 3333, 3334])
    assert.equal(slices.reduce((sum, slice) => sum + slice.share, 0), 10000)
  })

  it('分母用服务端 totals：列表被截断时占比也不会凑成 100%', () => {
    // 服务端只给了前 1 项（100），但区间总额是 1000 → 占比 10%，不是 100%。
    const slices = toPieSlices([group('a', '100', 10)], 'cost', group('总计', '1000', 100))
    assert.equal(slices.length, 1)
    assert.equal(slices[0]?.share, 1000)
    assert.equal(shareText(slices[0]?.share ?? 0), '10.0%')
  })

  it('不传 totals 时退化成列表之和（只有「列表即全量」才该这么用）', () => {
    const slices = toPieSlices([group('a', '100', 10), group('b', '300', 30)], 'cost')
    assert.equal(slices[0]?.label, 'b')
    assert.equal(slices[0]?.share, 7500)
  })

  it('token 口径：按 token 排、按 token 算占比', () => {
    const slices = toPieSlices([group('cheap', '9999', 10), group('fat', '1', 90)], 'tokens')
    assert.equal(slices[0]?.label, 'fat')
    assert.equal(slices[0]?.share, 9000)
  })

  it('同度量按标签字典序，渲染稳定不闪', () => {
    const slices = toPieSlices([group('b', '5', 5), group('a', '5', 5)], 'cost')
    assert.deepEqual(slices.map((slice) => slice.label), ['a', 'b'])
  })
})

describe('toPieSlices：服务端已归并的结果原样画', () => {
  it('「其他」保留 other 标记，且不再被二次归并', () => {
    // 服务端给 12 项（11 具名 + 其他），前端不该再合并出第二个「其他」。
    const groups = [
      ...Array.from({ length: 11 }, (_, index) => group(`m${String(index)}`, String(100 - index), 10)),
      { ...group(OTHER_LABEL, '50', 5), other: true },
    ]
    const slices = toPieSlices(groups, 'cost', group('总计', '1000', 100))
    assert.equal(slices.length, 12)
    assert.equal(slices.filter((slice) => slice.other).length, 1)
    assert.equal(slices[11]?.label, OTHER_LABEL)
  })
})

describe('配色', () => {
  it('只走主题 CSS 变量，不硬编码十六进制', () => {
    assert.ok(PIE_COLORS.length > 0)
    for (const color of PIE_COLORS) {
      assert.ok(color.startsWith('var(--chart-'), `配色不是主题变量：${color}`)
    }
  })

  it('扇区颜色按顺序循环取，不越界', () => {
    const groups = Array.from({ length: PIE_COLORS.length + 2 }, (_, index) =>
      group(`m${String(index)}`, String(100 - index), 10),
    )
    const slices = toPieSlices(groups, 'cost')
    for (const slice of slices) {
      assert.ok(PIE_COLORS.includes(slice.color), `意外配色：${slice.color}`)
    }
  })
})

describe('shareText', () => {
  it('万分比 → 带一位小数的百分比', () => {
    assert.equal(shareText(10000), '100.0%')
    assert.equal(shareText(1234), '12.3%')
    assert.equal(shareText(0), '0.0%')
  })
})

describe('isSelectable：只有真实值能当筛选目标', () => {
  it('「其他」不可选 —— 拿它当筛选值查不到数据（按 key 还会静默清空筛选）', () => {
    assert.equal(isSelectable({ other: true }), false)
    // 服务端归并出来的那一项：扇区要画、图例要显示，但不能点。
    const slices = toPieSlices(
      [{ ...group(OTHER_LABEL, '100', 10), other: true }, group('real', '100', 10)],
      'cost',
    )
    const other = slices.filter((slice) => slice.other)
    assert.equal(other.length, 1)
    assert.equal(other.every((slice) => !isSelectable(slice)), true)
  })

  it('普通项可选；没有 other 标记的（老数据 / 别的来源）也当可选', () => {
    assert.equal(isSelectable({ other: false }), true)
    assert.equal(isSelectable({}), true)
  })
})

/**
 * 归并项的口径护栏（2026-10-31 真浏览器抓到的两个 bug 的回归用例）。
 *
 * 根因都是「用 label 是否为空判断归并项」：服务端对归并项只给**空名 + other 标志**，
 * 前端按空 label 丢弃 → 按接口饼图少一项、占比只剩 88%；按用户则漏出「用户 #-1」。
 */
describe('归并项：以 other 标志为准，不以「label 为空」为准', () => {
  /** 服务端 `topWithOther` 的超限产物：12 具名 + 1 归并项。 */
  function overflowGroups(otherLabel: string): readonly PieGroup[] {
    return [
      ...Array.from({ length: 12 }, (_, index) => group(`named-${String(index)}`, String(900 - index * 10), 90 - index)),
      { ...group(otherLabel, '80', 8), other: true },
    ]
  }

  it('空 label + other: true 的项必须保留，并渲染成「其他」', () => {
    const slices = toPieSlices(overflowGroups(''), 'cost')
    assert.equal(slices.length, 13, '归并项被空 label 丢掉了')
    const other = slices.filter((slice) => slice.other)
    assert.equal(other.length, 1)
    assert.equal(other[0]?.label, OTHER_LABEL)
    assert.equal(slices.some((slice) => slice.label === ''), false, '出现了空 label 的扇区')
  })

  it('三个维度超限归并后，占比合计正好 100.00%', () => {
    // 按模型：服务端标签就是「其他」；按接口：空名；按用户：userId -1 的归并项。
    const dimensions: Array<[string, readonly PieGroup[]]> = [
      ['按模型', overflowGroups(OTHER_LABEL)],
      ['按接口', overflowGroups('')],
    ]
    for (const [name, groups] of dimensions) {
      const slices = toPieSlices(groups, 'cost')
      assert.equal(slices.length, 13, `${name}：应有 12 具名 + 1 归并`)
      assert.equal(
        slices.reduce((sum, slice) => sum + slice.share, 0),
        10000,
        `${name}：占比合计不是 100%`,
      )
    }
  })
})

describe('userPieLabel：任何维度都不许出现「用户 #-1」', () => {
  it('other 标志 / 负 userId 都渲染成「其他」', () => {
    assert.equal(userPieLabel({ userId: -1, name: null, other: true }), OTHER_LABEL)
    // 只给负 id、没给标志也不能漏出去（防服务端字段缺失）
    assert.equal(userPieLabel({ userId: -1, name: null }), OTHER_LABEL)
    // 只给标志、id 是别的哨兵值同样不能漏
    assert.equal(userPieLabel({ userId: 999, name: null, other: true }), OTHER_LABEL)
  })

  it('正常用户用名字；没有名字才回落到「用户 #id」', () => {
    assert.equal(userPieLabel({ userId: 7, name: 'alice' }), 'alice')
    assert.equal(userPieLabel({ userId: 7, name: null }), '用户 #7')
    assert.equal(userPieLabel({ userId: 7, name: '   ' }), '用户 #7')
  })
})
