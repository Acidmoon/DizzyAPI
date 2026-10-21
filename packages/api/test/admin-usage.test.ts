import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { ApiServer } from '../src/http.ts'
import type { UsageRowLike } from '../src/types.ts'
import { createFixture, type Fixture, type FixtureOptions } from './fixtures.ts'

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly json: any
}

function call(server: ApiServer, path: string, options: { cookie?: string } = {}): Promise<Reply> {
  const port = server.address?.port
  assert.ok(port !== undefined, '服务器必须已启动')
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    'x-requested-with': 'dizzyapi',
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie

  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: any
        try {
          json = text === '' ? undefined : JSON.parse(text)
        } catch {
          json = undefined
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function login(
  server: ApiServer,
  email: string,
  password: string,
): Promise<string> {
  const port = server.address?.port
  assert.ok(port !== undefined)
  const body = Buffer.from(JSON.stringify({ email, password }), 'utf8')
  return new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/auth/login',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'x-requested-with': 'dizzyapi',
          'content-type': 'application/json',
          'content-length': String(body.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const raw = res.headers['set-cookie']
          const value = Array.isArray(raw) ? raw[0] : raw
          if ((res.statusCode ?? 0) !== 200 || typeof value !== 'string') {
            reject(new Error(`登录失败：HTTP ${res.statusCode ?? 0} ${Buffer.concat(chunks).toString('utf8')}`))
            return
          }
          resolve(value.split(';')[0] as string)
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

async function setup(
  t: TestContext,
  options: FixtureOptions = {},
): Promise<Fixture & { server: ApiServer }> {
  const fixture = await createFixture(options)
  const server = new ApiServer(fixture.runtime)
  await server.start(0)
  t.after(async () => {
    await server.stop()
    await fixture.cleanup()
  })
  return { ...fixture, server }
}

function usageRow(overrides: Partial<UsageRowLike> = {}): UsageRowLike {
  return {
    id: 1,
    reqId: 'req_1',
    userId: 1,
    apiKeyId: 'key_1',
    apiKeyName: 'ci',
    profile: 'default',
    accountId: 'acc_1',
    model: 'gpt-5',
    upstreamModel: null,
    protocol: 'openai-chat',
    upstreamProtocol: 'openai-chat',
    stream: false,
    status: 200,
    errorCode: null,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    reasoningTokens: 0,
    totalTokens: 165,
    usagePresent: true,
    usageComplete: true,
    durationMs: 120,
    clientIp: '127.0.0.1',
    attempts: 1,
    startedAt: '2026-10-19T10:00:00.000Z',
    costMicros: '25000',
    ...overrides,
  }
}

// ───────────────────────────────── 权限 ─────────────────────────────────

test('管理员用量：普通用户 403，管理员可看全部', async (t) => {
  const fixture = await setup(t)
  fixture.usage.rows.push(
    usageRow({ id: 2, userId: 2, apiKeyName: 'alice-key', model: 'claude-sonnet-4' }),
    usageRow({ id: 1, userId: 1, status: 500, errorCode: 'UPSTREAM_ERROR' }),
  )

  const userCookie = await login(fixture.server, 'alice@example.com', 'password2')
  const forbidden = await call(fixture.server, '/api/admin/usage', { cookie: userCookie })
  assert.equal(forbidden.status, 403)

  const adminCookie = await login(fixture.server, 'owner@example.com', 'password1')
  const reply = await call(fixture.server, '/api/admin/usage?range=30d', { cookie: adminCookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.range, '30d')
  assert.equal(reply.json.records.items.length, 2)
  assert.equal(reply.json.records.items[0].userName, 'alice')
  assert.equal(reply.json.records.items[1].userName, 'owner')
  assert.equal(reply.json.records.items[0].accountId, 'acc_1')
  assert.equal(reply.json.records.items[0].attempts, 1)
  assert.equal(reply.json.pricingAvailable, true)
  assert.equal(reply.json.totals.requests, 2)
  assert.equal(reply.json.totals.tokens, 330)
  assert.equal(reply.json.totals.costCents, 5)
  assert.equal(reply.json.totals.costMicros, '50000')
})

test('管理员用量：按 userId / status 过滤', async (t) => {
  const fixture = await setup(t)
  fixture.usage.rows.push(
    usageRow({ id: 2, userId: 2, model: 'claude-sonnet-4' }),
    usageRow({ id: 1, userId: 1, status: 500 }),
  )
  const cookie = await login(fixture.server, 'owner@example.com', 'password1')

  const byUser = await call(fixture.server, '/api/admin/usage?userId=2', { cookie })
  assert.equal(byUser.status, 200, byUser.text)
  assert.equal(byUser.json.records.items.length, 1)
  assert.equal(byUser.json.records.items[0].userId, 2)
  assert.equal(byUser.json.totals.requests, 1)

  const byStatus = await call(fixture.server, '/api/admin/usage?status=500', { cookie })
  assert.equal(byStatus.status, 200, byStatus.text)
  assert.equal(byStatus.json.records.items.length, 1)
  assert.equal(byStatus.json.records.items[0].status, 500)
})

test('管理员用量：usage 端口缺席时 503 稳定 code', async (t) => {
  const fixture = await setup(t, { withoutUsage: true })
  const cookie = await login(fixture.server, 'owner@example.com', 'password1')
  const reply = await call(fixture.server, '/api/admin/usage', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'API_ADMIN_USAGE_UNAVAILABLE')
})

// ───────────────────────────────── 导出 ─────────────────────────────────

test('管理员导出：文件名、BOM、表头与公式注入转义', async (t) => {
  const fixture = await setup(t)
  fixture.usage.rows.push(
    usageRow({
      id: 1,
      userId: 2,
      apiKeyName: '=SUM(A1)',
      model: 'gpt,"5"',
      clientIp: '@cmd',
      accountId: '=acc',
    }),
  )
  const cookie = await login(fixture.server, 'owner@example.com', 'password1')
  const reply = await call(fixture.server, '/api/admin/usage/export?range=30d', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.filename, 'admin-usage-20260920-20261019.csv')
  const content: string = reply.json.content
  assert.ok(content.startsWith('﻿time,user,api_key,'), 'CSV 必须带 UTF-8 BOM')
  assert.match(content, /alice/)
  assert.match(content, /'=SUM\(A1\)/, '公式注入字段要加前导单引号')
  assert.match(content, /"gpt,""5"""/, '含引号与逗号的字段要正确转义')
  assert.match(content, /'@cmd/)
  assert.match(content, /'=acc/)
})

// ───────────────────────────────── 全站统计 ─────────────────────────────────

test('全站统计：用户 / 账号 / key 计数与用量映射', async (t) => {
  const fixture = await setup(t)
  fixture.usage.rows.push(usageRow({ id: 1, userId: 1, costMicros: '123400' }))
  const cookie = await login(fixture.server, 'owner@example.com', 'password1')
  const reply = await call(fixture.server, '/api/admin/stats', { cookie })
  assert.equal(reply.status, 200, reply.text)
  const stats = reply.json
  assert.deepEqual(stats.users, { total: 3, admins: 1, enabled: 2, banned: 1 })
  assert.deepEqual(stats.accounts, { total: 2, enabled: 1, disabled: 1, needsReauth: 1 })
  assert.deepEqual(stats.keys, { total: 1, enabled: 1, disabled: 0 })
  assert.equal(stats.usage.today.requests, 1)
  assert.equal(stats.usage.today.tokens, 165)
  assert.equal(stats.usage.today.costMicros, '123400')
  assert.equal(stats.usage.today.costCents, 12)
})

test('全站统计：usage 缺席时 usage 为 null，其它块照常', async (t) => {
  const fixture = await setup(t, { withoutUsage: true })
  const cookie = await login(fixture.server, 'owner@example.com', 'password1')
  const reply = await call(fixture.server, '/api/admin/stats', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.usage, null)
  assert.equal(reply.json.users.total, 3)
})

test('全站统计：accountAdmin / apiKey 缺席时对应块全 0', async (t) => {
  const fixture = await setup(t, { withoutAccountAdmin: true, withApiKey: false })
  const cookie = await login(fixture.server, 'owner@example.com', 'password1')
  const reply = await call(fixture.server, '/api/admin/stats', { cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.deepEqual(reply.json.accounts, { total: 0, enabled: 0, disabled: 0, needsReauth: 0 })
  assert.deepEqual(reply.json.keys, { total: 0, enabled: 0, disabled: 0 })
})
