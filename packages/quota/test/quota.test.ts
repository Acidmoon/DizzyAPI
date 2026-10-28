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
  type QuotaConfig,
  type QuotaSnapshotPayload,
  type ResolvedQuotaConfig,
} from '../src/index.ts'

interface Entry {
  userId: string
  balanceMicros: string
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
    return { ready: this.pushed.length > 0, size: 0, ageMs: 0, ttlMs: 0 }
  }
}

interface World {
  readonly ctx: Context
  readonly quota: QuotaService
  readonly user: FakeUser
  readonly gateway: FakeGateway
  readonly fiber: { dispose(): Promise<void> | void }
}

async function boot(t: TestContext, config: QuotaConfig = {}): Promise<World> {
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
  const fiber = await ctx.plugin(QuotaService, {
    enabled: true,
    pollIntervalMs: 250,
    debounceMs: 100,
    ...config,
  } as ResolvedQuotaConfig)
  const quota = ctx.get('quota') as QuotaService
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
  await world.quota.pushNow()

  assert.equal(world.gateway.pushed.length, 1)
  const payload = world.gateway.pushed[0] as QuotaSnapshotPayload
  assert.equal(payload.version, 1)
  assert.ok(payload.generation > 0, 'generation 必须是正数')
  assert.match(payload.revision, /^[0-9a-f]{32}$/)
  // 排序稳定：userId 按数值升序，而不是插入顺序。
  assert.deepEqual(payload.entries, [
    { userId: '1', balanceMicros: '5000000' },
    { userId: '2', balanceMicros: '-1500000' },
  ])

  const status = world.quota.status()
  assert.equal(status.lastRevision, payload.revision)
  assert.equal(status.pushes, 1)
  assert.equal(status.lastError, null)
  assert.ok(status.lastPushAt !== null)
})

test('内容没变不重复推；余额变了 revision 才变', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()
  await world.quota.pushNow()

  assert.equal(world.gateway.pushed.length, 1, '内容相同不该重复占桥')
  assert.ok(world.quota.status().skipped >= 1)

  world.user.entries = [
    { userId: '1', balanceMicros: '4000000' },
    { userId: '2', balanceMicros: '-1500000' },
  ]
  await world.quota.pushNow()
  assert.equal(world.gateway.pushed.length, 2)
  assert.notEqual(
    (world.gateway.pushed[1] as QuotaSnapshotPayload).revision,
    (world.gateway.pushed[0] as QuotaSnapshotPayload).revision,
  )
  // generation 单调递增。
  assert.ok(
    (world.gateway.pushed[1] as QuotaSnapshotPayload).generation >
      (world.gateway.pushed[0] as QuotaSnapshotPayload).generation,
  )
})

test('余额变更事件经 debounce 补推；非余额字段不触发', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()
  assert.equal(world.gateway.pushed.length, 1)

  // 改名之类与余额无关：不触发。
  emitUserChanged(world.ctx, { fields: ['name'] })
  await sleep(250)
  assert.equal(world.gateway.pushed.length, 1)

  world.user.entries = [{ userId: '1', balanceMicros: '3000000' }]
  emitUserChanged(world.ctx, { fields: ['balance'] })
  await sleep(300)
  assert.equal(world.gateway.pushed.length, 2, '余额变更后应补推一次')
  assert.deepEqual((world.gateway.pushed[1] as QuotaSnapshotPayload).entries, [
    { userId: '1', balanceMicros: '3000000' },
  ])
})

test('推送失败：记错误、保证重试，成功后清空', async (t) => {
  const world = await boot(t)
  await world.quota.pushNow()

  world.gateway.failures = 1
  world.user.entries = [{ userId: '1', balanceMicros: '100' }]
  await world.quota.pushNow()
  assert.notEqual(world.quota.status().lastError, null, '失败必须记下来')
  assert.ok(world.quota.status().failures >= 1)

  await world.quota.pushNow()
  assert.equal(world.quota.status().lastError, null, '成功后清空错误')
  assert.equal(world.gateway.pushed.length, 2)
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
