/**
 * 探测库的护栏：写入 / 查询 / 日汇总 / 清理 / 小状态。
 *
 * 这些用例同时钉住两件事：
 * 1. 明细与日汇总在**同一个事务**里写、口径一致（否则小柱状图和长期可用率会互相矛盾）；
 * 2. 库里只存稳定原因码，**不存上游响应正文**（秘密与噪声都不该进库）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { openModelProbeDatabase } from '../src/db.ts'
import { ModelProbeStore } from '../src/store.ts'
import type { ModelProbeSample } from '../src/types.ts'

function freshStore(): ModelProbeStore {
  return new ModelProbeStore(openModelProbeDatabase(':memory:'))
}

function sample(overrides: Partial<ModelProbeSample> = {}): ModelProbeSample {
  return {
    model: 'deepseek-flash',
    status: 'ok',
    latencyMs: 120,
    httpStatus: 200,
    errorCode: null,
    testedAtMs: Date.parse('2026-10-31T00:00:00Z'),
    ...overrides,
  }
}

test('写入一条 ok：明细与日汇总同时更新', () => {
  const store = freshStore()
  const stored = store.record(sample())
  assert.equal(stored.model, 'deepseek-flash')
  assert.ok(stored.id > 0)

  assert.equal(store.count(), 1)
  const daily = store.daily('deepseek-flash', 7)
  assert.equal(daily.length, 1)
  assert.equal(daily[0].day, '2026-10-31')
  assert.equal(daily[0].totalChecks, 1)
  assert.equal(daily[0].okCount, 1)
  assert.equal(daily[0].sumLatencyMs, 120)
  assert.equal(daily[0].countLatency, 1)
})

test('四态分别累加到日汇总的对应计数', () => {
  const store = freshStore()
  const base = Date.parse('2026-10-31T00:00:00Z')
  store.record(sample({ testedAtMs: base }))
  store.record(sample({ status: 'degraded', latencyMs: 9_000, testedAtMs: base + 1 }))
  store.record(sample({ status: 'failed', httpStatus: 503, errorCode: 'MODEL_NOT_SERVED', testedAtMs: base + 2 }))
  store.record(sample({ status: 'probe-error', latencyMs: 0, httpStatus: 402, errorCode: 'INSUFFICIENT_BALANCE', testedAtMs: base + 3 }))

  const daily = store.daily('deepseek-flash', 7)[0]
  assert.equal(daily.totalChecks, 4)
  assert.equal(daily.okCount, 1)
  assert.equal(daily.degradedCount, 1)
  assert.equal(daily.failedCount, 1)
  assert.equal(daily.probeErrorCount, 1)
  // probe-error 的耗时与条数都不计入平均：它不是模型的耗时。
  // 其余三条（ok 120 + degraded 9000 + failed 120）都算。
  assert.equal(daily.countLatency, 3)
  assert.equal(daily.sumLatencyMs, 120 + 9_000 + 120)
})

test('recent 按时间倒序，且只给该模型的', () => {
  const store = freshStore()
  const base = Date.parse('2026-10-31T00:00:00Z')
  store.record(sample({ testedAtMs: base }))
  store.record(sample({ testedAtMs: base + 1000 }))
  store.record(sample({ model: 'other-model', testedAtMs: base + 2000 }))

  const points = store.recent('deepseek-flash', 10)
  assert.equal(points.length, 2)
  assert.equal(points[0].testedAtMs, base + 1000, '最新在前')
  assert.equal(points[1].testedAtMs, base)
  assert.equal(store.recent('deepseek-flash', 1).length, 1, 'limit 生效')
})

test('probedModels 去重并按最近探测排序', () => {
  const store = freshStore()
  const base = Date.parse('2026-10-31T00:00:00Z')
  store.record(sample({ model: 'a', testedAtMs: base }))
  store.record(sample({ model: 'b', testedAtMs: base + 5000 }))
  store.record(sample({ model: 'a', testedAtMs: base + 10_000 }))

  assert.deepEqual(store.probedModels(), ['a', 'b'])
})

test('prune 只删超期明细，日汇总原样保留', () => {
  const store = freshStore()
  const oldDay = Date.parse('2026-10-01T00:00:00Z')
  const newDay = Date.parse('2026-10-31T00:00:00Z')
  store.record(sample({ testedAtMs: oldDay }))
  store.record(sample({ testedAtMs: newDay }))

  const removed = store.prune(Date.parse('2026-10-15T00:00:00Z'))
  assert.equal(removed, 1)
  assert.equal(store.count(), 1)
  assert.equal(store.recent('deepseek-flash', 10).length, 1)
  // 日汇总不动：长期可用率窗口靠它。
  assert.equal(store.daily('deepseek-flash', 365).length, 2)
})

test('meta 键值可读可写（探测 key 的 id 靠它跨重启记住）', () => {
  const store = freshStore()
  assert.equal(store.getMeta('probeKeyId'), undefined)
  store.setMeta('probeKeyId', 'key-abc')
  assert.equal(store.getMeta('probeKeyId'), 'key-abc')
  store.setMeta('probeKeyId', 'key-def')
  assert.equal(store.getMeta('probeKeyId'), 'key-def', '重复写要覆盖而不是插入第二条')
})

test('未知状态拒绝写入（不静默存脏数据）', () => {
  const store = freshStore()
  assert.throws(
    () => store.record(sample({ status: 'bogus' as never })),
    /未知的探测状态/,
  )
  assert.equal(store.count(), 0)
})

test('库里只有原因码，不存响应正文', () => {
  const store = freshStore()
  store.record(sample({ status: 'failed', httpStatus: 503, errorCode: 'MODEL_NOT_SERVED' }))
  const points = store.recent('deepseek-flash', 10)
  assert.equal(points[0].errorCode, 'MODEL_NOT_SERVED')
  // 样本形状里根本没有「响应正文」这个字段：结构上就存不进正文。
  assert.deepEqual(
    Object.keys(points[0]).sort(),
    ['errorCode', 'httpStatus', 'id', 'latencyMs', 'model', 'status', 'testedAtMs'],
  )
})
