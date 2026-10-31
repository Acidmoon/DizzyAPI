/**
 * `summary()` 的两个新维度（「按接口」「按用户」）与探测流量排除。
 *
 * 三组必须钉住的场景（`总工` 明说要覆盖「空数据 / 单维度 / 超 12 项归并」）：
 * 1. 空数据：两个维度都是空数组，不是「一个空项」；
 * 2. 单维度：一个 key / 一个用户时只有一项，占比 100%；
 * 3. 超 12 项：服务端归并成 11 + 「其他」，且**不丢钱**。
 *
 * 还有两条硬边界：
 * - **按需开启**：不传 `{ apiKeys: true }` 就不跑那两条 GROUP BY（`gate-feed` 依赖这点）；
 * - **探测流量排除**：`api_key_name` 以 `__probe__` 开头的记录不进任何统计 / 列表 / 导出。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, type Fiber } from 'cordis'
import UsageService, { PIE_OTHER_LABEL, type UsageEntry } from '../src/index.ts'

const ALL_TIME = { fromMs: 0, toMs: Number.MAX_SAFE_INTEGER } as const
const BASE_TIME = '2026-10-21T01:00:00.000Z'
/**
 * 真实时间窗（包住 `BASE_TIME`）。
 *
 * **导出的文件名要由 toMs 推日期**（`usageCsvFilename` 走 `Date.toISOString()`），
 * 拿 `ALL_TIME` 那种 `MAX_SAFE_INTEGER` 会直接 `RangeError: Invalid time value`。
 */
const REAL_RANGE = {
  fromMs: Date.parse(BASE_TIME) - 86_400_000,
  toMs: Date.parse(BASE_TIME) + 86_400_000,
} as const

interface World {
  readonly service: UsageService
  readonly fiber: Fiber
}

async function boot(t: TestContext): Promise<World> {
  const ctx = new Context()
  // 价格：input 1 微元 / token，output 10 微元 / token —— 便于逐字手算。
  ctx.provide('pricing', {
    quote(_model: string, tokens: { inputTokens: number; outputTokens: number }): string {
      return (BigInt(tokens.inputTokens) + BigInt(tokens.outputTokens) * 10n).toString()
    },
  })
  const fiber = await ctx.plugin(UsageService, {
    dataPath: ':memory:',
    pollIntervalMs: 60_000,
    retentionDays: 90,
    maxBatch: 500,
    rejectAfterFailures: 10,
  })
  const service = ctx.get('usage') as UsageService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // dispose 返回 void；清理忽略异常。
    }
  })
  return { service, fiber }
}

let sequence = 0

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  sequence += 1
  return {
    seq: sequence,
    epoch: 'e1',
    requestId: `req-${String(sequence)}`,
    userId: '1',
    keyId: 'key-1',
    keyName: '主密钥',
    profile: 'billed',
    accountId: 'account-1',
    model: 'model-a',
    upstreamModel: 'upstream-a',
    protocol: 'openai-chat',
    upstreamProtocol: 'openai-chat',
    stream: false,
    status: 200,
    errorCode: '',
    inputTokens: 10,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 10,
    usagePresent: true,
    usageComplete: true,
    durationMs: 120,
    clientIp: '127.0.0.1',
    attempts: 1,
    startedAt: BASE_TIME,
    ...overrides,
  } as UsageEntry
}

test('空数据：两个维度都是空数组（不是一个空项）', async (t) => {
  const { service } = await boot(t)
  const summary = service.summary({ ...ALL_TIME }, { apiKeys: true, users: true })
  assert.deepEqual(summary.apiKeys, [])
  assert.deepEqual(summary.users, [])
  assert.equal(summary.totals.requests, 0)
})

test('按需开启：不传选项时两条新维度不出现（gate-feed 只要 totals）', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ keyId: 'k1', keyName: '生产' }))
  const plain = service.summary({ ...ALL_TIME })
  assert.deepEqual(plain.apiKeys, [])
  assert.deepEqual(plain.users, [])
  // models 仍然照旧有（既有契约不因为新维度改动）。
  assert.equal(plain.models.length, 1)
})

test('单维度：一个 key / 一个用户时只有一项', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ keyId: 'k1', keyName: '生产密钥', userId: '7' }))
  const summary = service.summary({ ...ALL_TIME }, { apiKeys: true, users: true })

  assert.equal(summary.apiKeys.length, 1)
  assert.equal(summary.apiKeys[0]?.apiKeyId, 'k1')
  assert.equal(summary.apiKeys[0]?.apiKeyName, '生产密钥')
  assert.equal(summary.apiKeys[0]?.costMicros, '10')

  assert.equal(summary.users.length, 1)
  assert.equal(summary.users[0]?.userId, 7)
  assert.equal(summary.users[0]?.costMicros, '10')
})

test('按 key / 按用户分别聚合，费用按模型单价算再相加', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ keyId: 'k1', keyName: '甲', userId: '1', inputTokens: 10, outputTokens: 1 }))
  service.ingest(entry({ keyId: 'k1', keyName: '甲', userId: '2', inputTokens: 20, outputTokens: 0 }))
  service.ingest(entry({ keyId: 'k2', keyName: '乙', userId: '2', inputTokens: 5, outputTokens: 0 }))

  const summary = service.summary({ ...ALL_TIME }, { apiKeys: true, users: true })

  const byId = new Map(summary.apiKeys.map((item) => [item.apiKeyId, item.costMicros]))
  // 甲：10 + 1*10 = 20；再加 20 = 40。乙：5。
  assert.equal(byId.get('k1'), '40')
  assert.equal(byId.get('k2'), '5')

  const byUser = new Map(summary.users.map((item) => [item.userId, item.costMicros]))
  // 用户 1：10 + 1*10 = 20；用户 2：20 + 5 = 25
  assert.equal(byUser.get(1), '20')
  assert.equal(byUser.get(2), '25')
})

test('超 12 项：归并成 11 项 + 「其他」，且总额不丢', async (t) => {
  const { service } = await boot(t)
  // 20 个 key，每个费用不同（input=1 微元/条 → cost = 1）。
  for (let index = 0; index < 20; index += 1) {
    service.ingest(
      entry({
        keyId: `k${String(index)}`,
        keyName: `密钥 ${String(index)}`,
        userId: String(index % 3),
        inputTokens: index + 1,
        outputTokens: 0,
        totalTokens: index + 1,
      }),
    )
  }
  const summary = service.summary({ ...ALL_TIME }, { apiKeys: true, users: true })

  assert.equal(summary.apiKeys.length, 12)
  const other = summary.apiKeys[11]
  assert.ok(other !== undefined)
  assert.equal(other.apiKeyName, PIE_OTHER_LABEL)
  assert.equal(other.other, true)

  // 不丢钱：12 项之和 == totals。
  const sum = summary.apiKeys.reduce((total, item) => total + BigInt(item.costMicros), 0n)
  assert.equal(sum.toString(), summary.totals.costMicros)

  // 归并按**费用降序**取前 11、尾部归并，所以「其他」是费用最低的那 9 个：
  // 20 个 key 的费用是 1..20，去掉最高的 11..20，剩下 1..9 → 45。
  const tail = Array.from({ length: 9 }, (_, index) => BigInt(index + 1))
  assert.equal(other.costMicros, tail.reduce((sum2, value) => sum2 + value, 0n).toString())

  // 用户只有 3 个，不该被归并。
  assert.equal(summary.users.length, 3)
  assert.equal(summary.users.some((item) => item.other === true), false)
})

test('探测流量（__probe__ 前缀）不进统计：summary / list / 导出都不含它', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ keyId: 'k1', keyName: '正常密钥', inputTokens: 10 }))
  service.ingest(entry({ keyId: 'p1', keyName: '__probe__dizzy', inputTokens: 999, totalTokens: 999 }))

  const summary = service.summary({ ...ALL_TIME }, { apiKeys: true, users: true })
  assert.equal(summary.totals.requests, 1)
  assert.equal(summary.totals.costMicros, '10')
  assert.equal(summary.apiKeys.length, 1)
  assert.equal(summary.apiKeys[0]?.apiKeyId, 'k1')

  const page = service.list({ ...ALL_TIME })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0]?.apiKeyName, '正常密钥')

  const csv = service.exportCsv({ ...REAL_RANGE })
  assert.ok(!csv.content.includes('__probe__'), '导出里出现了探测流量')
})

test('includeProbe: true 时才看得到探测流量（给探测自己的统计用）', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ keyId: 'p1', keyName: '__probe__dizzy', inputTokens: 7 }))
  const summary = service.summary({ ...ALL_TIME, includeProbe: true }, { apiKeys: true })
  assert.equal(summary.totals.requests, 1)
  assert.equal(summary.apiKeys[0]?.apiKeyName, '__probe__dizzy')
})

test('键名前缀按「前 9 个字符」精确比较：`_xprobe__` 不算探测', async (t) => {
  const { service } = await boot(t)
  // LIKE 里的 `_` 是通配符，若用 LIKE 会误伤这种名字；这里钉住用的是 substr 精确比较。
  service.ingest(entry({ keyId: 'k1', keyName: '_xprobe__abc', inputTokens: 4 }))
  const summary = service.summary({ ...ALL_TIME })
  assert.equal(summary.totals.requests, 1)
})

test('按用户维度跟 range 联动（不是 stats.topUsers 那种 30 天固定窗口）', async (t) => {
  const { service } = await boot(t)
  service.ingest(entry({ userId: '1', startedAt: '2026-10-01T00:00:00.000Z', inputTokens: 1 }))
  service.ingest(entry({ userId: '2', startedAt: '2026-10-21T00:00:00.000Z', inputTokens: 2 }))

  const recent = service.summary(
    { fromMs: Date.parse('2026-10-20T00:00:00.000Z'), toMs: Date.parse('2026-10-22T00:00:00.000Z') },
    { users: true },
  )
  assert.deepEqual(recent.users.map((item) => item.userId), [2])

  const all = service.summary({ ...ALL_TIME }, { users: true })
  assert.deepEqual(all.users.map((item) => item.userId).sort((a, b) => a - b), [1, 2])
})
