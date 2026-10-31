/**
 * 健康度派生的护栏。
 *
 * 核心不变量：**探测自身出问题时不给模型下结论**。
 * 最新一条是 `probe-error` → `unknown`，绝不能是 `down`。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveHealth, passIsUntrustworthy } from '../src/health.ts'
import type { ModelProbeSampleRow, ModelProbeStatus } from '../src/types.ts'

let nextId = 1

/** 造一条样本（最新在前，所以调用时按从新到旧的顺序给）。 */
function row(status: ModelProbeStatus, testedAtMs: number, errorCode: string | null = null): ModelProbeSampleRow {
  return {
    id: nextId++,
    model: 'm',
    status,
    latencyMs: status === 'probe-error' ? 0 : 120,
    httpStatus: status === 'ok' ? 200 : null,
    errorCode,
    testedAtMs,
  }
}

test('没有样本 → unknown', () => {
  const result = deriveHealth([], 3)
  assert.equal(result.health, 'unknown')
  assert.equal(result.consecutiveFailures, 0)
  assert.equal(result.lastOkAtMs, null)
  assert.equal(result.lastTestedAtMs, null)
})

test('最新是 ok → up', () => {
  const result = deriveHealth([row('ok', 1000)], 3)
  assert.equal(result.health, 'up')
  assert.equal(result.consecutiveFailures, 0)
  assert.equal(result.lastOkAtMs, 1000)
})

test('最新是 degraded → degraded', () => {
  const result = deriveHealth([row('degraded', 1000)], 3)
  assert.equal(result.health, 'degraded')
  assert.equal(result.lastOkAtMs, 1000)
})

test('连续 failed 达到阈值 → down', () => {
  const result = deriveHealth([row('failed', 3000), row('failed', 2000), row('failed', 1000)], 3)
  assert.equal(result.health, 'down')
  assert.equal(result.consecutiveFailures, 3)
})

test('连续 failed 未达阈值 → degraded（还在抖，不判死）', () => {
  const result = deriveHealth([row('failed', 2000), row('failed', 1000), row('ok', 500)], 3)
  assert.equal(result.health, 'degraded')
  assert.equal(result.consecutiveFailures, 2)
  assert.equal(result.lastOkAtMs, 500)
})

test('ok 会打断连续失败计数', () => {
  const result = deriveHealth([row('ok', 3000), row('failed', 2000), row('failed', 1000)], 3)
  assert.equal(result.health, 'up')
  assert.equal(result.consecutiveFailures, 0)
})

test('【假红护栏】最新是 probe-error → unknown，绝不是 down', () => {
  // 即使前面已经连续失败好几次，只要最新一条是探测自身问题，就不能下「挂了」的结论。
  const result = deriveHealth(
    [row('probe-error', 4000, 'INSUFFICIENT_BALANCE'), row('failed', 3000), row('failed', 2000)],
    3,
  )
  assert.equal(result.health, 'unknown', '探测自身出问题时必须给 unknown，不能给 down')
  assert.equal(result.consecutiveFailures, 0, 'probe-error 要打断连续失败计数')
})

test('【假红护栏】probe-error 不累加连续失败', () => {
  const result = deriveHealth(
    [row('failed', 3000), row('probe-error', 2000, 'INSUFFICIENT_BALANCE'), row('failed', 1000)],
    3,
  )
  assert.equal(result.consecutiveFailures, 1, '连续的 failed 被 probe-error 打断后只剩 1 条')
  assert.equal(result.health, 'degraded')
})

test('阈值 1：一条 failed 就 down', () => {
  const result = deriveHealth([row('failed', 1000)], 1)
  assert.equal(result.health, 'down')
})

test('lastOkAtMs 取最近一条 ok 或 degraded', () => {
  const result = deriveHealth([row('failed', 3000), row('degraded', 2000), row('ok', 1000)], 5)
  assert.equal(result.lastOkAtMs, 2000)
})

test('passIsUntrustworthy：过半 probe-error 才不可信', () => {
  assert.equal(passIsUntrustworthy(0, 10), false)
  assert.equal(passIsUntrustworthy(5, 10), false, '正好一半不算过半')
  assert.equal(passIsUntrustworthy(6, 10), true)
  assert.equal(passIsUntrustworthy(1, 3), false)
  assert.equal(passIsUntrustworthy(2, 3), true)
  assert.equal(passIsUntrustworthy(0, 0), false, '一个都没探不该判不可信')
})
