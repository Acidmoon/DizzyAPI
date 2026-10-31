/**
 * 探测事实 → 目录视图的护栏（纯逻辑，不碰 cordis）。
 *
 * 这组用例护的是**判定权归 modelhub** 和**停摆不判死**两条：
 * - 阈值来自 modelhub 自己的配置，不是探测插件的；
 * - 探测停摆（余额不足 / key 失效 / 连不上网关）时，一律 `unknown`，绝不 `down`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NO_PROBE_FACTS,
  collectProbeFacts,
  judgeHealth,
  probeViewOf,
  type ModelProbeHistorySeam,
  type ModelProbeSeam,
  type ModelProbeStatusSeam,
} from '../src/probe-facts.ts'
import type { ModelProbePointView } from '../src/types.ts'

function point(status: ModelProbePointView['status'], testedAtMs = 1_000): ModelProbePointView {
  return { status, latencyMs: status === 'probe-error' ? 0 : 120, httpStatus: null, errorCode: null, testedAtMs }
}

function history(overrides: Partial<ModelProbeHistorySeam> = {}): ModelProbeHistorySeam {
  return {
    model: 'm',
    points: [point('ok')],
    consecutiveFailures: 0,
    lastOkAtMs: 1_000,
    lastTestedAtMs: 1_000,
    ...overrides,
  }
}

function status(overrides: Partial<ModelProbeStatusSeam> = {}): ModelProbeStatusSeam {
  return {
    enabled: true,
    running: false,
    probeKeyConfigured: true,
    blockedReason: null,
    blockedDetail: null,
    lastPassAt: '2026-10-31T00:00:00.000Z',
    ...overrides,
  }
}

/** 造一个只回答固定事实的探测服务替身。 */
function fakeProbe(histories: ModelProbeHistorySeam[], probeStatus = status()): ModelProbeSeam {
  return { histories: () => histories, status: () => probeStatus }
}

test('最新 ok → up；最新 degraded → degraded', () => {
  const base = { stalled: false, failureThreshold: 3 }
  assert.equal(judgeHealth({ points: [point('ok')], consecutiveFailures: 0, ...base }), 'up')
  assert.equal(judgeHealth({ points: [point('degraded')], consecutiveFailures: 0, ...base }), 'degraded')
})

test('连续 failed 达到阈值 → down；未达阈值 → degraded', () => {
  const base = { stalled: false, failureThreshold: 3 }
  assert.equal(judgeHealth({ points: [point('failed')], consecutiveFailures: 3, ...base }), 'down')
  assert.equal(judgeHealth({ points: [point('failed')], consecutiveFailures: 2, ...base }), 'degraded')
})

test('【判定权护栏】阈值来自 modelhub 的配置：同一个 consecutiveFailures 在不同阈值下结论不同', () => {
  const points = [point('failed')]
  assert.equal(judgeHealth({ points, consecutiveFailures: 2, stalled: false, failureThreshold: 2 }), 'down')
  assert.equal(judgeHealth({ points, consecutiveFailures: 2, stalled: false, failureThreshold: 3 }), 'degraded')
})

test('【停摆护栏】停摆时一律 unknown，哪怕连续失败很多条', () => {
  const health = judgeHealth({
    points: [point('failed')],
    consecutiveFailures: 99,
    stalled: true,
    failureThreshold: 3,
  })
  assert.equal(health, 'unknown', '探测没在跑时不能判模型挂了')
})

test('【假红护栏】最新一条是 probe-error → unknown，即使连续失败已达阈值', () => {
  const health = judgeHealth({
    points: [point('probe-error')],
    consecutiveFailures: 5,
    stalled: false,
    failureThreshold: 3,
  })
  assert.equal(health, 'unknown')
})

test('没有点 → unknown（不是 down）', () => {
  assert.equal(
    judgeHealth({ points: [], consecutiveFailures: 0, stalled: false, failureThreshold: 3 }),
    'unknown',
  )
})

test('probeViewOf 原样带出事实，并把状态折成四态', () => {
  const view = probeViewOf(
    history({
      points: [point('ok', 300), { ...point('failed', 200), errorCode: 'MODEL_NOT_SERVED' }, point('ok', 100)],
      consecutiveFailures: 0,
      lastOkAtMs: 300,
      lastTestedAtMs: 300,
    }),
    { stalled: false, failureThreshold: 3 },
  )
  assert.equal(view.probed, true)
  assert.equal(view.health, 'up')
  assert.equal(view.points.length, 3)
  assert.equal(view.points[1].errorCode, 'MODEL_NOT_SERVED')
  assert.equal(view.lastOkAtMs, 300)
})

test('probeViewOf：脏状态折成 failed（不把读不出来的当成好的）', () => {
  const view = probeViewOf(history({ points: [{ ...point('ok'), status: 'bogus' as never }] }), {
    stalled: false,
    failureThreshold: 3,
  })
  assert.equal(view.points[0].status, 'failed')
})

test('collectProbeFacts：正常时按模型建索引，并统计 down 数', () => {
  const facts = collectProbeFacts({
    probe: fakeProbe([
      history({ model: 'good' }),
      history({ model: 'bad', points: [point('failed')], consecutiveFailures: 5, lastOkAtMs: null }),
    ]),
    historyPoints: 24,
    failureThreshold: 3,
  })

  assert.equal(facts.healthy, true)
  assert.equal(facts.byModel.get('good')?.health, 'up')
  assert.equal(facts.byModel.get('bad')?.health, 'down')
  assert.equal(facts.summary.downCount, 1)
  assert.equal(facts.summary.failureThreshold, 3)
})

test('collectProbeFacts：blockedReason 非空 → 全部 unknown、healthy=false', () => {
  const facts = collectProbeFacts({
    probe: fakeProbe(
      [history({ model: 'x', points: [point('failed')], consecutiveFailures: 9, lastOkAtMs: null })],
      status({ blockedReason: 'probe_user_balance_exhausted', blockedDetail: '余额不足' }),
    ),
    historyPoints: 24,
    failureThreshold: 3,
  })

  assert.equal(facts.healthy, false)
  assert.equal(facts.byModel.get('x')?.health, 'unknown', '停摆时不能给出 down')
  assert.equal(facts.summary.downCount, 0)
  assert.equal(facts.summary.blockedReason, 'probe_user_balance_exhausted')
})

test('collectProbeFacts：探测被禁用 → 不读历史，byModel 为空', () => {
  let asked = false
  const facts = collectProbeFacts({
    probe: {
      histories: () => {
        asked = true
        return []
      },
      status: () => status({ enabled: false }),
    },
    historyPoints: 24,
    failureThreshold: 3,
  })
  assert.equal(asked, false, '禁用时不该再去读历史')
  assert.equal(facts.byModel.size, 0)
  assert.equal(facts.summary.enabled, false)
})

test('collectProbeFacts：探测 key 没配 → healthy=false（数据不可信）', () => {
  const facts = collectProbeFacts({
    probe: fakeProbe([], status({ probeKeyConfigured: false })),
    historyPoints: 24,
    failureThreshold: 3,
  })
  assert.equal(facts.healthy, false)
})

test('collectProbeFacts：探测服务抛错 → 降级成空事实，不抛给调用方', () => {
  const facts = collectProbeFacts({
    probe: {
      histories: () => {
        throw new Error('boom')
      },
      status: () => {
        throw new Error('boom')
      },
    },
    historyPoints: 24,
    failureThreshold: 3,
  })
  assert.equal(facts, NO_PROBE_FACTS)
})

test('collectProbeFacts：只有 histories 抛错时仍出状态，只是没有条目数据', () => {
  const facts = collectProbeFacts({
    probe: {
      histories: () => {
        throw new Error('boom')
      },
      status: () => status(),
    },
    historyPoints: 24,
    failureThreshold: 3,
  })
  assert.equal(facts.byModel.size, 0)
  assert.equal(facts.healthy, true)
})
