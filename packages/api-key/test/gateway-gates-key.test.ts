/**
 * **真进程**用例：key 级执行面（owner 要的是「真拦截」，内存假 Go 抓不到这些）。
 *
 * 覆盖 key-gate 的四条拒绝路径：
 *   `401 API_KEY_EXPIRED` / `402 API_KEY_SPENDING_LIMIT` /
 *   `429 API_KEY_CONCURRENCY_LIMIT` / `429 USER_CONCURRENCY_LIMIT`。
 *
 * 每条都断言「被拒的请求上游 0 次」——闸门的意义就是不转发上游、不扣费。
 *
 * 没有 `bin/gatewayd` 时整组跳过（先跑 `pnpm build:go`）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { post, SKIP, startGateway, startUpstream } from './helpers/gateway-process.ts'
import {
  AUTH,
  chat,
  KEY_HASH,
  nextGeneration,
  pushAccounts,
  pushKeys,
  pushQuota,
  pushSpend,
  waitForActive,
} from './helpers/gateway-snapshots.ts'

test('真进程：过期 key → 401 API_KEY_EXPIRED，上游 0 次', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway, { expiresAt: new Date(Date.now() - 60_000).toISOString() })

  const reply = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(reply.status, 401, reply.text)
  assert.equal(reply.json.error.code, 'API_KEY_EXPIRED')
  assert.equal(upstream.hits(), 0, '被拒的请求绝不能打到上游')

  // 换成没过期的 key：同一把 key 立刻可用（证明拒绝来自过期而不是鉴权失败）。
  await pushKeys(gateway, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  const ok = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(ok.status, 200, ok.text)
  assert.equal(upstream.hits(), 1)
})

test('真进程：累计消费达到金额上限 → 402 API_KEY_SPENDING_LIMIT', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway, { spendingLimitMicros: '1000' })

  // 先给一个「还没到顶」的消费快照：必须放行。
  await pushSpend(gateway, '999')
  const allowed = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(allowed.status, 200, allowed.text)
  assert.equal(upstream.hits(), 1)

  await pushSpend(gateway, '1000')
  const blocked = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(blocked.status, 402, blocked.text)
  assert.equal(blocked.json.error.code, 'API_KEY_SPENDING_LIMIT')
  assert.equal(upstream.hits(), 1, '被拒的请求绝不能打到上游')
})

test('真进程：key 并发满 → 429 API_KEY_CONCURRENCY_LIMIT，请求结束后槽位归零', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t, { delayMs: 400 })
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway, { concurrencyLimit: 1 })

  // 第一个请求占住唯一槽位（上游 400ms 才回）。等它**真的**占住再发第二个：
  // 用 keys.status 的 activeKeys 轮询，而不是 sleep 一个魔法值——机器负载高时
  // sleep 会假失败（多个 worktree 同时在跑真进程用例）。
  const first = post(gateway.httpPort, chat(), AUTH)
  await waitForActive(gateway, 'activeKeys')
  const second = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(second.status, 429, second.text)
  assert.equal(second.json.error.code, 'API_KEY_CONCURRENCY_LIMIT')

  const firstReply = await first
  assert.equal(firstReply.status, 200, firstReply.text)
  assert.equal(upstream.hits(), 1, '被并发闸门拒掉的请求绝不能打到上游')

  // 槽位必须真的还回来了（release 漏了这里会一直 429）。
  const third = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(third.status, 200, third.text)
  assert.equal(upstream.hits(), 2)

  const status = await gateway.status('keys.status')
  assert.equal(status.gate?.activeKeys ?? 0, 0, '请求结束后不能有残留槽位')
})

test('真进程：用户并发满 → 429 USER_CONCURRENCY_LIMIT（与 key 级共用一套预留）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t, { delayMs: 400 })
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  // 两把 key 都属于用户 #1；用户级上限 1，key 级不限。
  await pushKeys(gateway, { concurrencyLimit: null })
  await gateway.bridge.request('keys.replace', {
    version: 1,
    generation: nextGeneration(),
    keys: [
      { keyId: 'key-a', userId: 1, keyHash: KEY_HASH, profile: 'billed', name: 'a' },
      {
        keyId: 'key-b',
        userId: 1,
        keyHash: createHash('sha256').update('sk-dz-second', 'utf8').digest('hex'),
        profile: 'billed',
        name: 'b',
      },
    ],
  })
  await pushQuota(gateway, 1)

  const first = post(gateway.httpPort, chat(), AUTH)
  await waitForActive(gateway, 'activeUsers')
  const second = await post(
    gateway.httpPort,
    chat(),
    { authorization: 'Bearer sk-dz-second' },
  )
  assert.equal(second.status, 429, second.text)
  assert.equal(second.json.error.code, 'USER_CONCURRENCY_LIMIT')

  const firstReply = await first
  assert.equal(firstReply.status, 200, firstReply.text)
})
