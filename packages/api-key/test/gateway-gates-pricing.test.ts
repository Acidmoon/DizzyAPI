/**
 * **真进程**用例：定价闸门（`-pricing-gate` 打开）。
 *
 * owner 拍的是「真拒绝」：没配价的模型**不许请求**，不是照常请求再标注未定价。
 * 覆盖：
 *   `403 MODEL_NOT_PRICED`（没价）/ `503 PRICING_SNAPSHOT_UNAVAILABLE`（fail-closed）
 *   / 闸门默认关时放行 / `*` 兜底价放行全部模型 / 价格快照超过 TTL 不再推 → 503。
 *
 * 没有 `bin/gatewayd` 时整组跳过（先跑 `pnpm build:go`）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { post, SKIP, sleep, startGateway, startUpstream } from './helpers/gateway-process.ts'
import { AUTH, chat, MODEL, pushAccounts, pushKeys, pushPrices } from './helpers/gateway-snapshots.ts'

test('真进程：定价闸门关 → 未定价模型照常放行（默认关）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)

  const reply = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(reply.status, 200, `闸门默认关时必须放行：${reply.text}`)
  assert.equal(upstream.hits(), 1)
})

test('真进程：定价闸门开 + 模型没价 → 403 MODEL_NOT_PRICED，上游 0 次', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { pricingGate: true })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)
  await pushPrices(gateway, ['some-other-model'])

  const blocked = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(blocked.status, 403, blocked.text)
  assert.equal(blocked.json.error.code, 'MODEL_NOT_PRICED')
  assert.equal(upstream.hits(), 0)

  // 补上价目表 → 立刻放行（快照是新的，不用等 TTL）。
  await pushPrices(gateway, [MODEL])
  const ok = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(ok.status, 200, ok.text)
  assert.equal(upstream.hits(), 1)
})

test('真进程：定价闸门开 + 没有价格快照 → 503（fail-closed）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { pricingGate: true })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)

  const strict = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(strict.status, 503, strict.text)
  assert.equal(strict.json.error.code, 'PRICING_SNAPSHOT_UNAVAILABLE')
  assert.equal(upstream.hits(), 0)
})

test('真进程：价格快照超过 TTL 不再推 → 503（心跳失败的后果）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  // TTL 用 2s：机器负载高时（多个 worktree 同时跑真进程用例）1s 窗口会把
  // 「刚推完就要被判过期」变成假失败；断言本身不变（过期必须 503）。
  const gateway = await startGateway(t, { pricingGate: true, pricingTtlMs: 2_000 })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)
  await pushPrices(gateway, [MODEL])

  const fresh = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(fresh.status, 200, fresh.text)

  // 不再推任何快照，等过 TTL：闸门必须 fail-closed 而不是静默放行。
  await sleep(2_600)
  const stale = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(stale.status, 503, `超时后必须 503：${stale.text}`)
  assert.equal(stale.json.error.code, 'PRICING_SNAPSHOT_UNAVAILABLE')

  const status = await gateway.status('pricing.status')
  assert.equal(status.ready, true)
  assert.ok((status.gate?.strictBlocked ?? 0) >= 1)
})

test('真进程：有 * 兜底价 → 任何模型都放行（与 billing.hasPrice 同口径）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { pricingGate: true })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)
  await pushPrices(gateway, ['*'])

  const reply = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(reply.status, 200, `有 * 时不该拒绝任何模型：${reply.text}`)
  assert.equal(upstream.hits(), 1)

  const status = await gateway.status('pricing.status')
  assert.equal(status.wildcard, true)
})
