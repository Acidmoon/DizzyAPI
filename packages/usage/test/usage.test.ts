import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { Context, FiberState, type Fiber } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'
import UsageService, {
  USAGE_DEFAULTS,
  USAGE_SCHEMA,
  openUsageDatabase,
  validateUsageConfig,
  type SettleBatchOutcomeLike,
  type SettleCandidateLike,
  type UsageEntry,
  type UsagePollOutcome,
} from '../src/index.ts'

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

interface PriorityStats {
  epoch: string
  capacity: number
  size: number
  firstSeq: number
  lastSeq: number
  dropped: number
  gap: number
}

interface PriorityFake {
  result: {
    epoch: string
    firstSeq: number
    lastSeq: number
    dropped: number
    records: UsageEntry[]
  }
  stats: PriorityStats
  readonly calls: PriorityCall[]
  statsCalls: number
  usageSince(params: PriorityCall): Promise<PriorityFake['result']>
  usageStats?(): Promise<PriorityStats>
}

interface BootOptions {
  readonly priority?: PriorityFake
  readonly pricing?: PricingFake
  readonly billing?: BillingFake
  readonly retentionDays?: number
  readonly rejectAfterFailures?: number
  readonly dataPath?: string
}

interface World {
  readonly ctx: Context
  readonly service: UsageService
  readonly priority: PriorityFake | undefined
  readonly fiber: Fiber
}

async function boot(t: TestContext, options: BootOptions = {}): Promise<World> {
  const ctx = new Context()
  if (options.priority !== undefined) ctx.provide('accountPriority', options.priority)
  if (options.pricing !== undefined) ctx.provide('pricing', options.pricing)
  if (options.billing !== undefined) ctx.provide('billing', options.billing)
  const fiber = await ctx.plugin(UsageService, {
    dataPath: options.dataPath ?? ':memory:',
    pollIntervalMs: 60_000,
    retentionDays: options.retentionDays ?? 90,
    maxBatch: 500,
    rejectAfterFailures: options.rejectAfterFailures ?? 10,
  })
  const service = ctx.get('usage') as UsageService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // dispose 在 cordis 4 里返回 void；测试清理忽略异常。
    }
  })
  return { ctx, service, priority: options.priority, fiber }
}

/** 只取轮询结果的标量部分；`persisted` 另行断言（避免 deepEqual 把整批记录塞进期望值）。 */
function shapeOf(outcome: UsagePollOutcome): Record<string, unknown> {
  return {
    status: outcome.status,
    epochChanged: outcome.epochChanged,
    gap: outcome.gap,
    ingested: outcome.ingested,
    rejected: outcome.rejected,
  }
}

let sequence = 0

/** 结算服务假实现：记下每轮拿到的记录，可让某一轮抛错。 */
interface BillingFake {
  readonly calls: (readonly SettleCandidateLike[])[]
  fail: Error | undefined
  settle(records: readonly SettleCandidateLike[]): Promise<SettleBatchOutcomeLike>
}

function fakeBilling(): BillingFake {
  const fake: BillingFake = {
    calls: [],
    fail: undefined,
    async settle(records) {
      fake.calls.push(records)
      if (fake.fail !== undefined) throw fake.fail
      return {
        settled: records.length,
        noPrice: 0,
        noUser: 0,
        failed: 0,
        review: 0,
        skipped: 0,
      }
    },
  }
  return fake
}

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

function fakePriority(options: { withStats?: boolean } = {}): PriorityFake {
  const fake: PriorityFake = {
    result: { epoch: 'e1', firstSeq: 1, lastSeq: 0, dropped: 0, records: [] },
    stats: { epoch: 'e1', capacity: 32768, size: 0, firstSeq: 0, lastSeq: 0, dropped: 0, gap: 0 },
    calls: [],
    statsCalls: 0,
    async usageSince(params: PriorityCall) {
      fake.calls.push(params)
      return fake.result
    },
  }
  if (options.withStats !== false) {
    fake.usageStats = async () => {
      fake.statsCalls += 1
      return fake.stats
    }
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

test('keyset 分页不重不漏', async (t) => {  const { service } = await boot(t)
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
  assert.equal(removed.records, 2)
  assert.equal(removed.rejected, 0)
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
  assert.deepEqual(shapeOf(first), { status: 'ok', epochChanged: false, gap: 0, ingested: 2, rejected: 0 })
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
  assert.deepEqual(shapeOf(second), { status: 'ok', epochChanged: false, gap: 0, ingested: 2, rejected: 0 })
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
  assert.deepEqual(shapeOf(gap), { status: 'ok', epochChanged: false, gap: 5, ingested: 1, rejected: 0 })
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
  assert.deepEqual(shapeOf(changed), { status: 'ok', epochChanged: true, gap: 0, ingested: 1, rejected: 0 })
  assert.equal(service.status().epoch, 'e2')
  assert.equal(service.status().lastSeq, 1)
  assert.equal(service.status().records, 6)

  // 重复拉同一段：INSERT OR IGNORE，计数不涨。
  const repeat = await service.pollOnce()
  assert.deepEqual(shapeOf(repeat), { status: 'ok', epochChanged: false, gap: 0, ingested: 0, rejected: 0 })
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
  assert.deepEqual(shapeOf(outcome), { status: 'skipped', epochChanged: false, gap: 0, ingested: 0, rejected: 0 })
})

test('轮询：落库失败不推进游标，下一轮用同一游标重试成功', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 2,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'ok-1' }), entry({ seq: 2, requestId: 'ok-2' })],
  }
  assert.equal((await service.pollOnce()).status, 'ok')
  assert.equal(service.status().lastSeq, 2)

  // 一条记录时间非法 → 整批回滚：不能只写一半，游标也不能动。
  priority.result = {
    epoch: 'e1',
    firstSeq: 3,
    lastSeq: 4,
    dropped: 0,
    records: [
      entry({ seq: 3, requestId: 'bad-3', startedAt: 'not-a-timestamp' }),
      entry({ seq: 4, requestId: 'ok-4' }),
    ],
  }
  const failed = await service.pollOnce()
  assert.equal(failed.status, 'error')
  assert.equal(service.status().lastSeq, 2, '落库失败不得推进游标')
  assert.equal(service.status().records, 2, '失败那一批整体回滚')
  assert.equal(service.status().consecutiveFailures, 1)
  assert.match(service.status().lastError ?? '', /时间不合法/)

  // 重试：还在游标 2，修好后两条一起落库，游标才推进。
  assert.deepEqual(priority.calls[1], { epoch: 'e1', afterSeq: 2, limit: 500 })
  priority.result = {
    epoch: 'e1',
    firstSeq: 3,
    lastSeq: 4,
    dropped: 0,
    records: [entry({ seq: 3, requestId: 'retry-3' }), entry({ seq: 4, requestId: 'retry-4' })],
  }
  const retried = await service.pollOnce()
  assert.deepEqual(shapeOf(retried), { status: 'ok', epochChanged: false, gap: 0, ingested: 2, rejected: 0 })
  assert.deepEqual(priority.calls[2], { epoch: 'e1', afterSeq: 2, limit: 500 })
  assert.equal(service.status().lastSeq, 4)
  assert.equal(service.status().consecutiveFailures, 0)
  assert.equal(service.status().lastError, null)
  assert.equal(service.status().records, 4)
})

test('轮询：缺口按游标只告警一次，并读 usage.stats 补充缓冲上下文', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'gap-1' })],
  }
  await service.pollOnce()

  // 游标 1，服务端从 10 开始：缺 8 条；这一批落库失败 → 游标仍停在 1。
  priority.stats = { epoch: 'e1', capacity: 32768, size: 32768, firstSeq: 10, lastSeq: 20, dropped: 9, gap: 9 }
  priority.result = {
    epoch: 'e1',
    firstSeq: 10,
    lastSeq: 10,
    dropped: 9,
    records: [entry({ seq: 10, requestId: 'gap-bad', startedAt: 'nope' })],
  }
  const first = await service.pollOnce()
  assert.equal(first.status, 'error')
  assert.equal(first.gap, 8)
  assert.equal(service.status().gapRecords, 8)
  assert.equal(priority.statsCalls, 1, '缺口时读一次 Go 缓冲状态')

  // 同一游标重试：缺口不重复累计，也不再查一次 stats。
  priority.result = {
    epoch: 'e1',
    firstSeq: 10,
    lastSeq: 10,
    dropped: 9,
    records: [entry({ seq: 10, requestId: 'gap-10' })],
  }
  const retried = await service.pollOnce()
  assert.deepEqual(shapeOf(retried), { status: 'ok', epochChanged: false, gap: 8, ingested: 1, rejected: 0 })
  assert.equal(service.status().gapRecords, 8)
  assert.equal(priority.statsCalls, 1)
  assert.equal(service.status().lastSeq, 10)
})

test('轮询：门面没有 usage.stats 时缺口告警仍生效，不抛错', async (t) => {
  const priority = fakePriority({ withStats: false })
  const { service } = await boot(t, { priority })

  priority.result = {
    epoch: 'e1',
    firstSeq: 5,
    lastSeq: 5,
    dropped: 4,
    records: [entry({ seq: 5, requestId: 'no-stats-5' })],
  }
  const outcome = await service.pollOnce()
  assert.deepEqual(shapeOf(outcome), { status: 'ok', epochChanged: false, gap: 4, ingested: 1, rejected: 0 })
  assert.equal(service.status().gapRecords, 4)
  assert.equal(service.status().lastSeq, 5)
})

test('轮询：usage.stats 读取失败只少一段上下文，不影响落库', async (t) => {
  const priority = fakePriority()
  priority.usageStats = async () => {
    throw new Error('bridge down')
  }
  const { service } = await boot(t, { priority })

  priority.result = {
    epoch: 'e1',
    firstSeq: 3,
    lastSeq: 3,
    dropped: 2,
    records: [entry({ seq: 3, requestId: 'stats-down-3' })],
  }
  const outcome = await service.pollOnce()
  assert.deepEqual(shapeOf(outcome), { status: 'ok', epochChanged: false, gap: 2, ingested: 1, rejected: 0 })
  assert.equal(service.status().lastSeq, 3)
  assert.equal(service.status().records, 1)
})

test('轮询：拉取失败也计入连续失败，成功后清零', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority })

  const original = priority.usageSince
  priority.usageSince = async () => {
    throw new Error('bridge not ready')
  }
  const first = await service.pollOnce()
  assert.equal(first.status, 'error')
  assert.equal(service.status().consecutiveFailures, 1)
  assert.match(service.status().lastError ?? '', /bridge not ready/)
  assert.equal(service.status().lastSeq, 0)

  await service.pollOnce()
  assert.equal(service.status().consecutiveFailures, 2)
  assert.equal(service.status().lastSeq, 0, '拉取失败不能推进游标')

  priority.usageSince = original
  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'recover-1' })],
  }
  const recovered = await service.pollOnce()
  assert.equal(recovered.status, 'ok')
  assert.equal(service.status().consecutiveFailures, 0)
  assert.equal(service.status().lastError, null)
  assert.equal(service.status().lastSeq, 1)
})

// ───────────────────────────── 账号使用上报（usage/account-used） ─────────────────────────────

test('落库后发 usage/account-used：按账号集合化，重复 req_id 不算新使用', async (t) => {
  const priority = fakePriority()
  const world = await boot(t, { priority })
  const events: { accountIds: readonly string[]; at: string }[] = []
  world.ctx.on('usage/account-used', (payload) => {
    events.push(payload)
  })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 3,
    dropped: 0,
    records: [
      entry({ seq: 1, requestId: 'used-1', accountId: 'acc-a' }),
      entry({ seq: 2, requestId: 'used-2', accountId: 'acc-a' }),
      entry({ seq: 3, requestId: 'used-3', accountId: 'acc-b' }),
    ],
  }
  await world.service.pollOnce()
  assert.equal(events.length, 1, '一轮只发一个事件')
  assert.deepEqual([...events[0].accountIds].sort(), ['acc-a', 'acc-b'], '同一账号只出现一次')
  assert.ok(Number.isFinite(Date.parse(events[0].at)))

  // 同样的记录再落一次（INSERT OR IGNORE 全被忽略）→ 没有新落库就不该再发事件。
  priority.result = { ...priority.result, records: [
    entry({ seq: 1, requestId: 'used-1', accountId: 'acc-a' }),
    entry({ seq: 2, requestId: 'used-2', accountId: 'acc-a' }),
    entry({ seq: 3, requestId: 'used-3', accountId: 'acc-b' }),
  ] }
  await world.service.pollOnce()
  assert.equal(events.length, 1)
})

test('没有账号 id 的用量不发使用事件', async (t) => {
  const priority = fakePriority()
  const world = await boot(t, { priority })
  const events: unknown[] = []
  world.ctx.on('usage/account-used', (payload) => {
    events.push(payload)
  })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'no-account', accountId: undefined })],
  }
  await world.service.pollOnce()
  assert.equal(events.length, 0)
})

// ───────────────────────────── 坏记录隔离（有界出口） ─────────────────────────────

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 一批里同时有坏记录（时间非法）与正常记录；序号从 1 连续开始，不该出现 gap。 */
function mixedBatch(suffix: string) {
  return {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 2,
    dropped: 0,
    records: [
      entry({ seq: 1, requestId: `bad-${suffix}`, startedAt: 'not-a-timestamp' }),
      entry({ seq: 2, requestId: `good-${suffix}` }),
    ],
  }
}

test('隔离：阈值内整批回滚游标不动，到阈值后坏记录进隔离区、正常记录与游标照常前进', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority, rejectAfterFailures: 3 })
  priority.result = mixedBatch('a')

  for (let round = 1; round < 3; round += 1) {
    const failed = await service.pollOnce()
    assert.equal(failed.status, 'error', `第 ${round} 轮应整批回滚`)
    assert.equal(failed.rejected, 0)
    assert.equal(service.status().lastSeq, 0, '阈值内游标不能动')
    assert.equal(service.status().records, 0, '阈值内不能落半批')
    assert.equal(service.status().rejectedCount, 0, '阈值内不能隔离')
  }

  const isolated = await service.pollOnce()
  assert.deepEqual(shapeOf(isolated), { status: 'ok', epochChanged: false, gap: 0, ingested: 1, rejected: 1 })
  assert.deepEqual(
    isolated.persisted.map((item) => item.requestId),
    ['good-a'],
    '被隔离的记录不能进 persisted（否则结算会静默扣钱）',
  )
  assert.equal(service.status().lastSeq, 2, '隔离后游标必须前进')
  assert.equal(service.status().records, 1, '同批正常记录照常落库')
  assert.equal(service.status().rejectedCount, 1)
  assert.equal(service.status().rejectedPending, 1)

  const rejected = service.listRejected()
  assert.equal(rejected.total, 1)
  assert.equal(rejected.items[0]?.reqId, 'bad-a')
  assert.equal(rejected.items[0]?.status, 'pending')
  assert.equal(rejected.items[0]?.failures, 3, '记录的是隔离时的连续失败轮数')
  assert.match(rejected.items[0]?.error ?? '', /时间不合法/)
  assert.equal(JSON.parse(rejected.items[0]?.payload ?? '{}').requestId, 'bad-a', '原始载荷要留底')
})

test('隔离：同一条坏记录不会产生第二行，正常记录也只落一次', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority, rejectAfterFailures: 2 })

  priority.result = mixedBatch('dup')
  await service.pollOnce()
  const first = await service.pollOnce()
  assert.equal(first.rejected, 1)
  assert.equal(service.status().rejectedCount, 1)
  assert.equal(service.status().records, 1)

  // 再拉到同一批（例如 meta 写失败后重试）：隔离行靠 req_id 收敛，不会多一行。
  await service.pollOnce()
  const second = await service.pollOnce()
  assert.equal(second.rejected, 1)
  assert.equal(service.status().rejectedCount, 1, '同一条只应有一行')
  assert.equal(service.status().records, 1, '正常记录 INSERT OR IGNORE 不重复')
  assert.equal(service.listRejected().total, 1)
})

test('隔离区：忽略与重放的状态机、幂等与错误码', async (t) => {
  const priority = fakePriority()
  const billing = fakeBilling()
  const { service } = await boot(t, { priority, billing, rejectAfterFailures: 1 })
  priority.result = mixedBatch('ignore')
  const isolated = await service.pollOnce()
  assert.equal(isolated.rejected, 1)

  // 忽略：幂等；已忽略的不能再重放。
  service.ignoreRejected('bad-ignore')
  service.ignoreRejected('bad-ignore')
  assert.equal(service.status().rejectedPending, 0)
  assert.equal(service.listRejected().items[0]?.status, 'ignored')
  await assert.rejects(service.replayRejected('bad-ignore'), /已忽略的隔离记录不再重放/)

  // 不存在：稳定错误码。
  assert.throws(() => service.ignoreRejected('nope'), /没有这条隔离记录/)
  await assert.rejects(service.replayRejected('nope'), /没有这条隔离记录/)

  const codeOf = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
  try {
    await service.replayRejected('bad-ignore')
    assert.fail('应当抛错')
  } catch (error) {
    assert.equal(codeOf(error), 'USAGE_REJECTED_STATE')
  }
})

test('隔离区列表：分页、状态筛选与计数', async (t) => {
  const priority = fakePriority()
  const { service } = await boot(t, { priority, rejectAfterFailures: 1 })
  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 3,
    dropped: 0,
    records: [
      entry({ seq: 1, requestId: 'list-bad-1', startedAt: 'nope' }),
      entry({ seq: 2, requestId: 'list-bad-2', startedAt: 'nope' }),
      entry({ seq: 3, requestId: 'list-good-3' }),
    ],
  }
  const isolated = await service.pollOnce()
  assert.equal(isolated.rejected, 2)
  assert.equal(isolated.ingested, 1)

  const firstPage = service.listRejected({ limit: 1, offset: 0 })
  assert.equal(firstPage.total, 2)
  assert.equal(firstPage.pending, 2)
  assert.equal(firstPage.items.length, 1)
  const secondPage = service.listRejected({ limit: 1, offset: 1 })
  assert.equal(secondPage.items.length, 1)
  assert.notEqual(firstPage.items[0]?.reqId, secondPage.items[0]?.reqId)

  service.ignoreRejected(firstPage.items[0]?.reqId ?? '')
  assert.equal(service.listRejected({ status: 'pending' }).total, 1)
  assert.equal(service.listRejected({ status: 'ignored' }).total, 1)
  assert.equal(service.listRejected().pending, 1)
  assert.throws(() => service.listRejected({ status: 'bogus' as never }), /隔离记录状态只能是/)
})

test('重放：按 req_id 幂等，重复重放不重复插入（模拟瞬时故障残留行）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dizzy-usage-rejected-'))
  const dataPath = join(dir, 'usage.db')
  const billing = fakeBilling()
  const world = await boot(t, { dataPath, billing })
  try {
    // 瞬时故障（比如 database is locked）留下的 pending 行：载荷本身是合法的。
    const valid = entry({ seq: 9, requestId: 'replay-9' })
    const db = new DatabaseSync(dataPath)
    const now = Date.now()
    db.prepare(
      `INSERT INTO usage_rejected
         (req_id, epoch, seq, payload, error, failures, status, first_failed_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run('replay-9', 'e1', 9, JSON.stringify(valid), 'database is locked', 10, now, now)
    db.close()

    const first = await world.service.replayRejected('replay-9')
    assert.deepEqual(first, { status: 'replayed', inserted: true })
    assert.equal(world.service.status().records, 1)
    assert.equal(world.service.status().rejectedPending, 0)
    assert.equal(world.service.listRejected().items[0]?.status, 'replayed')
    // 重放成功后必须补结算一次（fail-closed 的另一半：不能只记明细不扣钱）。
    assert.equal(billing.calls.length, 1)
    assert.equal(billing.calls[0]?.[0]?.requestId, 'replay-9')

    const again = await world.service.replayRejected('replay-9')
    assert.deepEqual(again, { status: 'replayed', inserted: false })
    assert.equal(world.service.status().records, 1, '重复重放不能重复插入')
    assert.equal(billing.calls.length, 1, '已 replayed 的记录不再结算（req_id 幂等）')

    // 载荷损坏时保持 pending 并明确报错（不能静默丢）。
    const broken = new DatabaseSync(dataPath)
    broken
      .prepare(
        `INSERT INTO usage_rejected
           (req_id, epoch, seq, payload, error, failures, status, first_failed_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run('broken-1', 'e1', 10, '{"requestId":"broken-1","startedAt":"nope"}', 'bad', 3, now, now)
    broken.close()
    await assert.rejects(world.service.replayRejected('broken-1'), /重放失败/)
    assert.equal(world.service.listRejected({ status: 'pending' }).total, 1)
  } finally {
    try {
      await world.fiber.dispose()
    } catch {
      // 卸载失败不影响断言结果。
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重放：结算插件不在运行 → 整体失败（fail-closed），记录保持 pending', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dizzy-usage-rejected-'))
  const dataPath = join(dir, 'usage.db')
  // 不提供 billing 服务：模拟结算插件被禁用。
  const world = await boot(t, { dataPath })
  try {
    const valid = entry({ seq: 9, requestId: 'replay-no-billing' })
    const db = new DatabaseSync(dataPath)
    const now = Date.now()
    db.prepare(
      `INSERT INTO usage_rejected
         (req_id, epoch, seq, payload, error, failures, status, first_failed_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run('replay-no-billing', 'e1', 9, JSON.stringify(valid), 'database is locked', 10, now, now)
    db.close()

    const codeOf = (error: unknown): string | undefined =>
      typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
    await assert.rejects(world.service.replayRejected('replay-no-billing'), (error: unknown) => {
      assert.equal(codeOf(error), 'USAGE_SETTLE_UNAVAILABLE')
      return true
    })
    // 关键：不能「只记明细不扣钱」就算成功——记录保持 pending（可重试），
    // 错误原因写回，管理面一眼能看到「结算插件没在运行」。
    assert.equal(world.service.status().rejectedPending, 1)
    const row = world.service.listRejected().items[0]
    assert.equal(row?.status, 'pending', '没结算成功就不能置 replayed')
    assert.match(row?.error ?? '', /结算插件未运行/)
    // 明细行可能已经写下（写明细在结算之前），但结算没发生、状态没推进：
    // 管理员启用结算插件后再次重放即可补结算（req_id 幂等，不会重复扣）。
    assert.equal(world.service.listRejected({ status: 'replayed' }).total, 0)
  } finally {
    try {
      await world.fiber.dispose()
    } catch {
      // 卸载失败不影响断言结果。
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置：隔离阈值默认 10、边界 1..1000，非法值让插件装载失败', async () => {
  const resolved = validateUsageConfig(undefined)
  assert.ok(!isIssueList(resolved))
  if (!isIssueList(resolved)) assert.equal(resolved.rejectAfterFailures, USAGE_DEFAULTS.rejectAfterFailures)
  assert.equal(USAGE_DEFAULTS.rejectAfterFailures, 10)
  assert.ok(!isIssueList(validateUsageConfig({ rejectAfterFailures: 1 })))
  assert.ok(!isIssueList(validateUsageConfig({ rejectAfterFailures: 1000 })))

  // 对照组：合法配置必须真的装载成功（否则下面的「装载失败」可能只是别的原因）。
  const okCtx = new Context()
  const okFiber = await okCtx.plugin(UsageService, {
    dataPath: ':memory:',
    pollIntervalMs: 60_000,
  })
  assert.equal(okFiber.state, FiberState.ACTIVE)
  assert.ok(okCtx.get('usage', false) !== undefined)
  try {
    await okFiber.dispose()
  } catch {
    // 清理忽略
  }

  for (const invalid of [0, -1, 1001]) {
    assert.ok(
      isIssueList(validateUsageConfig({ rejectAfterFailures: invalid })),
      `rejectAfterFailures=${invalid} 必须被拒绝`,
    )
    assert.ok(isIssueList(validateUsageConfig({ rejectAfterFailures: 1.5 })))
    assert.ok(isIssueList(validateUsageConfig({ rejectAfterFailures: '10' })))

    const ctx = new Context()
    let active = false
    try {
      const fiber = await ctx.plugin(UsageService, {
        dataPath: ':memory:',
        pollIntervalMs: 60_000,
        rejectAfterFailures: invalid,
      })
      active = fiber.state === FiberState.ACTIVE
      try {
        await fiber.dispose()
      } catch {
        // 清理忽略
      }
    } catch {
      active = false
    }
    assert.equal(active, false, `rejectAfterFailures=${invalid} 必须让插件装载失败`)
    assert.equal(ctx.get('usage', false), undefined, '非法配置不能构造出 usage 服务')
  }
})

test('保留期清理：只清 ignored 与过期的 replayed，pending 永不自动清', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dizzy-usage-prune-'))
  const dataPath = join(dir, 'usage.db')
  const world = await boot(t, { dataPath, retentionDays: 30 })
  try {
    const now = Date.parse('2026-10-28T12:00:00.000Z')
    const old = now - 31 * 86_400_000
    const fresh = now - 1 * 86_400_000
    const db = new DatabaseSync(dataPath)
    const insert = db.prepare(
      `INSERT INTO usage_rejected
         (req_id, epoch, seq, payload, error, failures, status, first_failed_at_ms, updated_at_ms)
       VALUES (?, 'e1', 0, '{"requestId":"x"}', 'bad', 10, ?, ?, ?)`,
    )
    insert.run('keep-pending-old', 'pending', old, old)
    insert.run('drop-ignored-old', 'ignored', old, old)
    insert.run('drop-replayed-old', 'replayed', old, old)
    insert.run('keep-replayed-fresh', 'replayed', fresh, fresh)
    db.close()

    const removed = world.service.pruneExpired(now)
    assert.equal(removed.records, 0, '明细清理不受隔离区影响')
    assert.equal(removed.rejected, 2, '只清 ignored 与过期的 replayed')

    const left = world.service.listRejected().items.map((row) => row.reqId).sort()
    assert.deepEqual(left, ['keep-pending-old', 'keep-replayed-fresh'])
    assert.equal(world.service.status().rejectedPending, 1, 'pending 超期也不能自动清')
  } finally {
    try {
      await world.fiber.dispose()
    } catch {
      // 卸载失败不影响断言结果。
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

// ───────────────────────────── 结算（billing） ─────────────────────────────

test('结算：落库后只把真正落库的记录交给 billing，不带金额', async (t) => {
  const priority = fakePriority()
  const billing = fakeBilling()
  const world = await boot(t, { priority, billing })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 2,
    dropped: 0,
    records: [
      entry({ seq: 1, requestId: 'settle-1', userId: '7', model: 'model-a', inputTokens: 10, outputTokens: 5 }),
      entry({ seq: 2, requestId: 'settle-2', userId: '8', model: 'model-b' }),
    ],
  }
  const outcome = await world.service.pollOnce()
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.ingested, 2)

  assert.equal(billing.calls.length, 1)
  const sent = billing.calls[0] ?? []
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0], {
    requestId: 'settle-1',
    userId: '7',
    accountId: 'account-1',
    model: 'model-a',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    startedAt: BASE_TIME,
  })
  assert.ok(!Object.hasOwn(sent[0] ?? {}, 'costMicro'), '价格事实不能从 usage 传来')
})

test('结算：被隔离的坏记录不结算（不能扣一笔查不到的钱）', async (t) => {
  const priority = fakePriority()
  const billing = fakeBilling()
  const world = await boot(t, { priority, billing, rejectAfterFailures: 1 })

  priority.result = mixedBatch('settle-isolated')
  const outcome = await world.service.pollOnce()
  assert.equal(outcome.rejected, 1)
  assert.equal(outcome.ingested, 1)

  assert.equal(billing.calls.length, 1)
  const sent = billing.calls[0] ?? []
  assert.equal(sent.length, 1, '只有真正落库的那条进结算批次')
  assert.equal(sent[0]?.requestId, 'good-settle-isolated')
  assert.ok(
    !sent.some((item) => item.requestId === 'bad-settle-isolated'),
    '被隔离的记录绝不能进结算批次',
  )
})

test('结算抛错：明细已落库但不推进游标，下一轮重放只补结算', async (t) => {
  const priority = fakePriority()
  const billing = fakeBilling()
  const world = await boot(t, { priority, billing })
  billing.fail = new Error('账本写不进去')

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 2,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'retry-1' }), entry({ seq: 2, requestId: 'retry-2' })],
  }
  const failed = await world.service.pollOnce()
  assert.equal(failed.status, 'error')
  assert.equal(failed.ingested, 2, '事实先留下')
  assert.equal(world.service.status().lastSeq, 0, '游标不能推进')
  assert.equal(world.service.status().epoch, null)

  // 下一轮：billing 恢复，同一批记录被重放——INSERT OR IGNORE 不新增，只补结算。
  billing.fail = undefined
  const retried = await world.service.pollOnce()
  assert.equal(retried.status, 'ok')
  assert.equal(retried.ingested, 0, '重复记录不重复落库')
  assert.equal(world.service.status().records, 2)
  assert.equal(world.service.status().lastSeq, 2)
  assert.equal(billing.calls.length, 2, '第二轮重放了同一批记录')
  assert.deepEqual(
    billing.calls[1]?.map((item) => item.requestId),
    ['retry-1', 'retry-2'],
  )
})

test('结算：缺 requestId / 时间非法的记录不进结算批次，也不让整轮抛错', async (t) => {
  const priority = fakePriority()
  const billing = fakeBilling()
  // 阈值 1：第一轮就走到有界隔离路径（坏记录被隔离，好记录照常落库）。
  const world = await boot(t, { priority, billing, rejectAfterFailures: 1 })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 3,
    dropped: 0,
    records: [
      { ...entry({ seq: 1, requestId: '' }) },
      { ...entry({ seq: 2, startedAt: 'not-a-timestamp' }) },
      entry({ seq: 3, requestId: 'good-one' }),
    ],
  }
  const outcome = await world.service.pollOnce()
  assert.equal(outcome.status, 'ok', '一条坏记录不许把整轮卡死')
  assert.equal(outcome.rejected, 2, '两条坏记录进隔离区')
  assert.equal(world.service.status().lastSeq, 3, '游标照常推进')

  const sent = billing.calls[0] ?? []
  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.requestId, 'good-one')
})

test('结算：billing 不在运行（被禁用）——照常落库，只是不结算', async (t) => {
  const priority = fakePriority()
  const world = await boot(t, { priority })

  priority.result = {
    epoch: 'e1',
    firstSeq: 1,
    lastSeq: 1,
    dropped: 0,
    records: [entry({ seq: 1, requestId: 'no-billing' })],
  }
  const outcome = await world.service.pollOnce()
  assert.equal(outcome.status, 'ok')
  assert.equal(world.service.status().records, 1)
  assert.equal(world.service.status().lastSeq, 1)
})

test('卸载：轮询定时器停止、数据库连接回收（无残留）', async (t) => {
  const priority = fakePriority()
  const ctx = new Context()
  ctx.provide('accountPriority', priority)
  const fiber = await ctx.plugin(UsageService, {
    dataPath: ':memory:',
    // 250 是 schema 允许的最小间隔；这里刻意用最短的，好观察定时器是否真被清掉。
    pollIntervalMs: 250,
    rejectAfterFailures: 10,
  })
  const service = ctx.get('usage') as UsageService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 已卸载时忽略
    }
  })

  await waitFor(() => priority.calls.length > 0, 2_000)
  await fiber.dispose()
  const callsAfterDispose = priority.calls.length
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(priority.calls.length, callsAfterDispose, '卸载后定时器必须停')
  assert.throws(() => service.list({ fromMs: 0, toMs: 1 }), /尚未装载完成/)
  assert.throws(() => service.listRejected(), /尚未装载完成/)
})

// ───────────────────────────────── 首字延迟（TTFT）与单条详情 ─────────────────────────────────

test('TTFT：流式记值，非流式 / 未采集落 NULL', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ requestId: 'ttft-stream', stream: true, ttftMs: 123 }))
  service.ingest(entry({ requestId: 'ttft-absent' }))
  service.ingest(entry({ requestId: 'ttft-zero', ttftMs: 0 }))

  const byReqId = new Map(service.list({ ...ALL_TIME }).items.map((row) => [row.reqId, row]))
  assert.equal(byReqId.get('ttft-stream')?.ttftMs, 123)
  assert.equal(byReqId.get('ttft-absent')?.ttftMs, null, '非流式请求没有 ttftMs 键 → 落 NULL，不能落 0')
  assert.equal(byReqId.get('ttft-zero')?.ttftMs, null, '0 与「没采集」同义，也要落 NULL')
})

test('旧库升级：缺 ttft_ms 时自动补列，历史记录保持 NULL', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dizzy-usage-migrate-'))
  const path = join(dir, 'usage.db')

  // 造一个「升级前」的库：先按新 schema 建表，再删掉 ttft_ms，最后塞一条历史记录。
  // 这样测的是真正的 ALTER 补列路径，而不是新表的 CREATE。
  const legacy = new DatabaseSync(path)
  legacy.exec(USAGE_SCHEMA)
  legacy.exec('ALTER TABLE usage_records DROP COLUMN ttft_ms')
  legacy
    .prepare(
      'INSERT INTO usage_records (req_id, started_at_ms, day, model, ingested_at_ms) VALUES (?, ?, ?, ?, ?)',
    )
    .run('legacy-1', Date.parse(BASE_TIME), '2026-10-21', 'model-a', Date.now())
  legacy.close()

  // 打开时必须自动补列；旧库不能因为缺列被拒（AGENTS.md §5.2）。
  const db = openUsageDatabase(path)
  // 先关连接再删目录：Windows 上打开中的库文件删不掉（EPERM）。
  t.after(() => {
    try {
      db.close()
    } catch {
      // 已关闭时忽略
    }
    rmSync(dir, { recursive: true, force: true })
  })
  const columns = db.prepare('PRAGMA table_info(usage_records)').all() as { name?: unknown }[]
  assert.ok(
    columns.some((column) => column.name === 'ttft_ms'),
    '升级后必须补出 ttft_ms 列',
  )
  const legacyRow = db.prepare('SELECT ttft_ms FROM usage_records WHERE req_id = ?').get('legacy-1') as
    | { ttft_ms?: unknown }
    | undefined
  assert.equal(legacyRow?.ttft_ms ?? null, null, '历史记录的首字延迟必须是 NULL')
})

test('单条详情：按 reqId 取（含费用与四桶之外的标记），查不到返回 null', async (t) => {
  const { service } = await boot(t, { pricing: fakePricing() })
  service.ingest(
    entry({ requestId: 'detail-1', stream: true, ttftMs: 42, inputTokens: 10, outputTokens: 5 }),
  )

  const row = service.get('detail-1')
  assert.ok(row !== null)
  assert.equal(row.reqId, 'detail-1')
  assert.equal(row.ttftMs, 42)
  assert.equal(row.reasoningTokens, 3)
  assert.equal(row.usagePresent, true)
  assert.equal(row.usageComplete, true)
  // model-a 的假价格：input 1 微元 + output 10 微元。
  assert.equal(row.costMicros, '60')
  assert.equal(service.get('missing'), null)
})
