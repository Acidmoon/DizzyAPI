/**
 * 配置校验的护栏。
 *
 * 重点是「非法配置必须装载就失败」：探测间隔填错、`probeUserId` 没写，
 * 都会让探测要么变成忙等、要么根本发不出去；而这两种状态在页面上
 * 和「模型全挂了」长得一模一样。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { MODEL_PROBE_DEFAULTS, validateModelProbeConfig } from '../src/config.ts'
import { isIssueList } from '@dizzyapi/plugin-kit'

function ok(value: unknown) {
  const result = validateModelProbeConfig(value)
  assert.ok(!isIssueList(result), `应通过校验，实际报错：${isIssueList(result) ? JSON.stringify(result) : ''}`)
  return result
}

function bad(value: unknown, matcher: RegExp) {
  const result = validateModelProbeConfig(value)
  assert.ok(isIssueList(result), '应被拒绝')
  assert.match(result.map((item) => item.message).join('；'), matcher)
}

test('最小可用配置：只给 probeUserId，其余走默认值', () => {
  const resolved = ok({ probeUserId: 1 })
  assert.equal(resolved.probeUserId, 1)
  assert.equal(resolved.enabled, MODEL_PROBE_DEFAULTS.enabled)
  assert.equal(resolved.intervalMs, 300_000)
  assert.equal(resolved.timeoutMs, 15_000)
  assert.equal(resolved.degradedThresholdMs, 6_000)
  assert.equal(resolved.failureThreshold, 3)
  assert.equal(resolved.historyPoints, 60)
  assert.equal(resolved.retentionDays, 7)
  assert.equal(resolved.gatewayBaseUrl, 'http://127.0.0.1:8080')
  assert.deepEqual(resolved.probeModels, [])
})

test('probeUserId 必填：没有它不知道扣谁的钱，探测发不出去', () => {
  bad({}, /probeUserId 必填/)
})

test('探测间隔越界拒绝', () => {
  bad({ probeUserId: 1, intervalMs: 9_999 }, /不能小于 10000/)
  bad({ probeUserId: 1, intervalMs: 3_600_001 }, /不能大于 3600000/)
  bad({ probeUserId: 1, intervalMs: 1.5 }, /必须是整数/)
})

test('未知配置项拒绝（不静默忽略，配置写错必须立刻可见）', () => {
  bad({ probeUserId: 1, probeInterval: 5000 }, /未知配置项：probeInterval/)
})

test('gatewayBaseUrl 必须是合法 http(s) URL', () => {
  bad({ probeUserId: 1, gatewayBaseUrl: 'not a url' }, /不是合法 URL/)
  bad({ probeUserId: 1, gatewayBaseUrl: 'ftp://x.example' }, /只支持 http \/ https/)
})

test('gatewayBaseUrl 末尾斜杠被归一化', () => {
  const resolved = ok({ probeUserId: 1, gatewayBaseUrl: 'http://127.0.0.1:18080///' })
  assert.equal(resolved.gatewayBaseUrl, 'http://127.0.0.1:18080')
})

test('并发 / 阈值 / 点数 / 保留天数的上下界', () => {
  bad({ probeUserId: 1, maxConcurrent: 0 }, /不能小于 1/)
  bad({ probeUserId: 1, maxConcurrent: 17 }, /不能大于 16/)
  bad({ probeUserId: 1, failureThreshold: 0 }, /不能小于 1/)
  bad({ probeUserId: 1, historyPoints: 11 }, /不能小于 12/)
  bad({ probeUserId: 1, historyPoints: 241 }, /不能大于 240/)
  bad({ probeUserId: 1, retentionDays: 0 }, /不能小于 1/)
  bad({ probeUserId: 1, retentionDays: 91 }, /不能大于 90/)
})

test('probeModels 白名单可省略、可给空数组、给非数组要拒绝', () => {
  assert.deepEqual(ok({ probeUserId: 1, probeModels: ['a', 'b'] }).probeModels, ['a', 'b'])
  assert.deepEqual(ok({ probeUserId: 1, probeModels: [] }).probeModels, [])
  bad({ probeUserId: 1, probeModels: 'a,b' }, /必须是字符串数组/)
  bad({ probeUserId: 1, probeModels: [''] }, /必须是非空字符串/)
})

test('enabled 必须是真布尔（不认 "true"）', () => {
  bad({ probeUserId: 1, enabled: 'true' }, /必须是布尔值/)
  assert.equal(ok({ probeUserId: 1, enabled: false }).enabled, false)
})
