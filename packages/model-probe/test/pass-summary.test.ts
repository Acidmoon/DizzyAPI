/**
 * 归一化与汇总的护栏。
 *
 * 这些函数是所有读接口的门：模型名 / limit / actor 都从这里进。
 * 尤其是 `limit` 的默认值 —— 它必须**至少**覆盖 `failureThreshold` 那么多条，
 * 否则「连续失败 3 条判不可用」在只取 1 条的时候永远判不出来。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HEALTH_WINDOW_MIN,
  emptyPass,
  normalizeActor,
  normalizeLimit,
  normalizeModel,
  summarize,
} from '../src/pass-summary.ts'
import type { ModelProbeSample, ModelProbeStatus } from '../src/types.ts'

function sample(status: ModelProbeStatus): ModelProbeSample {
  return {
    model: 'm',
    status,
    latencyMs: status === 'probe-error' ? 0 : 100,
    httpStatus: null,
    errorCode: null,
    testedAtMs: 1,
  }
}

test('normalizeModel：trim 后非空，过长拒绝', () => {
  assert.equal(normalizeModel('  deepseek-flash  '), 'deepseek-flash')
  assert.throws(() => normalizeModel(''), /不能为空/)
  assert.throws(() => normalizeModel('   '), /不能为空/)
  assert.throws(() => normalizeModel(123), /必须是字符串/)
  assert.throws(() => normalizeModel('x'.repeat(201)), /最长 200/)
})

test('normalizeLimit：未给时用默认值，但至少覆盖健康度窗口', () => {
  assert.equal(normalizeLimit(undefined, 60), 60)
  // 配置把 historyPoints 调到 12 时，算健康度仍要看到 HANDLE_WINDOW_MIN 条。
  assert.equal(normalizeLimit(undefined, 12), HEALTH_WINDOW_MIN)
  assert.equal(normalizeLimit(100, 60), 100)
})

test('normalizeLimit：越界与非法类型拒绝', () => {
  assert.throws(() => normalizeLimit(0, 60), /1\.\.500/)
  assert.throws(() => normalizeLimit(501, 60), /1\.\.500/)
  assert.throws(() => normalizeLimit(1.5, 60), /1\.\.500/)
  assert.throws(() => normalizeLimit('10' as never, 60), /1\.\.500/)
})

test('normalizeActor：必须自报插件名', () => {
  assert.equal(normalizeActor('  @dizzyapi/plugin-api  '), '@dizzyapi/plugin-api')
  assert.throws(() => normalizeActor(''), /必须声明自己的插件名/)
  assert.throws(() => normalizeActor(undefined), /必须声明自己的插件名/)
  assert.throws(() => normalizeActor('x'.repeat(201)), /最长 200/)
})

test('summarize：四态各归各位', () => {
  const pass = summarize(
    [sample('ok'), sample('ok'), sample('degraded'), sample('failed'), sample('probe-error')],
    ['a', 'b'],
  )
  assert.equal(pass.probed, 5)
  assert.equal(pass.ok, 2)
  assert.equal(pass.degraded, 1)
  assert.equal(pass.failed, 1)
  assert.equal(pass.probeErrors, 1)
  assert.deepEqual(pass.models, ['a', 'b'])
  assert.equal(pass.skippedReason, null)
})

test('summarize：probed 用实际结果条数（中途卸载时和目标数会不一致）', () => {
  const pass = summarize([sample('ok')], ['a', 'b', 'c'])
  assert.equal(pass.probed, 1, '实际探了 1 个就报 1 个，不按目标数虚报')
})

test('emptyPass：一条请求都没发，skippedReason 说清为什么', () => {
  const pass = emptyPass('probe_key_secret_missing')
  assert.equal(pass.probed, 0)
  assert.equal(pass.failed, 0)
  assert.equal(pass.probeErrors, 0)
  assert.equal(pass.skippedReason, 'probe_key_secret_missing')
  assert.deepEqual(pass.models, [])
})
