/**
 * 目标挑选与停摆判定的护栏（纯逻辑）。
 *
 * 这两块是本插件里**唯一有判断**的地方：
 * - 挑错目标 = 花了钱探一个路由不到的模型，或者漏探真正在卖的模型；
 * - 判错停摆原因 = 页面给出的处置建议是错的（让人去重建 key，其实该去充值）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { decideBlocked, pickTargets } from '../src/targets.ts'

function catalog(available: [string, number][], unavailable: [string, number][] = []) {
  return {
    available: available.map(([model, accountCount]) => ({ model, accountCount })),
    unavailable: unavailable.map(([model, accountCount]) => ({ model, accountCount })),
  }
}

test('只挑有账号声明的模型：没人提供的模型不花请求', () => {
  const targets = pickTargets(
    catalog([['served', 1], ['orphan', 0]], [['also-orphan', 0], ['half', 2]]),
    [],
  )
  assert.deepEqual(targets.models, ['half', 'served'])
  assert.equal(targets.emptyCatalog, false)
})

test('可用与不可用两侧都算：不可用但有账号的模型也要探（它可能正在恢复）', () => {
  const targets = pickTargets(catalog([], [['recovering', 1]]), [])
  assert.deepEqual(targets.models, ['recovering'])
})

test('白名单生效，并且不在目录里的名字被忽略（不是错误）', () => {
  const targets = pickTargets(catalog([['a', 1], ['b', 1]]), ['b', 'not-in-catalog'])
  assert.deepEqual(targets.models, ['b'])
})

test('白名单与目录求交后可能为空：那就是「这一轮没东西可探」', () => {
  const targets = pickTargets(catalog([['a', 1]]), ['zzz'])
  assert.deepEqual(targets.models, [])
  assert.equal(targets.emptyCatalog, false, '目录里其实有模型，不算空目录')
})

test('目录完全为空时标记 emptyCatalog（用来区分「没配模型」与「模型全挂」）', () => {
  const targets = pickTargets(catalog([], []), [])
  assert.deepEqual(targets.models, [])
  assert.equal(targets.emptyCatalog, true)
})

test('结果排序稳定（同一份目录两次结果一致）', () => {
  const first = pickTargets(catalog([['z', 1], ['a', 1], ['m', 1]]), []).models
  const second = pickTargets(catalog([['m', 1], ['z', 1], ['a', 1]]), []).models
  assert.deepEqual(first, ['a', 'm', 'z'])
  assert.deepEqual(first, second)
})

test('停摆原因：余额不足优先于 key 问题（处置建议不同）', () => {
  const verdict = decideBlocked(new Set(['INSUFFICIENT_BALANCE', 'API_KEY_EXPIRED']), {
    probeUserId: 42,
    gatewayBaseUrl: 'http://127.0.0.1:8080',
  })
  assert.equal(verdict.reason, 'probe_user_balance_exhausted')
  assert.match(verdict.detail, /#42/)
  assert.match(verdict.detail, /不是模型故障/)
})

test('停摆原因：key 被拒 → probe_key_rejected', () => {
  for (const code of ['API_KEY_EXPIRED', 'API_KEY_INVALID', 'API_KEY_SPENDING_LIMIT']) {
    const verdict = decideBlocked(new Set([code]), { probeUserId: 1, gatewayBaseUrl: 'http://x' })
    assert.equal(verdict.reason, 'probe_key_rejected', `${code} 应判 key 被拒`)
  }
})

test('停摆原因：连不上网关 → gateway_unreachable，并带上地址', () => {
  for (const code of ['gateway_unreachable', 'probe_timeout']) {
    const verdict = decideBlocked(new Set([code]), {
      probeUserId: 1,
      gatewayBaseUrl: 'http://127.0.0.1:18080',
    })
    assert.equal(verdict.reason, 'gateway_unreachable')
    assert.match(verdict.detail, /18080/)
  }
})

test('停摆原因：其它探测侧错误码兜底成 key 被拒，并把码带出来', () => {
  const verdict = decideBlocked(new Set(['PRICING_SNAPSHOT_UNAVAILABLE']), {
    probeUserId: 1,
    gatewayBaseUrl: 'http://x',
  })
  assert.equal(verdict.reason, 'probe_key_rejected')
  assert.match(verdict.detail, /PRICING_SNAPSHOT_UNAVAILABLE/)
})
