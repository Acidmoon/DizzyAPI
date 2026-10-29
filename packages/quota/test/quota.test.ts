/**
 * 余额只读快照推送插件的测试。
 *
 * 用假的 `user` 与假的 `accountPriority`（桥的持有者）验证：
 * - 首次 / 周期推送的内容与 revision 稳定性；
 * - 余额变更事件经 debounce 触发补推，非余额字段不触发；
 * - 推送失败记错误、节流告警，并能重试成功；
 * - 坏余额数据整份不推（不静默跳过）；
 * - 卸载后定时器与 debounce 都停（禁用不留残余）。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import QuotaService, {
  heartbeatTooSlow,
  type QuotaConfig,
  type QuotaSnapshotPayload,
  type ResolvedQuotaConfig,
} from '../src/index.ts'

interface Entry {
  userId: string
  balanceMicros: string
  /** 用户级并发上限；缺省 = 不限（与 user 插件的 balanceSnapshot 同形状）。 */
  concurrencyLimit?: number | null
}

class FakeUser extends Service {
  entries: Entry[] = []
  calls = 0

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  async balanceSnapshot() {
    this.calls += 1
    return { entries: this.entries.map((entry) => ({ ...entry })) }
  }
}

class FakeGateway extends Service {
  pushed: QuotaSnapshotPayload[] = []
  failures = 0
  ttlMs = 200_000

  constructor(ctx: Context) {
    super(ctx, 'accountPriority')
  }

  async replaceQuota(snapshot: QuotaSnapshotPayload) {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('桥断线')
    }
    this.pushed.push(snapshot)
    return {
      ready: true,
      revision: snapshot.revision,
      generation: snapshot.generation,
      entries: snapshot.entries.length,
      updatedAt: new Date().toISOString(),
    }
  }

  async quotaStatus() {
    return { ready: this.pushed.length > 0, size: 0, ageMs: 0, ttlMs: this.ttlMs }
  }
}

interface World {
  readonly ctx: Context
  readonly quota: QuotaService
  readonly user: FakeUser
  readonly gateway: FakeGateway
  readonly fiber: { dispose(): Promise<void> | void }
}

async function boot(
  t: TestContext,
  config: QuotaConfig = {},
  setup?: (gateway: FakeGateway) => void,
): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeUser)
  await ctx.plugin(FakeGateway)
  const user = ctx.get('user') as unknown as FakeUser
  const gateway = ctx.get('accountPriority') as unknown as FakeGateway
  user.entries = [
    { userId: '2', balanceMicros: '-1500000' },
    { userId: '1', balanceMicros: '5000000' },
  ]
  setup?.(gateway)
  const fiber = await ctx.plugin(QuotaService, {
    enabled: true,
    // 默认把轮询周期设得很长：绝大多数用例靠 pushNow / debounce 精确控制推送次数，
    // 定时器只在「心跳」那条用例里显式调小。
    pollIntervalMs: 60_000,
    debounceMs: 100,
    ...config,
  } as ResolvedQuotaConfig)
  const quota = ctx.get('quota') as QuotaService
  // 插件装载时会立刻推一次（start）；等它落地，用例才好用「相对次数」断言，
  // 不会因为这次启动推送而随机差一。
  await sleep(20)
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 卸载里的清理错误不该让用例失败。
    }
  })
  return { ctx, quota, user, gateway, fiber }
}

/** 触发余额变更事件：事件声明在 user 插件里，这里用最小结构模拟。 */
function emitUserChanged(ctx: Context, payload: { readonly fields?: readonly string[] }): void {
  const emitter = ctx as unknown as {
    emit(event: string, payload: unknown): void
  }
  emitter.emit('user/changed', payload)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('首次推送：版本 / 序号 / 稳定排序的条目与 revision', async (t) => {
  const world = await boot(t)

  // 装载即推一次（start），别让 Go 等第一个轮询周期。
  assert.equal(world.gateway.pushed.length, 1)
  const payload = world.gateway.pushed[0] as QuotaSnapshotPayload
  assert.equal(payload.version, 1)
  assert.ok(payload.generation > 0, 'generation 必须是正数')
  assert.match(payload.revision, /^[0-9a-f]{32}$/)
  // 排序稳定：userId 按数值升序，而不是插入顺序。
  // concurrencyLimit 与余额同源：没设上限就是 null（Go 侧当「不限」）。
  assert.deepEqual(payload.entries, [
    { userId: '1', balanceMicros: '5000000', concurrencyLimit: null },
    { userId: '2', balanceMicros: '-1500000', concurrencyLimit: null },
  ])

  const status = world.quota.status()
  assert.equal(status.lastRevision, payload.revision)
  assert.equal(status.pushes, 1)
  assert.equal(status.heartbeats, 0, '首推不是心跳')
  assert.equal(status.lastError, null)
  assert.ok(status.lastPushAt !== null)
})

test('心跳：内容没变也必须再推（revision 相同、generation 递增）', async (t) => {
  const world = await boot(t)
  const base = world.gateway.pushed.length
  await world.quota.pushNow()
  await world.quota.pushNow()

  // 这就是 2026-10-29 生产事故的回归断言：以前「内容没变就跳过」，
  // Go 侧 15 秒 TTL 一到就判定快照过期 → 闸门放行 → 余额 -97 仍然 200。
  assert.equal(world.gateway.pushed.length, base + 2, '内容没变也必须再推：Go 按 TTL 判新鲜度')
  const first = world.gateway.pushed[base] as QuotaSnapshotPayload
  const second = world.gateway.pushed[base + 1] as QuotaSnapshotPayload
  assert.equal(second.revision, first.revision, '内容没变 → revision 不变')
  assert.ok(second.generation > first.generation, 'generation 必须递增，Go 才会刷新 updatedAt')

  const status = world.quota.status()
  assert.equal(status.heartbeats, 2, '两次手动推送内容都没变，都算心跳')
  assert.ok(status.lastSuccessAt !== null)
})

test('心跳：定时器每个周期都推一次，不需要手动触发', async (t) => {
  // 配置下限是 pollIntervalMs ≥ 250，所以这里用 250 并等三个周期。
  const world = await boot(t, { pollIntervalMs: 250 })
  await sleep(900)

  const status = world.quota.status()
  assert.ok(status.pushes >= 3, `连续多个周期都该推送，实际 ${String(status.pushes)} 次`)
  const revisions = new Set(world.gateway.pushed.map((payload) => payload.revision))
  assert.equal(revisions.size, 1, '余额没变时所有心跳的 revision 相同')
  assert.ok(status.heartbeats >= 2, '除首推之外都是心跳')
  // generation 单调递增，Go 侧才会接受（相等会被判幂等、不会刷新 updatedAt）。
  const generations = world.gateway.pushed.map((payload) => payload.generation)
  for (let index = 1; index < generations.length; index += 1) {
    assert.ok(
      (generations[index] as number) > (generations[index - 1] as number),
      `generation 必须严格递增：${generations.join(', ')}`,
    )
  }
})

test('余额变了 revision 才变；generation 始终递增', async (t) => {
  const world = await boot(t)
  const base = world.gateway.pushed.length
  await world.quota.pushNow()

  world.user.entries = [
    { userId: '1', balanceMicros: '4000000' },
    { userId: '2', balanceMicros: '-1500000' },
  ]
  await world.quota.pushNow()
  assert.equal(world.gateway.pushed.length, base + 2)
  const before = world.gateway.pushed[base] as QuotaSnapshotPayload
  const after = world.gateway.pushed[base + 1] as QuotaSnapshotPayload
  assert.notEqual(after.revision, before.revision, '余额变了 revision 必须变')
  assert.ok(after.generation > before.generation, 'generation 单调递增')
})

test('余额变更事件经 debounce 补推；非余额字段不触发', async (t) => {
  const world = await boot(t)
  const base = world.gateway.pushed.length

  // 改名之类与余额无关：不触发。
  emitUserChanged(world.ctx, { fields: ['name'] })
  await sleep(250)
  assert.equal(world.gateway.pushed.length, base)

  world.user.entries = [{ userId: '1', balanceMicros: '3000000' }]
  emitUserChanged(world.ctx, { fields: ['balance'] })
  await sleep(300)
  assert.equal(world.gateway.pushed.length, base + 1, '余额变更后应补推一次')
  assert.deepEqual((world.gateway.pushed[base] as QuotaSnapshotPayload).entries, [
    { userId: '1', balanceMicros: '3000000', concurrencyLimit: null },
  ])
})

test('用户级并发上限随余额快照一起推（同一条心跳帧）', async (t) => {
  const world = await boot(t)
  world.user.entries = [
    { userId: '1', balanceMicros: '5000000', concurrencyLimit: 3 },
    { userId: '2', balanceMicros: '-1500000' },
  ]
  await world.quota.pushNow()

  const payload = world.gateway.pushed.at(-1) as QuotaSnapshotPayload
  assert.deepEqual(payload.entries, [
    { userId: '1', balanceMicros: '5000000', concurrencyLimit: 3 },
    { userId: '2', balanceMicros: '-1500000', concurrencyLimit: null },
  ])
})

test('推送失败：记错误、保证重试，成功后清空', async (t) => {
  const world = await boot(t)
  const base = world.gateway.pushed.length

  world.gateway.failures = 1
  world.user.entries = [{ userId: '1', balanceMicros: '100' }]
  await world.quota.pushNow()
  assert.notEqual(world.quota.status().lastError, null, '失败必须记下来')
  assert.ok(world.quota.status().failures >= 1)

  await world.quota.pushNow()
  assert.equal(world.quota.status().lastError, null, '成功后清空错误')
  assert.equal(world.gateway.pushed.length, base + 1)
})

test('连续失败暴露 failureStreak（持续失效不能被节流藏起来），成功归零', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()

  // 连续三次失败：streak 必须一路涨到 3（告警只在第 1 次与每 10 次触发）。
  world.gateway.failures = 3
  await world.quota.pushNow()
  await world.quota.pushNow()
  await world.quota.pushNow()
  assert.equal(world.quota.status().failureStreak, 3, '连续失败次数要能读出来')
  assert.ok(world.quota.status().failures >= 3)

  await world.quota.pushNow()
  assert.equal(world.quota.status().failureStreak, 0, '成功一次即归零')
  assert.equal(world.quota.status().lastError, null)
})

test('坏余额数据整份不推，错误明确', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()
  const before = world.gateway.pushed.length

  world.user.entries = [{ userId: '1', balanceMicros: '1.5' }]
  await world.quota.pushNow()

  assert.equal(world.gateway.pushed.length, before, '坏数据不许推给 Go')
  const error = world.quota.status().lastError
  assert.ok(error !== null && error.includes('余额不是整数最小单位'), `错误应说明原因：${error}`)
})

test('卸载后定时器与 debounce 都停，不再读余额', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()
  await world.fiber.dispose()

  const callsAfterDispose = world.user.calls
  emitUserChanged(world.ctx, { fields: ['balance'] })
  await sleep(600)
  assert.equal(world.user.calls, callsAfterDispose, '卸载后不该再读余额')
  assert.equal(world.quota.status().inFlight, false)
})

test('配置非法直接拒绝构造', async () => {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeUser)
  await ctx.plugin(FakeGateway)
  await assert.rejects(async () => {
    await ctx.plugin(QuotaService, { pollIntervalMs: 100 } as unknown as ResolvedQuotaConfig)
  })
  await assert.rejects(async () => {
    await ctx.plugin(QuotaService, { debounceMs: 5 } as unknown as ResolvedQuotaConfig)
  })
})

test('enabled=false 时不推，但服务仍可读', async (t) => {
  const world = await boot(t, { enabled: false })
  await world.quota.pushNow()
  assert.equal(world.gateway.pushed.length, 0)
  assert.equal(world.quota.status().enabled, false)
  assert.equal(world.user.calls, 0)
})

// 心跳能救快照的前提是「推送间隔明显小于 Go 的 TTL」：这条护栏把配置耦合错误显性化。
test('Go 侧 TTL 护栏：读得到 ttlMs 就暴露，间隔跟不上时标 heartbeatTooSlow', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()
  await sleep(20)

  const status = world.quota.status()
  assert.equal(status.goTtlMs, 200_000, '应当读一次 Go 侧的 ttlMs')
  assert.equal(status.heartbeatTooSlow, false, '200s TTL 远大于推送间隔')

  // 纯函数口径：TTL < 2 × 间隔 = 跟不上（留一次抖动余量）。
  assert.equal(heartbeatTooSlow(15_000, 5_000), false)
  assert.equal(heartbeatTooSlow(9_000, 5_000), true)
  assert.equal(heartbeatTooSlow(4_000, 5_000), true)
  assert.equal(heartbeatTooSlow(0, 5_000), false, '读不到 TTL 时不算「太慢」')
})

test('Go 侧读不到 TTL 时不报错、不影响推送', async (t) => {
  const world = await boot(t, {}, (gateway) => {
    gateway.quotaStatus = async () => {
      throw new Error('桥断线')
    }
  })
  await world.quota.pushNow()
  await sleep(20)

  const status = world.quota.status()
  assert.equal(status.goTtlMs, null, '读不到就是 null，不编造')
  assert.equal(status.heartbeatTooSlow, false)
  assert.ok(status.pushes >= 2, '观测失败不该影响推送')
})
