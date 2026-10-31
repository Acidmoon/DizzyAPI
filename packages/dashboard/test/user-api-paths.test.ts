/**
 * 用户侧 `/api/*` 的**逐字契约**：路径、查询串、方法。
 *
 * 这些字符串是契约：`api` 插件的路由分发按前缀与段数判定（`routeApi`），
 * 多一个空参数、少一个 `range`、或者把 `reqId` 里的 `/` 漏编码，都会变成 400 / 404。
 *
 * 断言跑的是**用户侧页面实际用的那一份传输层**（`@/lib/api` 的端点层）。
 * 页面自己不再有第二套路径拼装：2026-10-31 收敛掉 `user/_lib/api.ts` / `paths.ts` / `types.ts`
 * 之后只剩这一份（护栏见 `user-pages-guards.test.ts`）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ApiClient, ApiError } from '../app/src/lib/api/client.ts'
import * as authEndpoints from '../app/src/lib/api/endpoints/auth.ts'
import * as keysEndpoints from '../app/src/lib/api/endpoints/keys.ts'
import * as pricingEndpoints from '../app/src/lib/api/endpoints/pricing.ts'
import * as usageEndpoints from '../app/src/lib/api/endpoints/usage.ts'
import { fakeFetch } from './helpers/fake-fetch.ts'

function call(): { client: ApiClient; fake: ReturnType<typeof fakeFetch> } {
  const fake = fakeFetch({ json: {} })
  return { client: new ApiClient({ fetchImpl: fake.fetch }), fake }
}

describe('GET /api/usage 的查询串', () => {
  it('只有 range', async () => {
    const { client, fake } = call()
    await usageEndpoints.fetchUsage(client, { range: '7d' })
    assert.equal(fake.last().url, '/api/usage?range=7d')
  })

  it('带筛选与分页：参数顺序稳定，值原样编码', async () => {
    const { client, fake } = call()
    await usageEndpoints.fetchUsage(client, {
      range: '30d',
      apiKeyId: 'key-1',
      model: 'deepseek-chat',
      cursor: 100,
      limit: 20,
    })
    const url = fake.last().url
    assert.ok(url.startsWith('/api/usage?'), url)
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1))
    // 顺序是契约：服务端按参数名取值，但顺序错说明拼装层被换掉了。
    assert.deepEqual([...params.keys()], ['range', 'apiKeyId', 'model', 'cursor', 'limit'])
    assert.equal(params.get('range'), '30d')
    assert.equal(params.get('apiKeyId'), 'key-1')
    assert.equal(params.get('model'), 'deepseek-chat')
    assert.equal(params.get('cursor'), '100')
    assert.equal(params.get('limit'), '20')
  })

  it('空值不进查询串（不让后端把 "" 当筛选）', async () => {
    const { client, fake } = call()
    await usageEndpoints.fetchUsage(client, { range: '7d', model: '', apiKeyId: undefined })
    assert.equal(fake.last().url, '/api/usage?range=7d')
  })

  it('模型名带斜杠 / 空格会被编码（不能拼出多一段路径）', async () => {
    const { client, fake } = call()
    await usageEndpoints.fetchUsage(client, { range: '7d', model: 'org/model name' })
    assert.ok(fake.last().url.includes('model=org%2Fmodel%20name'), fake.last().url)
  })
})

describe('GET /api/usage/:reqId', () => {
  it('reqId 里的 + 与 / 必须编码，否则会被路由当成两段', async () => {
    const { client, fake } = call()
    await usageEndpoints.fetchUsageDetail(client, 'a+b/c')
    assert.equal(fake.last().url, '/api/usage/a%2Bb%2Fc')

    await usageEndpoints.fetchUsageDetail(client, 'req-1')
    assert.equal(fake.last().url, '/api/usage/req-1')
  })

  it('详情响应是 { record } 包一层（页面取 .record）', async () => {
    const fake = fakeFetch({ json: { record: { reqId: 'r1', ttftMs: null } } })
    const client = new ApiClient({ fetchImpl: fake.fetch })
    const detail = await usageEndpoints.fetchUsageDetail(client, 'r1')
    assert.equal(detail.record.reqId, 'r1')
    assert.equal(detail.record.ttftMs, null)
  })
})

describe('GET /api/usage/export', () => {
  it('筛选与列表一致，且**不带**分页参数（导出是全量）', async () => {
    const { client, fake } = call()
    await usageEndpoints.exportUsage(client, { range: '7d' })
    assert.equal(fake.last().url, '/api/usage/export?range=7d')

    await usageEndpoints.exportUsage(client, { range: '90d', apiKeyId: 'k', model: 'm' })
    const url = fake.last().url
    assert.equal(url, '/api/usage/export?range=90d&apiKeyId=k&model=m')
    assert.ok(!url.includes('cursor'))
    assert.ok(!url.includes('limit'))
  })
})

describe('/api/keys', () => {
  it('列表 / 新建 / 改名 / 轮换 / 删除的方法与路径', async () => {
    const { client, fake } = call()

    await keysEndpoints.listKeys(client)
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/keys')

    await keysEndpoints.createKey(client, { name: '生产' })
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/keys')
    assert.equal(fake.last().body, '{"name":"生产"}')

    await keysEndpoints.updateKey(client, 'k1', { name: '改名' })
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'PATCH /api/keys/k1')

    await keysEndpoints.rotateKey(client, 'k1')
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'POST /api/keys/k1/rotate')

    await keysEndpoints.deleteKey(client, 'k1')
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'DELETE /api/keys/k1')
  })

  it('id 编码：斜杠不能拼出多一段路径', async () => {
    const { client, fake } = call()
    await keysEndpoints.deleteKey(client, 'a/b')
    assert.equal(fake.last().url, '/api/keys/a%2Fb')
  })
})

describe('/api/pricing 与 /api/session', () => {
  it('用户侧价格表只读：GET /api/pricing', async () => {
    const { client, fake } = call()
    await pricingEndpoints.fetchPricing(client)
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/pricing')
  })

  it('会话：GET /api/session', async () => {
    const { client, fake } = call()
    await authEndpoints.fetchSession(client)
    assert.equal(`${fake.last().method} ${fake.last().url}`, 'GET /api/session')
  })
})

describe('路径纪律', () => {
  it('用户侧用到的路径都不许落到 /api/admin 下', async () => {
    const { client, fake } = call()
    const paths: string[] = []
    const record = async (run: () => Promise<unknown>): Promise<void> => {
      await run()
      paths.push(fake.last().url)
    }
    await record(() => usageEndpoints.fetchUsage(client, { range: '7d' }))
    await record(() => usageEndpoints.fetchUsageDetail(client, 'x'))
    await record(() => usageEndpoints.exportUsage(client, { range: '7d' }))
    await record(() => keysEndpoints.listKeys(client))
    await record(() => pricingEndpoints.fetchPricing(client))
    await record(() => authEndpoints.fetchSession(client))
    for (const path of paths) assert.ok(!path.startsWith('/api/admin'), path)
  })
})

describe('未登录（401）', () => {
  it('抛 ApiError 且 isUnauthorized 为 true（页面据此跳登录页）', async () => {
    const fake = fakeFetch({ status: 401, json: { error: { code: 'AUTH_REQUIRED', message: '请先登录' } } })
    const client = new ApiClient({ fetchImpl: fake.fetch })
    await assert.rejects(
      () => authEndpoints.fetchSession(client),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.isUnauthorized, true)
        assert.equal(error.code, 'AUTH_REQUIRED')
        return true
      },
    )
  })
})
