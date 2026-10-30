import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ApiServer } from '../src/http.ts'
import type { UsageRowLike } from '../src/types.ts'
import { createFixture, type Fixture, type FixtureOptions } from './fixtures/index.ts'

interface Reply {
  readonly status: number
  readonly headers: Headers
  readonly text: string
  readonly json: any
}

async function get(server: ApiServer, path: string, cookie: string): Promise<Reply> {
  const response = await fetch(`${server.origin}${path}`, {
    headers: { 'x-requested-with': 'dizzyapi', cookie },
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text === '' ? undefined : JSON.parse(text),
  }
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

function cookieOf(auth: Fixture['auth'], userId: number): string {
  return `dizzyapi_session=${encodeURIComponent(auth.issueFor(userId))}`
}

let nextId = 1

function row(overrides: Partial<UsageRowLike> = {}): UsageRowLike {
  const id = overrides.id ?? nextId++
  return {
    id,
    reqId: `req-${id}`,
    userId: 2,
    apiKeyId: 'key-1',
    apiKeyName: 'key 1',
    profile: 'default',
    accountId: 'account-1',
    model: 'gpt-4o-mini',
    upstreamModel: 'gpt-4o-mini',
    protocol: 'openai-chat',
    upstreamProtocol: 'openai-chat',
    stream: false,
    status: 200,
    errorCode: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    reasoningTokens: 0,
    totalTokens: 18,
    usagePresent: true,
    usageComplete: true,
    durationMs: 120,
    ttftMs: null,
    clientIp: '127.0.0.1',
    attempts: 1,
    startedAt: '2026-10-19T01:00:00.000Z',
    costMicros: '12345678',
    ...overrides,
  }
}

test('用量：普通用户只能看自己，管理员可以按 userId 看别人，分页透传 records', async (t) => {
  const fixture = await setup(t)
  const adminCookie = cookieOf(fixture.auth, 1)
  const userCookie = cookieOf(fixture.auth, 2)
  fixture.usage.rows.push(
    row({ userId: 1, reqId: 'admin-1' }),
    row({ userId: 2, reqId: 'user-1' }),
  )

  const asUser = await get(fixture.server, '/api/usage?range=7d&limit=20', userCookie)
  assert.equal(asUser.status, 200, asUser.text)
  assert.equal(asUser.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(asUser.json.range, '7d')
  assert.equal(asUser.json.from, '2026-10-13')
  assert.equal(asUser.json.to, '2026-10-19')
  assert.equal(asUser.json.records.items.length, 1)
  assert.equal(asUser.json.records.items[0].reqId, 'user-1')
  assert.equal(asUser.json.records.items[0].costMicros, '12345678')
  // 用户页不返回管理面字段。
  assert.equal('profile' in asUser.json.records.items[0], false)
  assert.equal('accountId' in asUser.json.records.items[0], false)
  assert.equal('attempts' in asUser.json.records.items[0], false)

  // 四个桶之和；成本按 1 分 = 10_000 微元换算。
  assert.deepEqual(asUser.json.totals, {
    requests: 1,
    tokens: 18,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 2,
    costCents: 1234,
    costMicros: '12345678',
  })
  assert.equal(asUser.json.pricingAvailable, true)

  // 普通用户传 userId 也不能越权。
  const spoofed = await get(fixture.server, '/api/usage?range=7d&userId=1', userCookie)
  assert.equal(spoofed.status, 200)
  assert.equal(spoofed.json.records.items.length, 1)
  assert.equal(spoofed.json.records.items[0].userId, 2)

  // 管理员不传 userId = 全部。
  const asAdmin = await get(fixture.server, '/api/usage?range=7d', adminCookie)
  assert.equal(asAdmin.status, 200)
  assert.equal(asAdmin.json.records.items.length, 2)

  const adminFiltered = await get(fixture.server, '/api/usage?range=7d&userId=2', adminCookie)
  assert.equal(adminFiltered.status, 200)
  assert.equal(adminFiltered.json.records.items.length, 1)
  assert.equal(adminFiltered.json.records.items[0].reqId, 'user-1')
})

test('用量：keyset 分页（cursor 透传、nextCursor 收口）', async (t) => {
  const fixture = await setup(t)
  const cookie = cookieOf(fixture.auth, 2)
  for (let index = 0; index < 5; index += 1) fixture.usage.rows.push(row({ userId: 2 }))

  const first = await get(fixture.server, '/api/usage?range=7d&limit=2', cookie)
  assert.equal(first.status, 200, first.text)
  assert.equal(first.json.records.items.length, 2)
  const firstIds = first.json.records.items.map((item: any) => item.id)
  assert.deepEqual(firstIds, [...firstIds].sort((a: number, b: number) => b - a))
  assert.equal(first.json.records.nextCursor, firstIds[1])

  const second = await get(
    fixture.server,
    `/api/usage?range=7d&limit=2&cursor=${first.json.records.nextCursor}`,
    cookie,
  )
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json.records.items.length, 2)
  const all = [...first.json.records.items, ...second.json.records.items].map((item: any) => item.id)
  assert.equal(new Set(all).size, 4, '分页不重复')

  const invalid = await get(fixture.server, '/api/usage?range=7d&cursor=-1', cookie)
  assert.equal(invalid.status, 400)
})

test('用量导出：CSV 的 BOM、转义与公式注入防护', async (t) => {
  const fixture = await setup(t)
  const cookie = cookieOf(fixture.auth, 2)
  fixture.usage.rows.push(
    row({
      apiKeyName: 'evil,key "x"',
      model: '=SUM(A1)',
      clientIp: '-2.5',
      costMicros: '1',
      status: 500,
      errorCode: 'UPSTREAM_FAILED',
    }),
  )

  const reply = await get(fixture.server, '/api/usage/export?range=7d&format=csv', cookie)
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.headers.get('content-type'), 'application/json; charset=utf-8')
  assert.equal(reply.json.filename, 'usage-20261013-20261019.csv')
  const content: string = reply.json.content
  assert.ok(content.startsWith('﻿'), 'CSV 必须带 UTF-8 BOM')
  const lines = content.slice(1).split('\r\n')
  assert.equal(
    lines[0],
    'time,api_key,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,status,duration_ms,client_ip',
  )
  assert.equal(lines.length, 2)
  assert.match(lines[1] as string, /"evil,key ""x"""/, '逗号 / 引号按 CSV 规则转义')
  assert.match(lines[1] as string, /'=SUM\(A1\)/, '公式开头加单引号')

  assert.match(lines[1] as string, /'-2\.5/, '负数开头同样防公式注入')
  assert.ok((lines[1] as string).endsWith(',500,120,\'-2.5'))

  const bad = await get(fixture.server, '/api/usage/export?range=7d&format=xlsx', cookie)
  assert.equal(bad.status, 400)
  assert.equal(bad.json.error.code, 'API_BAD_REQUEST')

  const spoofed = await get(fixture.server, '/api/usage/export?range=7d&userId=1', cookie)
  assert.equal(spoofed.status, 200)
  assert.equal(spoofed.json.content.slice(1).split('\r\n').length, 2, '普通用户导出仍只有自己那一条')
})

test('用量：usage 端口缺失时查询与导出都 503', async (t) => {
  const fixture = await setup(t, { withoutUsage: true })
  const cookie = cookieOf(fixture.auth, 2)

  const usage = await get(fixture.server, '/api/usage?range=7d', cookie)
  assert.equal(usage.status, 503)
  assert.equal(usage.json.error.code, 'API_USAGE_UNAVAILABLE')

  const exported = await get(fixture.server, '/api/usage/export?format=csv', cookie)
  assert.equal(exported.status, 503)
  assert.equal(exported.json.error.code, 'API_USAGE_UNAVAILABLE')
})

test('用量详情：用户只能查自己的、管理员能查全部；补齐 reasoning / 标记 / TTFT', async (t) => {
  const fixture = await setup(t)
  const adminCookie = cookieOf(fixture.auth, 1)
  const userCookie = cookieOf(fixture.auth, 2)
  fixture.usage.rows.push(
    row({ userId: 2, reqId: 'mine', stream: true, ttftMs: 321, reasoningTokens: 7 }),
    row({ userId: 1, reqId: 'owners' }),
  )

  const mine = await get(fixture.server, '/api/usage/mine', userCookie)
  assert.equal(mine.status, 200, mine.text)
  const record = mine.json.record
  assert.equal(record.reqId, 'mine')
  assert.equal(record.ttftMs, 321)
  assert.equal(record.reasoningTokens, 7)
  assert.equal(record.usagePresent, true)
  assert.equal(record.usageComplete, true)
  assert.equal(record.costMicros, '12345678')
  // 管理面字段仍然不进用户面响应。
  assert.equal('profile' in record, false)
  assert.equal('accountId' in record, false)
  assert.equal('attempts' in record, false)

  // 别人的记录与「不存在」返回同一个 404：不泄露某个 reqId 是否存在。
  const others = await get(fixture.server, '/api/usage/owners', userCookie)
  assert.equal(others.status, 404)
  assert.equal(others.json.error.code, 'USAGE_RECORD_NOT_FOUND')
  const missing = await get(fixture.server, '/api/usage/req-nope', userCookie)
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'USAGE_RECORD_NOT_FOUND')

  // 管理员能查任何人的；非流式记录的首字延迟是 null（页面显示「—」）。
  const asAdmin = await get(fixture.server, '/api/usage/owners', adminCookie)
  assert.equal(asAdmin.status, 200, asAdmin.text)
  assert.equal(asAdmin.json.record.userId, 1)
  assert.equal(asAdmin.json.record.ttftMs, null)
})

test('用量详情：usage 端口缺失时 503', async (t) => {
  const fixture = await setup(t, { withoutUsage: true })
  const cookie = cookieOf(fixture.auth, 2)
  const reply = await get(fixture.server, '/api/usage/some-req', cookie)
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'API_USAGE_UNAVAILABLE')
})
