/**
 * 管理面端点的逐条契约：方法、路径、查询串、body。
 *
 * 这层特别容易错三处，都在这里钉住：
 * 1. 管理员的**用户 / 上游账号**挂在 `/api/users`、`/api/accounts`（**不带 `admin` 前缀**），
 *    但都要管理员权限；`/api/admin/*` 是管理台页面用的那一批。混了就 404。
 * 2. **兑换码批量删除是 `DELETE` + body `{ ids }`**，不是 `DELETE /:id`；
 *    改状态 / 核查是 `POST /:sub` + body，不是 `PATCH`。
 * 3. 凭据（上游 key）与明文兑换码**只许走 body**，绝不进 URL。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiClient } from '../app/src/lib/api/client.ts'
import * as commerce from '../app/src/lib/api/endpoints/adminCommerce.ts'
import * as ops from '../app/src/lib/api/endpoints/adminOps.ts'
import * as users from '../app/src/lib/api/endpoints/adminUsers.ts'
import { fakeFetch } from './helpers/fake-fetch.ts'

function call(): { client: ApiClient; fake: ReturnType<typeof fakeFetch> } {
  const fake = fakeFetch({ json: {} })
  return { client: new ApiClient({ fetchImpl: fake.fetch }), fake }
}

function jsonBodyOf(fake: ReturnType<typeof fakeFetch>): Record<string, unknown> {
  return JSON.parse(fake.last().body ?? '{}') as Record<string, unknown>
}

// ───────────────────────────── 用户（/api/users） ─────────────────────────────

test('用户：列表 / 单条 / 改 / 删', async () => {
  const { client, fake } = call()
  await users.listUsers(client, { status: 'enabled', offset: 0, limit: 100 })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/users?status=enabled&offset=0&limit=100')

  await users.fetchUser(client, 7)
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/users/7')

  await users.updateUser(client, 7, { name: 'x', role: 'admin', concurrencyLimit: null })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'PATCH /api/users/7')
  assert.deepEqual(jsonBodyOf(fake), { name: 'x', role: 'admin', concurrencyLimit: null })

  await users.deleteUser(client, 7)
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/users/7')
})

test('调余额：delta 是十进制字符串（可负），走 body 不走查询串', async () => {
  const { client, fake } = call()
  await users.adjustBalance(client, 7, { delta: '-161', reason: '手工修正' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/users/7/balance')
  const body = jsonBodyOf(fake)
  assert.equal(typeof body.delta, 'string')
  assert.equal(body.delta, '-161')
  assert.equal(body.reason, '手工修正')
})

// ───────────────────────────── 上游账号（/api/accounts） ─────────────────────────────

test('账号：列表用 offset 游标（服务端叫 cursor），筛选是 provider / status', async () => {
  const { client, fake } = call()
  await users.listAccounts(client, { provider: 'openai', status: 'active', cursor: 50, limit: 50 })
  assert.equal(
    fake.last().url,
    '/api/accounts?provider=openai&status=active&cursor=50&limit=50',
  )
})

test('账号：增 / 查 / 改 / 删', async () => {
  const { client, fake } = call()
  await users.createAccount(client, { provider: 'openai', kind: 'api_key', label: '主号' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/accounts')
  assert.deepEqual(jsonBodyOf(fake), { provider: 'openai', kind: 'api_key', label: '主号' })

  await users.fetchAccount(client, 'acc-1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/accounts/acc-1')

  await users.updateAccount(client, 'acc-1', { enabled: false, models: ['gpt-4o'] })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'PATCH /api/accounts/acc-1')

  await users.deleteAccount(client, 'acc-1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/accounts/acc-1')
})

test('账号：连通性测试与导入凭据（凭据只走 body，不进 URL）', async () => {
  const { client, fake } = call()
  await users.testAccount(client, 'acc-1', { model: 'gpt-4o', protocol: 'openai-chat' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/accounts/acc-1/test')

  await users.importAccountCredentials(client, 'acc-1', { payload: 'sk-super-secret' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/accounts/acc-1/credentials')
  assert.equal(fake.last().url.includes('sk-super-secret'), false)
  assert.equal((fake.last().body ?? '').includes('sk-super-secret'), true)
})

test('账号：批量导入与预检是两个不同路径（preview 是三段）', async () => {
  const { client, fake } = call()
  await users.importAccounts(client, { source: 'new-api', payload: '[]' })
  assert.equal(fake.last().url, '/api/accounts/import')
  await users.previewAccountImport(client, { source: 'new-api', payload: '[]' })
  assert.equal(fake.last().url, '/api/accounts/import/preview')
})

test('账号：批量启停 / 改字段走 POST /api/accounts/bulk（body 带 action + ids）', async () => {
  const { client, fake } = call()

  await users.bulkAccounts(client, { action: 'enable', ids: ['acc-1', 'acc-2'] })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/accounts/bulk')
  assert.deepEqual(jsonBodyOf(fake), { action: 'enable', ids: ['acc-1', 'acc-2'] })

  await users.bulkAccounts(client, { action: 'update', ids: ['acc-1'], patch: { priority: 42 } })
  assert.deepEqual(jsonBodyOf(fake), { action: 'update', ids: ['acc-1'], patch: { priority: 42 } })

  // 启停不许混进 patch：由 action 表达，服务端 patch 里出现 enabled 会被 400。
  await users.bulkAccounts(client, { action: 'disable', ids: ['acc-1'] })
  assert.equal(JSON.stringify(jsonBodyOf(fake)).includes('enabled'), false)
})

// ───────────────────────────── 管理面运维（/api/admin/*） ─────────────────────────────

test('用量：主接口 / 导出 / 隔离区分页', async () => {
  const { client, fake } = call()
  await ops.fetchAdminUsage(client, { range: '7d', userId: 7, status: 502, cursor: 900, limit: 20 })
  assert.equal(
    fake.last().url,
    '/api/admin/usage?range=7d&userId=7&status=502&cursor=900&limit=20',
  )
  await ops.exportAdminUsage(client, { range: '7d' })
  assert.equal(fake.last().url, '/api/admin/usage/export?range=7d')
  await ops.fetchRejectedUsage(client, { limit: 20, offset: 40 })
  assert.equal(fake.last().url, '/api/admin/usage/rejected?limit=20&offset=40')
})

test('隔离区：忽略与重放都是 POST /:reqId/:action', async () => {
  const { client, fake } = call()
  await ops.ignoreRejectedUsage(client, 'req/1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/usage/rejected/req%2F1/ignore')
  await ops.replayRejectedUsage(client, 'req/1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/usage/rejected/req%2F1/replay')
})

test('结算 / 审计 / 运维总览', async () => {
  const { client, fake } = call()
  await ops.fetchBilling(client, { status: 'review', limit: 50 })
  assert.equal(fake.last().url, '/api/admin/billing?status=review&limit=50')

  await ops.fetchAudit(client, { actor: 'user:1:admin', limit: 50 })
  assert.equal(fake.last().url, '/api/admin/audit?actor=user%3A1%3Aadmin&limit=50')
  await ops.fetchAudit(client, { stats: '1' })
  assert.equal(fake.last().url, '/api/admin/audit?stats=1')

  await ops.fetchObservability(client)
  assert.equal(fake.last().url, '/api/admin/observability')
})

test('内容审核：列表 / 新建 / 改 / 删 / 立刻推送', async () => {
  const { client, fake } = call()
  await ops.fetchContentAudit(client)
  assert.equal(fake.last().url, '/api/admin/content-audit')

  await ops.createContentAuditRule(client, { pattern: '违禁词', action: 'block' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/content-audit')

  await ops.updateContentAuditRule(client, 'r1', { enabled: false, note: null })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'PATCH /api/admin/content-audit/r1')
  assert.deepEqual(jsonBodyOf(fake), { enabled: false, note: null })

  await ops.deleteContentAuditRule(client, 'r1')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/admin/content-audit/r1')

  await ops.pushContentAuditRules(client)
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/content-audit/push')
})

test('概览 / 设置 / 目录 / 健康', async () => {
  const { client, fake } = call()
  await ops.fetchAdminStats(client)
  assert.equal(fake.last().url, '/api/admin/stats')

  await ops.fetchSettings(client)
  assert.equal(fake.last().url, '/api/settings')

  await ops.updateSettings(client, 'pricing', { enabled: true }, 'rev-3')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/settings/pricing')
  assert.deepEqual(jsonBodyOf(fake), { patch: { enabled: true }, expectedRevision: 'rev-3' })

  // 不带 expectedRevision 就别塞这个键（服务端按 Object.hasOwn 判「给了没」）。
  await ops.updateSettings(client, 'pricing', { enabled: false })
  assert.deepEqual(jsonBodyOf(fake), { patch: { enabled: false } })

  await ops.resetSettings(client, 'pricing')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/settings/pricing')

  await ops.fetchCatalogModules(client)
  assert.equal(fake.last().url, '/api/catalog/modules')

  await ops.fetchHealth(client)
  assert.equal(fake.last().url, '/api/health')
})

// ───────────────────────────── 充值订单（管理面） ─────────────────────────────

test('充值订单：列表 / 统计 / 确认到账 / 取消', async () => {
  const { client, fake } = call()
  await commerce.fetchTopupOrders(client, { status: 'pending', limit: 50, offset: 0 })
  assert.equal(
    fake.last().url,
    '/api/admin/topup-orders?status=pending&limit=50&offset=0',
  )
  await commerce.fetchTopupStats(client)
  assert.equal(fake.last().url, '/api/admin/topup-orders/stats')

  await commerce.confirmTopupOrder(client, 'TP001')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/topup-orders/TP001/confirm')

  await commerce.cancelTopupOrder(client, 'TP001')
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/topup-orders/TP001/cancel')
})

// ───────────────────────────── 兑换码（管理面） ─────────────────────────────

test('兑换码列表：批次筛选的查询串叫 batch（不是 batchId）', async () => {
  const { client, fake } = call()
  await commerce.fetchRedeemCodes(client, { batch: 'b1', status: 'enabled', keyword: '1234' })
  assert.equal(fake.last().url, '/api/admin/redeem-codes?batch=b1&status=enabled&keyword=1234')
})

test('生成批次：count 必填、amountMicro 是十进制字符串；明文码只在响应里', async () => {
  const { client, fake } = call()
  await commerce.createRedeemBatch(client, { name: '双十一', amountMicro: '5000000', count: 10 })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/redeem-codes')
  const body = jsonBodyOf(fake)
  assert.equal(typeof body.amountMicro, 'string')
  assert.equal(body.count, 10)
})

test('批量删除兑换码是 DELETE + body { ids }，不是 DELETE /:id', async () => {
  const { client, fake } = call()
  await commerce.deleteRedeemCodes(client, ['c1', 'c2'])
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/admin/redeem-codes')
  assert.deepEqual(jsonBodyOf(fake), { ids: ['c1', 'c2'] })
})

test('改状态 / 人工核查都是 POST + body（不是 PATCH /:id）', async () => {
  const { client, fake } = call()
  await commerce.setRedeemCodeStatus(client, { id: 'c1', status: 'disabled' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/redeem-codes/status')
  assert.deepEqual(jsonBodyOf(fake), { id: 'c1', status: 'disabled' })

  await commerce.resolveRedeemCode(client, { id: 'c1', outcome: 'enabled' })
  assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/admin/redeem-codes/resolve')
  assert.deepEqual(jsonBodyOf(fake), { id: 'c1', outcome: 'enabled' })
})

test('批次与统计', async () => {
  const { client, fake } = call()
  await commerce.fetchRedeemBatches(client)
  assert.equal(fake.last().url, '/api/admin/redeem-batches')
  await commerce.fetchRedeemBatch(client, 'b/1')
  assert.equal(fake.last().url, '/api/admin/redeem-batches/b%2F1')
  await commerce.fetchRedeemStats(client)
  assert.equal(fake.last().url, '/api/admin/redeem-stats')
})
