/**
 * 模型广场「可用性小柱状图」的护栏（纯逻辑 + 源码两条线）。
 *
 * 用真浏览器断言太慢、也不适合进 `pnpm test`，但这两类问题是「原则性问题」，
 * 文本断言足够挡住回归：
 *
 * 1. **假红**：`probe-error`（探测自己没测出来）绝不能画成 `failed` 那样红；
 * 2. **方向**：最右必须是「现在」（服务端给的是最新在前，图上要反过来）；
 * 3. **补灰**：点数不足时左侧补占位，不是右侧 —— 右侧是「现在」，补错了等于把旧数据当新数据；
 * 4. **停摆提示**：`blockedReason` 非空时必须给 `danger` 级提示，且文案里必须写清
 *    「这不是模型故障」；
 * 5. **CSP**：组件里不许注入 `<style>`、不许硬编码颜色（配色只走 CSS 变量）。
 */
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import * as probeModule from '../app/src/lib/model-probe.ts'
import { unwrap } from './helpers/module-interop.ts'

const probe = unwrap<typeof probeModule>(probeModule)
const {
  PROBE_BAR_MAX_SLOTS,
  PROBE_BAR_MIN_SLOTS,
  PROBE_BAR_SLOTS,
  clampProbeSlots,
  normalizePointStatus,
  probeBars,
  probeFailureText,
  probeHealthText,
  probeHealthTone,
  probeNoticeOf,
  probePointText,
  probeSummaryText,
  tallyProbePoints,
} = probe

const here = dirname(fileURLToPath(import.meta.url))
const userRoot = resolve(here, '../app/src/app/(main)/user')

interface Point {
  readonly status: string
  readonly latencyMs: number
  readonly httpStatus: number | null
  readonly errorCode: string | null
  readonly testedAtMs: number
}

/** 造点：`testedAtMs` 越大越新（服务端给的是最新在前）。 */
function point(status: string, testedAtMs: number): Point {
  return { status, latencyMs: 120, httpStatus: status === 'ok' ? 200 : 503, errorCode: null, testedAtMs }
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    running: false,
    blockedReason: null as string | null,
    blockedDetail: null as string | null,
    lastPassAt: '2026-10-31T13:00:00.000Z' as string | null,
    failureThreshold: 3,
    downCount: 0,
    ...overrides,
  }
}

describe('probeBars：最右是「现在」，左侧补灰', () => {
  it('把最新在前翻成从左（旧）到右（新）', () => {
    // 服务端顺序：最新（t3000, failed）在前。
    const bars = probeBars([point('failed', 3000), point('degraded', 2000), point('ok', 1000)], 8)
    assert.equal(bars.length, 8)
    assert.ok(
      bars.slice(0, 5).every((bar) => bar.placeholder),
      '最早那 5 个时刻还没数据 → 左侧补灰',
    )
    assert.deepEqual(
      bars.slice(5).map((bar) => bar.status),
      ['ok', 'degraded', 'failed'],
      '左边是 1000 的旧点，右边是 3000 的新点',
    )
    assert.equal(bars[7].key, 't3000', '最右那根就是「现在」')
  })

  it('点数超过槽位时留最近的，丢掉最老的', () => {
    // 10 个点、只要 8 个槽位（下限就是 8）：留最近 8 个，最老的两个被丢掉。
    const points = Array.from({ length: 10 }, (_, index) => point('ok', 10_000 - index * 1_000))
    const bars = probeBars(points, 8)
    assert.equal(bars.length, 8)
    assert.equal(bars[0].key, 't3000', '最左那根是最早保留下来的（t3000）')
    assert.equal(bars[7].key, 't10000', '最右那根还是「现在」')
  })

  it('没有点时全是占位，且不会被误当成失败', () => {
    const bars = probeBars([], 8)
    assert.equal(bars.length, 8)
    assert.ok(bars.every((bar) => bar.placeholder && bar.status === null))
    assert.equal(bars[0].color, 'var(--muted)')
  })

  it('槽位数被夹在上下限之间', () => {
    assert.equal(clampProbeSlots(undefined), PROBE_BAR_SLOTS)
    assert.equal(clampProbeSlots(Number.NaN), PROBE_BAR_SLOTS)
    assert.equal(clampProbeSlots(1), PROBE_BAR_MIN_SLOTS)
    assert.equal(clampProbeSlots(9999), PROBE_BAR_MAX_SLOTS)
    assert.equal(clampProbeSlots(24.9), 24)
  })
})

describe('四态：高度 + 形态 + 颜色三层编码，且不制造假红', () => {
  const heights = ['ok', 'degraded', 'probe-error', 'failed'].map((status) => {
    const bars = probeBars([point(status, 1000)], 8)
    assert.equal(bars.length, 8)
    const last = bars[bars.length - 1]
    assert.ok(last !== undefined)
    return last
  })

  it('高度按健康序单调递减（越高越健康）', () => {
    const values = heights.map((bar) => bar.heightPercent)
    assert.deepEqual(values, [100, 65, 35, 15])
    for (let index = 1; index < values.length; index += 1) {
      assert.ok((values[index] as number) < (values[index - 1] as number), '高度必须严格递减')
    }
  })

  it('只有 failed 用红色（--destructive），探测自身异常绝不用红', () => {
    const [ok, degraded, probeError, failed] = heights
    assert.equal((ok as { color: string }).color, 'var(--chart-3)')
    assert.equal((degraded as { color: string }).color, 'var(--chart-2)')
    assert.equal((probeError as { color: string }).color, 'var(--muted-foreground)')
    assert.equal((failed as { color: string }).color, 'var(--destructive)')
    assert.notEqual(
      (probeError as { color: string }).color,
      (failed as { color: string }).color,
      'probe-error 与 failed 同色就是假红',
    )
  })

  /**
   * 2026-10-31 真机验收抓到的回归：`probe-error` 原来用 `--chart-1`，灰阶主题下
   * 白底对比度 1.3:1，和 `--muted` 的补灰占位肉眼分不开 —— 状态**隐身**。
   * 修法不是换一档颜色（配色一改又失效），而是加**形态编码**：空心描边。
   */
  it('探测自身异常是空心描边，占位与其余三态都是实心（形状与配色无关）', () => {
    const [ok, degraded, probeError, failed] = heights
    assert.equal((probeError as { shape: string }).shape, 'hollow')
    for (const bar of [ok, degraded, failed]) {
      assert.equal((bar as { shape: string }).shape, 'solid')
    }
    const placeholder = probeBars([], 8)[0]
    assert.ok(placeholder !== undefined)
    assert.equal(placeholder.shape, 'solid', '补灰占位必须是实心，否则和空心柱撞形状')
    assert.notEqual(
      (probeError as { color: string }).color,
      placeholder.color,
      'probe-error 与占位不能同色（那就又分不开了）',
    )
    assert.notEqual(
      (probeError as { color: string }).color,
      'var(--chart-1)',
      '--chart-1 在灰阶主题里几乎不可见，不许再用于这一档',
    )
  })

  it('配色只走主题变量，不是十六进制', () => {
    for (const bar of heights) {
      assert.match((bar as { color: string }).color, /^var\(--[a-z0-9-]+\)$/)
    }
  })

  it('未知状态串折成 probe-error（读不出来不等于模型挂了）', () => {
    assert.equal(normalizePointStatus('ok'), 'ok')
    assert.equal(normalizePointStatus('wat'), 'probe-error')
    assert.equal(normalizePointStatus(''), 'probe-error')
    assert.equal(probePointText('wat'), probePointText('probe-error'))
  })
})

describe('健康度与统计文案', () => {
  it('四态都有中文，未知码原样带出（不猜）', () => {
    assert.equal(probeHealthText('up'), '正常')
    assert.equal(probeHealthText('degraded'), '抖动')
    assert.equal(probeHealthText('down'), '连续失败')
    assert.equal(probeHealthText('unknown'), '未知')
    assert.equal(probeHealthText('weird'), 'weird')
  })

  it('unknown 是 muted，不是 danger（停摆时给红就又假红了）', () => {
    assert.equal(probeHealthTone('up'), 'ok')
    assert.equal(probeHealthTone('degraded'), 'warn')
    assert.equal(probeHealthTone('down'), 'danger')
    assert.equal(probeHealthTone('unknown'), 'muted')
    assert.notEqual(probeHealthTone('unknown'), 'danger')
  })

  it('统计句只数事实，不下结论', () => {
    const tally = tallyProbePoints([point('ok', 4), point('ok', 3), point('degraded', 2), point('probe-error', 1)])
    assert.deepEqual(tally, { total: 4, ok: 2, degraded: 1, failed: 0, probeError: 1 })
    const text = probeSummaryText([point('ok', 4), point('failed', 3), point('probe-error', 2)])
    assert.equal(text, '最近 3 次探测：1 次正常、1 次失败、1 次探测自身异常')
    assert.equal(probeSummaryText([]), '还没有探测数据')
  })

  it('连续失败的小字随阈值变化', () => {
    assert.equal(probeFailureText(0, 3), null)
    assert.equal(probeFailureText(2, 3), '连续失败 2 次')
    assert.equal(probeFailureText(3, 3), '已连续失败 3 次')
    // 脏数据（负值 / 阈值 0）不炸也不显示负数
    assert.equal(probeFailureText(-5, 0), null)
    assert.equal(probeFailureText(1, 0), '已连续失败 1 次')
  })
})

describe('probeNoticeOf：停摆必须显眼', () => {
  it('正常时什么都不显示（不占版面）', () => {
    assert.equal(probeNoticeOf(undefined), null)
    assert.equal(probeNoticeOf(summary()), null)
  })

  it('余额不足 → danger，且明写「这不是模型故障」', () => {
    const notice = probeNoticeOf(summary({ blockedReason: 'probe_user_balance_exhausted' }))
    assert.ok(notice !== null)
    assert.equal(notice.tone, 'danger')
    assert.equal(notice.title, '模型探测已停摆')
    assert.match(notice.description, /余额不足/)
    assert.match(notice.description, /这不是模型故障/)
  })

  it('其余停摆原因也给 danger，且都带「不是模型故障」', () => {
    for (const reason of [
      'probe_key_rejected',
      'probe_key_secret_missing',
      'probe_user_unavailable',
      'gateway_unreachable',
    ]) {
      const notice = probeNoticeOf(summary({ blockedReason: reason }))
      assert.ok(notice !== null, `${reason} 没给提示`)
      assert.equal(notice.tone, 'danger')
      assert.match(notice.description, /这不是模型故障/, `${reason} 的文案没写清不是模型故障`)
    }
  })

  it('未知停摆码原样带出，不当成正常', () => {
    const notice = probeNoticeOf(summary({ blockedReason: 'something_new' }))
    assert.ok(notice !== null)
    assert.equal(notice.tone, 'danger')
    assert.match(notice.description, /something_new/)
  })

  it('没启用 / 第一轮没跑完只说状态，不制造紧张感', () => {
    const off = probeNoticeOf(summary({ enabled: false }))
    assert.ok(off !== null)
    assert.equal(off.tone, 'muted')
    assert.equal(off.title, '模型探测已关闭')

    const first = probeNoticeOf(summary({ lastPassAt: null, running: true }))
    assert.ok(first !== null)
    assert.equal(first.tone, 'muted')

    const idle = probeNoticeOf(summary({ lastPassAt: null, running: false }))
    assert.ok(idle !== null)
    assert.equal(idle.tone, 'muted')
  })

  it('停摆优先于「没启用」：两个条件同时成立时说停摆', () => {
    const notice = probeNoticeOf(summary({ enabled: false, blockedReason: 'probe_key_rejected' }))
    assert.ok(notice !== null)
    assert.equal(notice.tone, 'danger')
  })
})

describe('源码护栏：CSP 与配色', () => {
  const files = ['_components/model-probe-bars.tsx', '_components/model-probe-notice.tsx'] as const

  /** 去掉注释（护栏约束代码，不是文案）。 */
  function readCode(relative: string): string {
    return readFileSync(join(userRoot, relative), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  }

  it('不注入 <style>、不写 style 标签（CSP 只放行两个 sha256）', () => {
    for (const file of files) {
      const code = readCode(file)
      for (const forbidden of ['<style', 'createElement("style"', "createElement('style'", 'insertRule']) {
        assert.ok(!code.includes(forbidden), `${file} 注入了样式表：${forbidden}`)
      }
    }
  })

  it('不硬编码颜色（配色一律走 CSS 变量 / Tailwind token）', () => {
    for (const file of files) {
      const code = readCode(file)
      assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(code), false, `${file} 里有十六进制颜色`)
      assert.equal(/rgb\(|rgba\(|hsl\(/.test(code), false, `${file} 里有字面量颜色函数`)
    }
  })

  it('空心柱真的画了描边（形态编码不许被当成装饰删掉）', () => {
    const code = readCode('_components/model-probe-bars.tsx')
    for (const token of ['bar.shape === "hollow"', 'borderColor', 'borderWidth', 'transparent']) {
      assert.ok(code.includes(token), `柱状图没把空心形态画出来：${token}`)
    }
    // 反向：不许在组件里按状态名写死颜色（配色只许来自 lib 里的样式表）。
    assert.ok(!code.includes('--destructive'), '组件里不该出现具体颜色变量，配色只在 lib/model-probe.ts')
  })

  it('柱状图组件不自己算钱、不自己格式化时间', () => {
    const code = readCode('_components/model-probe-bars.tsx')
    assert.ok(code.includes('@/lib/format'), '时间格式化必须走 @/lib/format 的唯一源')
    for (const forbidden of ['toFixed(', 'Intl.DateTimeFormat']) {
      assert.ok(!code.includes(forbidden), `柱状图自己格式化时间：${forbidden}`)
    }
  })
})
