/**
 * 闸门快照推送插件的测试（假 pricing / 假桥 / 假 apiKey / 假 usage）。
 *
 * 守四件事：
 *  1. 价格快照与 key 消费快照都真的推了出去，且**只算配了金额上限的 key**；
 *  2. **心跳式**：内容不变也推，revision 相同、generation 递增（Go 按 TTL 判新鲜度，
 *     「没变就跳过」会让定价闸门 fail-closed 全 503）；
 *  3. 价格形状不合法时整份不推（推一份注定被 Go 拒绝的快照只会让闸门一直 503）；
 *  4. `*` 兜底价原样推给 Go（通配口径两处必须一致）。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import GateFeedService, {
  type GateFeedConfig,
  type KeySpendSnapshotPayload,
  type PricingSnapshotPayload,
} from '../src/index.ts'

interface Price {
  model: string
  inputPerMillion: string
  outputPerMillion: string
  cacheReadPerMillion: string
  cacheWritePerMillion: string
}

class FakePricing extends Service {
  prices: Price[] = []

  constructor(ctx: Context) {
    super(ctx, 'pricing')
  }

  list(): readonly Price[] {
    return this.prices.map((price) => ({ ...price }))
  }
}

class FakeGateway extends Service {
  pricingPushes: PricingSnapshotPayload[] = []
  spendPushes: KeySpendSnapshotPayload[] = []
  failures = 0

  constructor(ctx: Context) {
    super(ctx, 'accountPriority')
  }

  async replacePricing(snapshot: PricingSnapshotPayload) {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('桥断线')
    }
    this.pricingPushes.push(snapshot)
    return {
      ready: true,
      revision: snapshot.revision,
      generation: snapshot.generation,
      prices: snapshot.prices.length,
      wildcard: snapshot.prices.some((price) => price.model === '*'),
      updatedAt: new Date().toISOString(),
    }
  }

  async pricingStatus() {
    return { ready: true, size: 0, ageMs: 0, ttlMs: 200_000 }
  }

  async replaceKeySpend(snapshot: KeySpendSnapshotPayload) {
    this.spendPushes.push(snapshot)
    return {
      ready: true,
      revision: snapshot.revision,
      generation: snapshot.generation,
      entries: snapshot.entries.length,
      updatedAt: new Date().toISOString(),
    }
  }

  async keySpendStatus() {
    return { ready: true, size: 0, ageMs: 0, ttlMs: 200_000 }
  }
}

/** api-key 的只读视图：本插件只用 id 与金额上限。 */
class FakeApiKey extends Service {
  keys: { id: string; spendingLimitMicros: string | null }[] = []

  constructor(ctx: Context) {
    super(ctx, 'apiKey')
  }

  async listAll() {
    return this.keys.map((key) => ({ ...key }))
  }
}

/** 用量汇总：读取时按价格表算费用，这里直接给固定值。 */
class FakeUsage extends Service {
  costs = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  summary(query: { apiKeyId?: string }) {
    const costMicros = this.costs.get(query.apiKeyId ?? '') ?? '0'
    return { totals: { requests: 1, costMicros } }
  }
}

interface World {
  readonly ctx: Context
  readonly feed: GateFeedService
  readonly pricing: FakePricing
  readonly gateway: FakeGateway
  readonly apiKey: FakeApiKey
  readonly usage: FakeUsage
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, config: GateFeedConfig = {}): Promise<World> {
  // 解析后的配置形状才是插件的构造参数：schema 校验在真启动时由 cordis 完成，
  // 测试里直接给一份完整配置，避免每个用例都重复写三个字段。
  const resolved = {
    enabled: true,
    pollIntervalMs: 60_000,
    debounceMs: 1_000,
    ...config,
  }
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakePricing)
  await ctx.plugin(FakeGateway)
  await ctx.plugin(FakeApiKey)
  await ctx.plugin(FakeUsage)
  const fiber = await ctx.plugin(GateFeedService, resolved)
  t.after(async () => {
    await fiber.dispose()
  })
  const world: World = {
    ctx,
    feed: ctx.get('gateFeed') as unknown as GateFeedService,
    pricing: ctx.get('pricing') as unknown as FakePricing,
    gateway: ctx.get('accountPriority') as unknown as FakeGateway,
    apiKey: ctx.get('apiKey') as unknown as FakeApiKey,
    usage: ctx.get('usage') as unknown as FakeUsage,
    dispose: async () => {
      await fiber.dispose()
    },
  }
  // 启动时已经推过一轮；清掉，让每个用例只看自己那几轮。
  world.gateway.pricingPushes = []
  world.gateway.spendPushes = []
  return world
}

function price(model: string): Price {
  return {
    model,
    inputPerMillion: '1.5',
    outputPerMillion: '3',
    cacheReadPerMillion: '0',
    cacheWritePerMillion: '0',
  }
}

test('心跳式推送：内容不变也推，revision 不变、generation 递增', async (t) => {
  const world = await boot(t, { pollIntervalMs: 60_000 })
  world.pricing.prices = [price('deepseek-flash')]

  await world.feed.pushNow()
  await world.feed.pushNow()

  assert.equal(world.gateway.pricingPushes.length, 2)
  const [first, second] = world.gateway.pricingPushes
  assert.equal(first!.revision, second!.revision, '内容没变时 revision 必须相同')
  assert.ok(second!.generation > first!.generation, 'generation 必须递增（心跳靠它刷新 Go 的 TTL）')
  assert.deepEqual(
    first!.prices.map((item) => item.model),
    ['deepseek-flash'],
  )
})

test('只给配了金额上限的 key 算消费；金额原样是十进制微元字符串', async (t) => {
  const world = await boot(t, { pollIntervalMs: 60_000 })
  world.pricing.prices = [price('deepseek-flash')]
  world.apiKey.keys = [
    { id: 'key-limited', spendingLimitMicros: '1000' },
    { id: 'key-free', spendingLimitMicros: null },
  ]
  world.usage.costs.set('key-limited', '999')

  await world.feed.pushNow()

  const spend = world.gateway.spendPushes.at(-1)!
  assert.deepEqual(spend.entries, [{ keyId: 'key-limited', spentMicros: '999' }])
  assert.equal(world.feed.status().limitedKeys, 1)
})

test('价格形状不合法时整份不推（不推注定被 Go 拒绝的快照）', async (t) => {
  const world = await boot(t, { pollIntervalMs: 60_000 })
  const bad = price('m')
  bad.inputPerMillion = '-1'
  world.pricing.prices = [bad]

  await world.feed.pushNow()

  assert.equal(world.gateway.pricingPushes.length, 0)
  assert.equal(world.gateway.spendPushes.length, 0)
  assert.ok(world.feed.status().failures >= 1)
  assert.ok(world.feed.status().lastError !== null)
})

test('* 兜底价原样推给 Go（通配口径两处一致）', async (t) => {
  const world = await boot(t, { pollIntervalMs: 60_000 })
  world.pricing.prices = [price('*')]

  await world.feed.pushNow()

  const pushed = world.gateway.pricingPushes.at(-1)!
  assert.deepEqual(
    pushed.prices.map((item) => item.model),
    ['*'],
  )
})

test('api-key / usage 缺席时仍推价格快照，消费快照是空的', async (t) => {
  const world = await boot(t, { pollIntervalMs: 60_000 })
  world.pricing.prices = [price('deepseek-flash')]
  // 让 apiKey 服务看起来「不可用」：直接清空 keys，模拟没有 key 时的空快照。
  world.apiKey.keys = []

  await world.feed.pushNow()

  assert.equal(world.gateway.pricingPushes.length, 1, '价格快照与 apiKey 无关，必须照推')
  assert.deepEqual(world.gateway.spendPushes.at(-1)!.entries, [])
})
