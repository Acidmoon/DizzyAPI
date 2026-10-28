/**
 * 账号健康检查插件的测试。
 *
 * 用假的门面（`accountAdmin`）验证判定规则与回收语义：
 * - 连续失败到阈值 → setHealth('unhealthy') + autoDisable；
 * - 未到阈值 → 只标 degraded，不误禁；
 * - 一次成功即清零失败计数；连续成功到阈值 → autoEnable；
 * - 卸载后定时器停（不再触发新一轮）。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service, ValidationError } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import AccountHealthService, {
  ACCOUNT_HEALTH_ACTOR,
  ACCOUNT_HEALTH_CONFIG_SCHEMA,
  isAccountHealthError,
  type AccountHealthConfig,
} from '../src/index.ts'

const ACTOR = ACCOUNT_HEALTH_ACTOR

interface FakeAccount {
  id: string
  enabled: boolean
  status: string
  health: 'unknown' | 'healthy' | 'degraded' | 'unhealthy'
}

interface Call {
  readonly method: string
  readonly args: readonly unknown[]
}

/** 门面替身：可控「这个账号下一轮能不能测通」，并记录每次写入。 */
class FakeAccountAdmin extends Service {
  readonly calls: Call[] = []
  /** id → 依次返回的测试结果（ok / error）；用完后重复最后一个。 */
  private readonly results = new Map<string, { ok: boolean; error: string | null }[]>()
  private readonly accounts = new Map<string, FakeAccount>()
  /** 每轮检查里同时在飞的最大数量（测并发上限用）。 */
  inFlight = 0
  maxInFlight = 0
  /** 延迟，便于观测并发。 */
  delayMs = 0

  constructor(ctx: Context) {
    super(ctx, 'accountAdmin')
  }

  add(account: FakeAccount, results: { ok: boolean; error: string | null }[] = [{ ok: true, error: null }]): void {
    this.accounts.set(account.id, account)
    this.results.set(account.id, results)
  }

  get(id: string): FakeAccount | undefined {
    return this.accounts.get(id)
  }

  list(_query?: unknown, _options?: { readonly view?: string }) {
    this.calls.push({ method: 'list', args: [_query, _options] })
    return [...this.accounts.values()]
  }

  async testConnection(id: string) {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
      const queue = this.results.get(id) ?? []
      const next = queue.length > 1 ? (queue.shift() as { ok: boolean; error: string | null }) : queue[0]
      return next ?? { ok: true, error: null }
    } finally {
      this.inFlight -= 1
    }
  }

  async setHealth(actor: string, id: string, health: string) {
    this.calls.push({ method: 'setHealth', args: [actor, id, health] })
    const account = this.accounts.get(id)
    if (account !== undefined) account.health = health as FakeAccount['health']
    return account
  }

  async autoDisable(actor: string, id: string, reason: string) {
    this.calls.push({ method: 'autoDisable', args: [actor, id, reason] })
    const account = this.accounts.get(id)
    if (account !== undefined && account.status === 'active') account.status = 'auto_disabled'
    return account
  }

  async autoEnable(actor: string, id: string) {
    this.calls.push({ method: 'autoEnable', args: [actor, id] })
    const account = this.accounts.get(id)
    if (account !== undefined && account.status === 'auto_disabled') account.status = 'active'
    return account
  }

  writes(method: string): Call[] {
    return this.calls.filter((call) => call.method === method)
  }
}

interface World {
  readonly ctx: Context
  readonly health: AccountHealthService
  readonly admin: FakeAccountAdmin
  readonly fiber: { dispose(): Promise<void> | void }
}

async function boot(t: TestContext, config: AccountHealthConfig = {}): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeAccountAdmin)
  const admin = ctx.get('accountAdmin') as unknown as FakeAccountAdmin
  const fiber = await ctx.plugin(AccountHealthService, {
    enabled: true,
    intervalMs: 60_000,
    failureThreshold: 3,
    recoverySuccesses: 1,
    maxConcurrent: 2,
    adminPlugins: [ACTOR],
    ...config,
  })
  const world: World = { ctx, health: ctx.get('accountHealth') as AccountHealthService, admin, fiber }
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能已经卸载过。
    }
  })
  return world
}

function active(id: string, health: FakeAccount['health'] = 'unknown'): FakeAccount {
  return { id, enabled: true, status: 'active', health }
}

test('连续失败到阈值：标 unhealthy 并自动停用；未到阈值只标 degraded', async (t) => {
  const world = await boot(t, { failureThreshold: 3 })
  world.admin.add(active('acc-bad'), [{ ok: false, error: 'HTTP 502' }])
  world.admin.add(active('acc-flaky'), [
    { ok: false, error: 'HTTP 502' },
    { ok: false, error: 'HTTP 502' },
    { ok: true, error: null },
  ])

  // 第 1 轮：两个都只失败一次 → 都只标 degraded，没人被停用。
  const first = await world.health.runPass()
  assert.equal(first.checked, 2)
  assert.equal(first.failed, 2)
  assert.deepEqual(first.autoDisabled, [])
  assert.equal(world.admin.get('acc-bad')?.health, 'degraded')
  assert.equal(world.admin.writes('autoDisable').length, 0)

  // 第 2 轮：两个都只失败两次，还没到阈值 → 仍然只标 degraded。
  const second = await world.health.runPass()
  assert.deepEqual(second.autoDisabled, [])
  assert.equal(world.admin.get('acc-bad')?.health, 'degraded')

  // 第 3 轮：acc-flaky 这次成功 → 健康回到 healthy；acc-bad 第三次失败 → 停用。
  const third = await world.health.runPass()
  assert.deepEqual(third.autoDisabled, ['acc-bad'])
  assert.equal(world.admin.get('acc-flaky')?.health, 'healthy')
  assert.equal(world.admin.get('acc-bad')?.health, 'unhealthy')
  assert.equal(world.admin.get('acc-bad')?.status, 'auto_disabled')

  const disable = world.admin.writes('autoDisable')[0]
  assert.equal(disable?.args[0], ACTOR, '写入必须带本插件的 actor')
  assert.equal(disable?.args[1], 'acc-bad')
  assert.ok(String(disable?.args[2]).includes('连续失败 3 次'))
})

test('失败计数在成功后清零：失败 → 失败 → 成功 → 失败，不应触发自动停用', async (t) => {
  const world = await boot(t, { failureThreshold: 3 })
  world.admin.add(active('acc-1'), [
    { ok: false, error: 'HTTP 502' },
    { ok: false, error: 'HTTP 502' },
    { ok: true, error: null },
    { ok: false, error: 'HTTP 502' },
  ])

  await world.health.runPass() // 失败 1
  await world.health.runPass() // 失败 2
  await world.health.runPass() // 成功 → 清零
  const last = await world.health.runPass() // 失败 1（重新计）
  assert.deepEqual(last.autoDisabled, [])
  assert.equal(world.admin.get('acc-1')?.status, 'active')
  assert.equal(world.admin.get('acc-1')?.health, 'degraded')
})

test('自动停用后成功到阈值即恢复；恢复前先写 healthy', async (t) => {
  const world = await boot(t, { recoverySuccesses: 2 })
  world.admin.add({ id: 'acc-back', enabled: true, status: 'auto_disabled', health: 'unhealthy' }, [
    { ok: true, error: null },
    { ok: true, error: null },
  ])

  const first = await world.health.runPass()
  assert.deepEqual(first.autoEnabled, [], '恢复成功次数不够，不该恢复')
  assert.equal(world.admin.get('acc-back')?.status, 'auto_disabled')
  assert.equal(world.admin.get('acc-back')?.health, 'healthy')

  const second = await world.health.runPass()
  assert.deepEqual(second.autoEnabled, ['acc-back'])
  assert.equal(world.admin.get('acc-back')?.status, 'active')
  assert.equal(world.admin.writes('autoEnable')[0]?.args[0], ACTOR)
})

test('跳过不该测的账号：enabled=false 与 needs_reauth；空列表也能跑', async (t) => {
  const world = await boot(t)
  world.admin.add({ id: 'acc-off', enabled: false, status: 'active', health: 'unknown' })
  world.admin.add({ id: 'acc-reauth', enabled: true, status: 'needs_reauth', health: 'unknown' })
  world.admin.add(active('acc-auto', 'unknown'))
  world.admin.calls.length = 0

  const pass = await world.health.runPass()
  assert.equal(pass.checked, 1)
  const tested = world.admin.calls.filter((call) => call.method === 'setHealth').map((call) => call.args[1])
  assert.deepEqual(tested, ['acc-auto'])

  const empty = await boot(t)
  const emptyPass = await empty.health.runPass()
  assert.deepEqual(emptyPass, { checked: 0, healthy: 0, failed: 0, autoDisabled: [], autoEnabled: [] })
})

test('单飞：上一轮没跑完时不会叠加第二轮', async (t) => {
  const world = await boot(t)
  world.admin.delayMs = 30
  world.admin.add(active('acc-1'))
  world.admin.add(active('acc-2'))
  world.admin.calls.length = 0

  const first = world.health.runPass()
  const second = world.health.runPass()
  assert.equal(first, second, '并发调用应拿到同一个 Promise')
  await first
  // 两个账号各测一次；第二轮没有真的再跑一遍。
  const listCalls = world.admin.calls.filter((call) => call.method === 'list').length
  assert.equal(listCalls, 1)
})

test('并发上限：同时在飞不超过 maxConcurrent', async (t) => {
  const world = await boot(t, { maxConcurrent: 2 })
  world.admin.delayMs = 10
  for (let index = 0; index < 6; index += 1) world.admin.add(active(`acc-${index}`))
  await world.health.runPass()
  assert.equal(world.admin.maxInFlight, 2)
})

test('手动触发：白名单 actor 可以，其它插件被拒，空 actor 明确失败', async (t) => {
  const world = await boot(t, { adminPlugins: [ACTOR] })
  world.admin.add(active('acc-1'))
  const pass = await world.health.runOnce(ACTOR)
  assert.equal(pass.checked, 1)

  await assert.rejects(
    world.health.runOnce('@dizzyapi/plugin-intruder'),
    (error: unknown) => isAccountHealthError(error) && error.code === 'ACCOUNT_HEALTH_ACTOR_FORBIDDEN',
  )
  await assert.rejects(
    world.health.runOnce('   '),
    (error: unknown) => isAccountHealthError(error) && error.code === 'ACCOUNT_HEALTH_ACTOR_REQUIRED',
  )
})

test('D5：卸载后定时器停，不再触发新一轮检查', async (t) => {
  const world = await boot(t, { intervalMs: 1_000 })
  world.admin.add(active('acc-1'))
  // 等第一轮（1s）跑完。
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  const before = world.admin.calls.filter((call) => call.method === 'list').length
  assert.ok(before >= 1, '定时器应当至少跑过一轮')

  await world.fiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 1_300))
  const after = world.admin.calls.filter((call) => call.method === 'list').length
  assert.equal(after, before, '卸载后不该再有新的检查轮次')
  assert.equal(world.ctx.get('accountHealth'), undefined)
})

test('enabled=false：不注册定时器，手动触发仍然可用', async (t) => {
  const world = await boot(t, { enabled: false, intervalMs: 1_000 })
  world.admin.add(active('acc-1'))
  assert.equal(world.health.status().enabled, false)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  assert.equal(
    world.admin.calls.filter((call) => call.method === 'list').length,
    0,
    'enabled=false 时不该有后台轮次',
  )
  const pass = await world.health.runOnce(ACTOR)
  assert.equal(pass.checked, 1)
})

test('status：暴露阈值与上一轮结果，不含账号数据', async (t) => {
  const world = await boot(t)
  world.admin.add(active('acc-1'))
  const before = world.health.status()
  assert.equal(before.lastPass, null)
  assert.equal(before.failureThreshold, 3)

  await world.health.runPass()
  const status = world.health.status()
  assert.equal(status.lastPass?.checked, 1)
  assert.ok(status.lastPassAt !== null)
  assert.ok(!JSON.stringify(status).includes('acc-1'), '状态里不该出现账号 id')
})

test('配置：非法值明确失败，未知键拒绝，默认值完整', async (t) => {
  const bad = [
    { failureThreshold: 0 },
    { recoverySuccesses: 0 },
    { intervalMs: 10 },
    { maxConcurrent: 0 },
    { enabled: 'yes' },
    { nope: true },
  ]
  for (const config of bad) {
    const result = ACCOUNT_HEALTH_CONFIG_SCHEMA['~standard'].validate(config)
    assert.ok('issues' in result, `配置 ${JSON.stringify(config)} 应被拒绝`)
  }

  const good = ACCOUNT_HEALTH_CONFIG_SCHEMA['~standard'].validate({ failureThreshold: 5 })
  assert.ok('value' in good)
  assert.equal(good.value.failureThreshold, 5)
  assert.equal(good.value.intervalMs, 60_000)
  assert.equal(good.value.recoverySuccesses, 1)
  assert.equal(good.value.enabled, true)

  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeAccountAdmin)
  await assert.rejects(async () => {
    await ctx.plugin(AccountHealthService, { nope: true } as never)
  }, ValidationError)
})

test('依赖未满足时停在 PENDING：没有 accountAdmin 或没有 timer 都不构造', async (t) => {
  const ctx = new Context()
  const fiber = ctx.plugin(AccountHealthService, { enabled: true })
  t.after(() => fiber.dispose())
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ctx.get('accountHealth'), undefined, '没有 accountAdmin 就不该构造')

  const ctx2 = new Context()
  await ctx2.plugin(FakeAccountAdmin)
  const fiber2 = ctx2.plugin(AccountHealthService, { enabled: true })
  t.after(() => fiber2.dispose())
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ctx2.get('accountHealth'), undefined, '没有 timer 就不该构造（ctx.setInterval 需要它）')
})
