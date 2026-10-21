import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import UsageService, { type UsageEntry } from '../src/index.ts'

const ALL_TIME = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER } as const
const BASE_TIME = '2026-10-21T01:00:00.000Z'

interface PricingFake {
  quote(model: string, tokens: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }): string
}

interface PriorityCall {
  readonly epoch?: string
  readonly afterSeq?: number
  readonly limit?: number
}

interface PriorityFake {
  result: {
    epoch: string
    firstSeq: number
    lastSeq: number
    dropped: number
    records: UsageEntry[]
  }
  readonly calls: PriorityCall[]
  usageSince(params: PriorityCall): Promise<PriorityFake['result']>
}

interface BootOptions {
  readonly priority?: PriorityFake
  readonly pricing?: PricingFake
  readonly retentionDays?: number
}

interface World {
  readonly ctx: Context
  readonly service: UsageService
  readonly priority: PriorityFake | undefined
}

async function boot(t: TestContext, options: BootOptions = {}): Promise<World> {
  const ctx = new Context()
  if (options.priority !== undefined) ctx.provide('accountPriority', options.priority)
  if (options.pricing !== undefined) ctx.provide('pricing', options.pricing)
  const fiber = await ctx.plugin(UsageService, {
    dataPath: ':memory:',
    pollIntervalMs: 60_000,
    retentionDays: options.retentionDays ?? 90,
    maxBatch: 500,
  })
  const service = ctx.get('usage') as UsageService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // dispose 在 cordis 4 里返回 void；测试清理忽略异常。
    }
  })
  return { ctx, service, priority: options.priority }
}

let sequence = 0

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  sequence += 1
  return {
    seq: sequence,
    epoch: 'e1',
    requestId: `req-${sequence}`,
    userId: '1',
    keyId: 'key-1',
    keyName: 'main',
    profile: 'default',
    accountId: 'account-1',
    model: 'model-a',
    upstreamModel: 'upstream-a',
    protocol: 'openai-chat',
    upstreamProtocol: 'openai-chat',
    stream: false,
    status: 200,
    errorCode: '',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    totalTokens: 21,
    usagePresent: true,
    usageComplete: true,
    durationMs: 120,
    clientIp: '127.0.0.1',
    attempts: 1,
    startedAt: BASE_TIME,
    ...overrides,
  }
}

function fakePriority(): PriorityFake {
  const fake: PriorityFake = {
    result: { epoch: 'e1', firstSeq: 1, lastSeq: 0, dropped: 0, records: [] },
    calls: [],
    async usageSince(params: PriorityCall) {
      fake.calls.push(params)
      return fake.result
    },
  }
  return fake
}

/** model-a：input 1 / output 10；model-b：input 2 / output 20（单位微元）。 */
function fakePricing(): PricingFake {
  return {
    quote(model, tokens) {
      const factor = model === 'model-b' ? 2n : 1n
      return (BigInt(tokens.inputTokens) * factor + BigInt(tokens.outputTokens) * factor * 10n).toString()
    },
  }
}

function ids(page: { items: readonly { id: number }[] }): number[] {
  return page.items.map((item) => item.id)
}

// ───────────────────────────────── 写入 / 读取 ─────────────────────────────────

test('ingest 幂等：同一 reqId 落两次只有一行', async (t) => {
  const { service } = await boot(t)
  const record = entry({ requestId: 'same-request' })
  service.ingest(record)
  service.ingest(record)
  assert.equal(service.status().records, 1)

  const listed = service.list({ ...ALL_TIME })
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0]?.reqId, 'same-request')
  assert.equal(listed.items[0]?.startedAt, BASE_TIME)
})

test('keyset 分页不重不漏', async (t) => {
  const { service } = await boot(t)
  for (let index = 0; index < 5; index += 1) service.ingest(entry())

  const first = service.list({ ...ALL_TIME, limit: 2 })
  assert.deepEqual(ids(first), [5, 4])
  assert.equal(first.nextCursor, 4)

  const second = service.list({ ...ALL_TIME, cursor: first.nextCursor ?? undefined, limit: 2 })
  assert.deepEqual(ids(second), [3, 2])
  assert.equal(second.nextCursor, 2)

  const third = service.list({ ...ALL_TIME, cursor: second.nextCursor ?? undefined, limit: 2 })
  assert.deepEqual(ids(third), [1])
  assert.equal(third.nextCursor, null)

  const seen = new Set([...first.items, ...second.items, ...third.items].map((row) => row.id))
  assert.equal(seen.size, 5)
})

test('用户过滤：不给 userId 是全部，给了只返回该用户', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ userId: '1', requestId: 'u1-a' }))
  service.ingest(entry({ userId: '1', requestId: 'u1-b' }))
  service.ingest(entry({ userId: '2', requestId: 'u2-a' }))

  assert.equal(service.list({ ...ALL_TIME }).items.length, 3)
  const onlyFirst = service.list({ ...ALL_TIME, userId: 1 })
  assert.equal(onlyFirst.items.length, 2)
  assert.ok(onlyFirst.items.every((row) => row.userId === 1))
  const onlySecond = service.list({ ...ALL_TIME, userId: 2 })
  assert.equal(onlySecond.items.length, 1)
  assert.equal(onlySecond.items[0]?.reqId, 'u2-a')

  assert.equal(service.list({ ...ALL_TIME, userId: 1, apiKeyId: 'key-1' }).items.length, 2)
  assert.equal(service.list({ ...ALL_TIME, model: 'model-b' }).items.length, 0)
})

test('summary：四桶求和、按天 / 按模型分组，费用按模型算再加', async (t) => {
  const { service } = await boot(t, { pricing: fakePricing() })
  service.ingest(
    entry({
      requestId: 'd20-a',
      model: 'model-a',
      startedAt: '2026-10-20T01:00:00.000Z',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
      totalTokens: 21,
    }),
  )
  service.ingest(
    entry({
      requestId: 'd20-b',
      model: 'model-b',
      startedAt: '2026-10-20T02:00:00.000Z',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 150,
    }),
  )
  service.ingest(
    entry({
      requestId: 'd21-a',
      model: 'model-a',
      startedAt: '2026-10-21T03:00:00.000Z',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 0,
      totalTokens: 10,
    }),
  )

  const summary = service.summary({ ...ALL_TIME })
  assert.equal(summary.totals.requests, 3)
  assert.equal(summary.totals.inputTokens, 111)
  assert.equal(summary.totals.outputTokens, 57)
  assert.equal(summary.totals.cacheReadTokens, 5)
  assert.equal(summary.totals.cacheWriteTokens, 5)
  assert.equal(summary.totals.reasoningTokens, 3)
  assert.equal(summary.totals.totalTokens, 181)
  // 60 + 1200 + 21
  assert.equal(summary.totals.costMicros, '1281')

  assert.deepEqual(
    summary.daily.map((point) => point.date),
    ['2026-10-20', '2026-10-21'],
  )
  const day20 = summary.daily[0]
  assert.ok(day20 !== undefined)
  assert.equal(day20.requests, 2)
  assert.equal(day20.inputTokens, 110)
  assert.equal(day20.outputTokens, 55)
  // 60（model-a）+ 1200（model-b），不是拿混合 token 套单一单价。
  assert.equal(day20.costMicros, '1260')
  assert.equal(summary.daily[1]?.costMicros, '21')

  const modelA = summary.models.find((item) => item.model === 'model-a')
  const modelB = summary.models.find((item) => item.model === 'model-b')
  assert.ok(modelA !== undefined && modelB !== undefined)
  assert.equal(modelA.requests, 2)
  assert.equal(modelA.inputTokens, 11)
  assert.equal(modelA.outputTokens, 7)
  assert.equal(modelA.costMicros, '81')
  assert.equal(modelB.requests, 1)
  assert.equal(modelB.costMicros, '1200')
  assert.equal(summary.models[0]?.model, 'model-a', '按请求数降序')
})

test('pricing 不在运行：费用一律 0，status.pricingAvailable=false', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry())
  const summary = service.summary({ ...ALL_TIME })
  assert.equal(summary.totals.costMicros, '0')
  assert.equal(summary.models[0]?.costMicros, '0')
  assert.equal(service.list({ ...ALL_TIME }).items[0]?.costMicros, '0')
  assert.equal(service.status().pricingAvailable, false)
})

test('stats：今天 / 累计 / 近 30 天 / 按模型 / 用户 Top', async (t) => {
  const { service } = await boot(t, { pricing: fakePricing() })
  service.ingest(
    entry({
      requestId: 'old-user-1',
      userId: '1',
      model: 'model-a',
      startedAt: '2026-10-20T01:00:00.000Z',
      inputTokens: 10,
      outputTokens: 5,
    }),
  )
  service.ingest(
    entry({
      requestId: 'today-user-2',
      userId: '2',
      model: 'model-b',
      startedAt: '2026-10-21T01:00:00.000Z',
      inputTokens: 100,
      outputTokens: 50,
    }),
  )
  service.ingest(
    entry({
      requestId: 'today-user-2-b',
      userId: '2',
      model: 'model-b',
      startedAt: '2026-10-21T02:00:00.000Z',
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 2,
    }),
  )

  const stats = service.stats(Date.parse('2026-10-21T12:00:00.000Z'))
  assert.equal(stats.today.requests, 2)
  assert.equal(stats.total.requests, 3)
  assert.equal(stats.today.inputTokens, 101)
  assert.equal(stats.total.inputTokens, 111)
  // 今天两笔 model-b：1200 + 22
  assert.equal(stats.today.costMicros, '1222')
  assert.deepEqual(
    stats.series.map((point) => point.date),
    ['2026-10-20', '2026-10-21'],
  )
  assert.equal(stats.models[0]?.model, 'model-b')
  assert.deepEqual(
    stats.topUsers.map((user) => [user.userId, user.requests]),
    [
      [2, 2],
      [1, 1],
    ],
  )
})

test('exportRows：过滤 + 上限', async (t) => {
  const { service } = await boot(t)
  for (let index = 0; index < 4; index += 1) {
    service.ingest(entry({ userId: index < 2 ? '1' : '2' }))
  }
  assert.equal(service.exportRows({ ...ALL_TIME }).length, 4)
  assert.equal(service.exportRows({ ...ALL_TIME, userId: 1 }).length, 2)
  assert.equal(service.exportRows({ ...ALL_TIME }, 3).length, 3)
  assert.deepEqual(
    service.exportRows({ ...ALL_TIME }, 4).map((row) => row.id),
    [4, 3, 2, 1],
  )
})

test('保留期：过期记录分批删除', async (t) => {
  const { service } = await boot(t, { retentionDays: 90 })
  service.ingest(entry({ requestId: 'keep', startedAt: '2026-10-21T01:00:00.000Z' }))
  service.ingest(entry({ requestId: 'drop-1', startedAt: '2026-01-01T01:00:00.000Z' }))
  service.ingest(entry({ requestId: 'drop-2', startedAt: '2026-02-01T01:00:00.000Z' }))

  const removed = service.pruneExpired(Date.parse('2026-10-21T12:00:00.000Z'))
  assert.equal(removed, 2)
  assert.equal(service.status().records, 1)
  assert.equal(service.list({ ...ALL_TIME }).items[0]?.reqId, 'keep')
})

// ───────────────────────────────── 轮询 ─────────────────────────────────

test('轮询：首次不带 epoch、续拉带 afterSeq、epoch 变化重置、gap 警告', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 2,
    dropped: 0,
    records: [
      entry({ seq: 1, requestId: 'poll-1', startedAt: '2026-10-21T01:00:00.000Z' }),
      entry({ seq: 2, requestId: 'poll-2', startedAt: '2026-10-21T01:00:01.000Z' }),
    ],
  }
  const first = await service.pollOnce()
  assert.deepEqual(first, { status: 'ok', epochChanged: false, gap: 0, ingested: 2 })
  assert.deepEqual(priority.calls[0], { limit: 500 })
  assert.equal(service.status().epoch, 'e1')
  assert.equal(service.status().lastSeq, 2)

  priority.result = {
    epoch: 'e1',
    firstSeq: 3,
    lastSeq: 4,
    dropped: 0,
    records: [entry({ seq: 3, requestId: 'poll-3' }), entry({ seq: 4, requestId: 'poll-4' })],
  }
  const second = await service.pollOnce()
  assert.deepEqual(second, { status: 'ok', epochChanged: false, gap: 0, ingested: 2 })
  assert.deepEqual(priority.calls[1], { epoch: 'e1', afterSeq: 2, limit: 500 })
  assert.equal(service.status().lastSeq, 4)

  // 本地 lastSeq=4，服务端从 10 开始：缺 5 条。
  priority.result = {
    epoch: 'e1',
    firstSeq: 10,
    lastSeq: 10,
    dropped: 5,
    records: [entry({ seq: 10, requestId: 'poll-10' })],
  }
  const gap = await service.pollOnce()
  assert.deepEqual(gap, { status: 'ok', epochChanged: false, gap: 5, ingested: 1 })
  assert.equal(service.status().lastSeq, 10)

  // gatewayd 重启：新 epoch 从 seq 1 重新开始。
  priority.result = {
    epoch: 'e2',
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
    records: [entry({ epoch: 'e2', seq: 1, requestId: 'poll-e2-1' })],
  }
  const changed = await service.pollOnce()
  assert.deepEqual(changed, { status: 'ok', epochChanged: true, gap: 0, ingested: 1 })
  assert.equal(service.status().epoch, 'e2')
  assert.equal(service.status().lastSeq, 1)
  assert.equal(service.status().records, 6)

  // 重复拉同一段：INSERT OR IGNORE，计数不涨。
  const repeat = await service.pollOnce()
  assert.deepEqual(repeat, { status: 'ok', epochChanged: false, gap: 0, ingested: 0 })
  assert.equal(service.status().records, 6)
})

test('轮询：一批没拉完时游标只推进到实际记录，不跳到缓冲尾部', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority })
  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 10,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'batch-1' }), entry({ seq: 2, requestId: 'batch-2' })],
  }

  const first = await service.pollOnce()
  assert.equal(first.ingested, 2)
  assert.equal(service.status().lastSeq, 2, 'lastSeq 是已落库游标，不是缓冲尾部')

  await service.pollOnce()
  assert.deepEqual(priority.calls[1], { epoch: 'e1', afterSeq: 2, limit: 500 })
})

test('轮询：account-priority 不在时跳过，不抛错', async (t) => {
  const { service } = await boot(t)
  const outcome = await service.pollOnce()
  assert.deepEqual(outcome, { status: 'skipped', epochChanged: false, gap: 0, ingested: 0 })
})
