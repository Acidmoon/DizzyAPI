/**
 * 用户侧端点的逐条契约：方法、路径、查询串、body。
 *
 * 断言方式是**逐字比对**，不用「包含」——这些路径是服务端 `routeApi` 的分派键，
 * 少一个字符就是 404，多了就是另一个接口。
 *
 * 另有一条纪律在这里钉死：**秘密只走 body**。密码、验证码、兑换码、完整 API key
 * 都**不许出现在 URL** 里（URL 会进浏览器历史、Referer、反代日志）。
 * 所以每个带秘密的写操作都额外断言「URL 里没有那个值」。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiClient } from '../app/src/lib/api/client.ts'
import * as auth from '../app/src/lib/api/endpoints/auth.ts'
import * as keys from '../app/src/lib/api/endpoints/keys.ts'
import * as pricing from '../app/src/lib/api/endpoints/pricing.ts'
import * as profile from '../app/src/lib/api/endpoints/profile.ts'
import * as redeem from '../app/src/lib/api/endpoints/redeem.ts'
import * as topup from '../app/src/lib/api/endpoints/topup.ts'
import * as usage from '../app/src/lib/api/endpoints/usage.ts'
import { fakeFetch } from './helpers/fake-fetch.ts'

/** 造一个把第一次调用的记录交回来的客户端。 */
function call(): { client: ApiClient; fake: ReturnType<typeof fakeFetch> } {
  const fake = fakeFetch({ json: {} })
  return { client: new ApiClient({ fetchImpl: fake.fetch }), fake }
}

/** 断言 URL 里不含某个秘密值（秘密只许走 body）。 */
function assertNoSecretInUrl(url: string, secret: string): void {
  assert.equal(url.includes(secret), false, `URL 里出现了秘密值：${url}`)
}

// ───────────────────────────── 鉴权与会话 ─────────────────────────────

test('GET /api/session', async () => {
  const { client, fake } = call()
  await auth.fetchSession(client)
  assert.equal(fake.last().method, 'GET')
  assert.equal(fake.last().url, '/api/session')
})

test('POST /api/auth/login：邮箱与密码在 body，不进 URL', async () => {
  const { client, fake } = call()
  await auth.login(client, { email: 'a@b.c', password: 'p@ss-WORD' })
  assert.equal(fake.last().method, 'POST')
  assert.equal(fake.last().url, '/api/auth/login')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { email: 'a@b.c', password: 'p@ss-WORD' })
  assertNoSecretInUrl(fake.last().url, 'p@ss-WORD')
})

test('POST /api/auth/logout 不带 body（幂等，服务端回 { ok: true }）', async () => {
  const { client, fake } = call()
  await auth.logout(client)
  assert.equal(fake.last().method, 'POST')
  assert.equal(fake.last().url, '/api/auth/logout')
  assert.equal(fake.last().body, undefined)
  assert.equal(fake.last().headers['content-type'], undefined)
})

test('注册两步：request 拿工单，confirm 带验证码换会话', async () => {
  const { client, fake } = call()
  await auth.requestRegistration(client, { email: 'a@b.c', password: 'pw' })
  assert.equal(fake.last().url, '/api/auth/register/request')
  assert.equal(fake.last().method, 'POST')
  await auth.confirmRegistration(client, { email: 'a@b.c', code: '123456' })
  assert.equal(fake.last().url, '/api/auth/register/confirm')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { email: 'a@b.c', code: '123456' })
  assertNoSecretInUrl(fake.last().url, '123456')
})

test('重置密码两步：验证码与新密码都只走 body', async () => {
  const { client, fake } = call()
  await auth.requestPasswordReset(client, { email: 'a@b.c' })
  assert.equal(fake.last().url, '/api/auth/password/reset/request')
  await auth.confirmPasswordReset(client, { email: 'a@b.c', code: '999999', password: 'new-pw' })
  assert.equal(fake.last().url, '/api/auth/password/reset/confirm')
  const body = fake.last().body ?? ''
  assert.equal(body.includes('new-pw'), true)
  assertNoSecretInUrl(fake.last().url, 'new-pw')
  assertNoSecretInUrl(fake.last().url, '999999')
})

// ───────────────────────────── API key ─────────────────────────────

test('API key 五个动作的路径与方法', async () => {
  const { client, fake } = call()
  await keys.listKeys(client)
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/keys')

  await keys.createKey(client, { name: '我的 key' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/keys')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { name: '我的 key' })

  // id 里可能有 `/` 之类，必须 encode 后再拼进路径。
  await keys.updateKey(client, 'k/1', { name: 'x', enabled: false })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'PATCH /api/keys/k%2F1')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { name: 'x', enabled: false })

  await keys.rotateKey(client, 'k1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/keys/k1/rotate')
  assert.equal(fake.last().body, undefined)

  await keys.deleteKey(client, 'k1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/keys/k1')
})

test('PATCH /api/keys/:id：三个上限允许传 null（= 不限 / 永不过期）', async () => {
  const { client, fake } = call()
  await keys.updateKey(client, 'k1', {
    expiresAt: null,
    spendingLimitMicros: null,
    concurrencyLimit: null,
  })
  const body = JSON.parse(fake.last().body ?? '{}') as Record<string, unknown>
  assert.equal(body.expiresAt, null)
  assert.equal(body.spendingLimitMicros, null)
  assert.equal(body.concurrencyLimit, null)
})

test('PATCH /api/keys/:id：上限金额是十进制字符串，不能是 number', async () => {
  const { client, fake } = call()
  await keys.updateKey(client, 'k1', { spendingLimitMicros: '9007199254740993' })
  const body = JSON.parse(fake.last().body ?? '{}') as Record<string, unknown>
  assert.equal(typeof body.spendingLimitMicros, 'string')
  assert.equal(body.spendingLimitMicros, '9007199254740993')
})

// ───────────────────────────── 用量 ─────────────────────────────

test('GET /api/usage：查询串逐项对齐服务端的参数名', async () => {
  const { client, fake } = call()
  await usage.fetchUsage(client, {
    range: '7d',
    apiKeyId: 'k1',
    model: 'gpt-4o',
    cursor: 120,
    limit: 20,
  })
  assert.equal(fake.last().method, 'GET')
  assert.equal(fake.last().url, '/api/usage?range=7d&apiKeyId=k1&model=gpt-4o&cursor=120&limit=20')
})

test('GET /api/usage：不传筛选就一条查询串都不拼（服务端自己取默认 30d）', async () => {
  const { client, fake } = call()
  await usage.fetchUsage(client)
  assert.equal(fake.last().url, '/api/usage')
})

test('GET /api/usage/:reqId：reqId 要 encode；查不到与不是自己的一律 404', async () => {
  const { client, fake } = call()
  await usage.fetchUsageDetail(client, 'req/1')
  assert.equal(fake.last().url, '/api/usage/req%2F1')
})

test('GET /api/usage/export 是 JSON 而不是文件流（浏览器自己拼 Blob）', async () => {
  const { client, fake } = call()
  await usage.exportUsage(client, { range: '30d' })
  assert.equal(fake.last().url, '/api/usage/export?range=30d')
})

// ───────────────────────────── 价格与模型广场 ─────────────────────────────

test('GET /api/pricing 与 GET /api/pricing/:model', async () => {
  const { client, fake } = call()
  await pricing.fetchPricing(client)
  assert.equal(fake.last().url, '/api/pricing')
  await pricing.fetchModelPrice(client, 'openai/gpt-4o')
  assert.equal(fake.last().url, '/api/pricing/openai%2Fgpt-4o')
})

test('PUT / DELETE /api/pricing/:model 是管理员写接口', async () => {
  const { client, fake } = call()
  await pricing.setModelPrice(client, 'gpt-4o', { inputPerMillion: '1', outputPerMillion: '2' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'PUT /api/pricing/gpt-4o')
  await pricing.deleteModelPrice(client, 'gpt-4o')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/pricing/gpt-4o')
})

test('GET /api/models：三个筛选用服务端的参数名（search / availability / priced）', async () => {
  const { client, fake } = call()
  await pricing.fetchModels(client, { search: 'claude', availability: 'available', priced: 'priced' })
  assert.equal(fake.last().url, '/api/models?search=claude&availability=available&priced=priced')
})

// ───────────────────────────── 兑换与充值 ─────────────────────────────

test('兑换：GET 我的记录、POST 兑换（码只走 body）', async () => {
  const { client, fake } = call()
  await redeem.fetchMyRedemptions(client, { limit: 10 })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/redeem?limit=10')
  await redeem.redeem(client, { code: 'DIZZY-ABCD-1234' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/redeem')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { code: 'DIZZY-ABCD-1234' })
  assertNoSecretInUrl(fake.last().url, 'DIZZY-ABCD-1234')
})

test('充值：options / orders / 单条 / 取消', async () => {
  const { client, fake } = call()
  await topup.fetchTopupOptions(client)
  assert.equal(fake.last().url, '/api/topup/options')

  await topup.fetchMyOrders(client, { limit: 5 })
  assert.equal(fake.last().url, '/api/topup/orders?limit=5')

  await topup.fetchOrder(client, 'TP20261031001')
  assert.equal(fake.last().url, '/api/topup/orders/TP20261031001')

  await topup.createOrder(client, { amountYuan: '100.5' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/topup/orders')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { amountYuan: '100.5' })

  await topup.cancelOrder(client, 'TP20261031001')
  assert.equal(
    `${fake.last().method} ${fake.last().url}`,
    'POST /api/topup/orders/TP20261031001/cancel',
  )
})

test('下单金额是「元」的字符串（服务端字符串换算，不经浮点）', async () => {
  const { client, fake } = call()
  await topup.createOrder(client, { amountYuan: '0.000001' })
  const body = JSON.parse(fake.last().body ?? '{}') as Record<string, unknown>
  assert.equal(typeof body.amountYuan, 'string')
})

// ───────────────────────────── 个人资料 ─────────────────────────────

test('PATCH /api/profile 与 POST /api/profile/password（密码只走 body）', async () => {
  const { client, fake } = call()
  await profile.updateProfile(client, { name: '新名字' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'PATCH /api/profile')
  assert.deepEqual(JSON.parse(fake.last().body ?? '{}'), { name: '新名字' })

  await profile.changePassword(client, { currentPassword: 'old-pw', newPassword: 'new-pw' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/profile/password')
  assertNoSecretInUrl(fake.last().url, 'old-pw')
  assertNoSecretInUrl(fake.last().url, 'new-pw')
})
