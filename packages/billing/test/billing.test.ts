/**
 * 结算插件的测试。
 *
 * 覆盖：按 reqId 幂等（重复 / 并发只扣一次）、金额与 pricing.quote 一致（整数微元）、
 * 无价模型扣 0 留 no-price、零 token 不动余额、余额不足扣成负数不崩、可重试失败退回
 * pending 并抛出、配置性拒绝落 failed、崩溃残留（settling）按余额流水收敛且绝不重复扣、
 * 无用户落 no-user、管理面白名单、汇总口径、真重开账本后记录仍在、卸载后不可再用。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import PricingService from '@dizzyapi/plugin-pricing'
import BillingService, {
  BILLING_ACTOR,
  BillingError,
  validateBillingConfig,
  type BillingConfig,
  type SettleCandidate,
} from '../src/index.ts'

const API = '@dizzyapi/plugin-api'
const WEB = '@dizzyapi/plugin-web'

interface BalanceEntryLike {
  readonly reason: string
  readonly delta: bigint
  readonly balanceAfter: bigint
}

/** 只声明结算插件用到的 user 面：adjustBalance + listBalanceEntries。 */
class FakeUser extends Service {
  private readonly balances = new Map<number, bigint>()
  private readonly entries = new Map<number, BalanceEntryLike[]>()
  private failure: { code: string; message: string } | undefined
  private hold: { started: () => void; wait: Promise<void> } | undefined
  readonly calls: { consumer: string; id: number; delta: bigint; reason: string }[] = []

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  add(id: number, balance = 0n): void {
    this.balances.set(id, balance)
  }

  /** 直接塞一条余额流水（模拟「上一轮进程已经扣过款」）。 */
  seedEntry(id: number, balance: bigint, reason: string): void {
    this.balances.set(id, balance)
    const list = this.entries.get(id) ?? []
    list.push({ reason, delta: 0n, balanceAfter: balance })
    this.entries.set(id, list)
  }

  balanceOf(id: number): bigint {
    return this.balances.get(id) ?? 0n
  }

  /** 下一次 adjustBalance 抛一个带 code 的领域错误。 */
  failNext(code: string, message = 'fake 失败'): void {
    this.failure = { code, message }
  }

  /** 让下一次 adjustBalance 挂起，直到 release() 被调用（用于并发用例）。 */
  holdNext(): { started: Promise<void>; release: () => void } {
    let markStarted!: () => void
    let release!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    this.hold = { started: markStarted, wait }
    return { started, release }
  }

  async adjustBalance(consumer: string, id: number, delta: bigint, reason: string): Promise<bigint> {
    const hold = this.hold
    if (hold !== undefined) {
      this.hold = undefined
      hold.started()
      await hold.wait
    }
    const failure = this.failure
    if (failure !== undefined) {
      this.failure = undefined
      const error = new Error(failure.message) as Error & { code: string }
      error.code = failure.code
      throw error
    }
    const current = this.balances.get(id)
    if (current === undefined) {
      const error = new Error(`fake user ${id} 不存在`) as Error & { code: string }
      error.code = 'USER_NOT_FOUND'
      throw error
    }
    const next = current + delta
    this.balances.set(id, next)
    const list = this.entries.get(id) ?? []
    list.push({ reason, delta, balanceAfter: next })
    this.entries.set(id, list)
    this.calls.push({ consumer, id, delta, reason })
    return next
  }

  async listBalanceEntries(id: number, limit = 20): Promise<readonly BalanceEntryLike[]> {
    const list = this.entries.get(id) ?? []
    return list.slice(Math.max(0, list.length - limit))
  }
}

/** 价格表假实现：`table` 里是「每百万 token 的整数微元」。 */
class FakePricing extends Service {
  private readonly table = new Map<string, { input: bigint; output: bigint; cacheRead: bigint; cacheWrite: bigint }>()

  constructor(ctx: Context) {
    super(ctx, 'pricing')
  }

  set(model: string, input: bigint, output = 0n, cacheRead = 0n, cacheWrite = 0n): void {
    this.table.set(model, { input, output, cacheRead, cacheWrite })
  }

  get(model: string): { readonly model: string } | null {
    return this.table.has(model) ? { model } : null
  }

  quote(model: string, tokens: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
    readonly cacheWriteTokens: number
  }): string {
    const unit = this.table.get(model) ?? this.table.get('*')
    if (unit === undefined) return '0'
    const numerator =
      BigInt(tokens.inputTokens) * unit.input +
      BigInt(tokens.outputTokens) * unit.output +
      BigInt(tokens.cacheReadTokens) * unit.cacheRead +
      BigInt(tokens.cacheWriteTokens) * unit.cacheWrite
    return ((numerator + 500_000n) / 1_000_000n).toString()
  }
}

interface World {
  readonly ctx: Context
  readonly service: BillingService
  readonly user: FakeUser
  readonly pricing: FakePricing
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, options: BillingConfig & { readonly withPricing?: boolean } = {}): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  await ctx.plugin(FakePricing)
  const user = ctx.get('user') as unknown as FakeUser
  const pricing = ctx.get('pricing') as unknown as FakePricing
  const fiber = await ctx.plugin(BillingService, {
    adminPlugins: [API],
    dataPath: ':memory:',
    ...options,
  })
  const service = ctx.get('billing') as BillingService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // dispose 在 cordis 4 里返回 void；测试清理忽略异常。
    }
  })
  return {
    ctx,
    service,
    user,
    pricing,
    dispose: async () => {
      await fiber.dispose()
    },
  }
}

let sequence = 0

function candidate(overrides: Partial<SettleCandidate> = {}): SettleCandidate {
  sequence += 1
  return {
    requestId: `req-${sequence}`,
    userId: '1',
    accountId: 'account-1',
    model: 'model-a',
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    startedAt: '2026-10-19T12:00:00.000Z',
    ...overrides,
  }
}

// ───────────────────────────────── 幂等 ─────────────────────────────────

test('同一 reqId 重复结算只扣一次', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 10n * 1_000_000n)
  // 3.75 元 / 百万 token：100 万 input = 3.75 元 = 3_750_000 微元。
  pricing.set('model-a', 3_750_000n)
  const record = candidate()

  await service.settle([record])
  assert.equal(user.balanceOf(1), 6_250_000n)
  assert.equal(user.calls.length, 1)

  const repeat = await service.settle([record])
  assert.equal(user.balanceOf(1), 6_250_000n, '重复结算不得再扣')
  assert.equal(user.calls.length, 1)
  assert.equal(repeat.settled, 0)
  assert.equal(repeat.skipped, 1)
})

test('并发同 reqId 只扣一次', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 10n * 1_000_000n)
  pricing.set('model-a', 1_000_000n)
  const record = candidate({ inputTokens: 1_000_000 })

  const hold = user.holdNext()
  const first = service.settle([record])
  await hold.started
  const second = service.settle([record])
  hold.release()

  const [a, b] = await Promise.all([first, second])
  assert.equal(user.calls.length, 1, '只有一笔扣款')
  assert.equal(user.balanceOf(1), 9_000_000n)
  assert.equal(a.settled, 1)
  assert.equal(b.settled, 0)
  assert.equal(b.skipped, 1)
})

test('金额与 pricing.quote 一致：整数微元，无浮点', async (t) => {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  await ctx.plugin(PricingService, { dataPath: '', adminPlugins: [API] })
  const realPricing = ctx.get('pricing') as unknown as {
    set(actor: string, model: string, input: Record<string, string>): Promise<unknown>
    quote(model: string, tokens: Record<string, number>): string
  }
  await realPricing.set(API, 'priced-model', {
    inputPerMillion: '3.75',
    outputPerMillion: '7.5',
    cacheReadPerMillion: '1',
  })
  const fiber = await ctx.plugin(BillingService, { adminPlugins: [API], dataPath: ':memory:' })
  t.after(async () => {
    await fiber.dispose()
  })
  const user = ctx.get('user') as unknown as FakeUser
  const billing = ctx.get('billing') as BillingService
  user.add(1, 100n * 1_000_000n)

  const tokens = { inputTokens: 1_333, outputTokens: 77, cacheReadTokens: 11, cacheWriteTokens: 0 }
  const expected = BigInt(
    realPricing.quote('priced-model', {
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheWriteTokens: tokens.cacheWriteTokens,
    }),
  )
  // 1333×3.75 + 77×7.5 + 11×1 = 5587.25 微元 → 四舍五入 5587（整数微元，不分项取整）。
  assert.equal(expected, 5_587n)
  await billing.settle([candidate({ model: 'priced-model', ...tokens })])
  assert.equal(user.calls.length, 1)
  assert.equal(user.calls[0]?.delta, -expected)
  assert.equal(user.calls[0]?.delta, -5_587n, '扣的是整数微元，不做浮点四舍五入两次')
  assert.equal(user.calls[0]?.consumer, BILLING_ACTOR)
})

// ───────────────────────────── 价格 / 用户缺失 ─────────────────────────────

test('模型没配价：no-price、扣 0、不调 adjustBalance', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 1_000_000n)
  pricing.set('other', 1_000_000n)
  const result = await service.settle([candidate({ model: 'no-price-model' })])

  assert.equal(result.noPrice, 1)
  assert.equal(result.settled, 0)
  assert.equal(user.calls.length, 0)
  const page = service.list(API)
  assert.equal(page.items[0]?.status, 'no-price')
  assert.equal(page.items[0]?.costMicro, 0n)
  assert.match(page.items[0]?.note ?? '', /没有配置价格/)

  // 再拉一次仍是终态，不重复告警也不扣。
  const again = await service.settle([candidate({ requestId: page.items[0]?.reqId ?? '' })])
  assert.equal(again.skipped, 1)
  assert.equal(user.calls.length, 0)
})

test("'*' 兜底价生效", async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 1_000_000n)
  pricing.set('*', 1_000_000n)
  const result = await service.settle([candidate({ model: 'unknown-model', inputTokens: 1_000_000 })])
  assert.equal(result.settled, 1)
  assert.equal(user.balanceOf(1), 0n)
})

test('模型名被价格表拒绝（控制字符 / 超长）：判 no-price，不让整批抛错', async () => {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  await ctx.plugin(PricingService, { dataPath: '', adminPlugins: [API] })
  const fiber = await ctx.plugin(BillingService, { adminPlugins: [API], dataPath: ':memory:' })
  // 即使配了 '*' 兜底，非法模型名也不该让价格服务抛错冒到结算层。
  const pricing = ctx.get('pricing') as unknown as {
    set(actor: string, model: string, input: Record<string, string>): Promise<unknown>
  }
  await pricing.set(API, '*', { inputPerMillion: '1', outputPerMillion: '1' })
  const user = ctx.get('user') as unknown as FakeUser
  user.add(1, 1_000_000n)
  const billing = ctx.get('billing') as BillingService
  try {
    const result = await billing.settle([
      candidate({ model: `bad\u0001model` }),
      candidate({ model: 'x'.repeat(300) }),
    ])
    assert.equal(result.noPrice, 2)
    assert.equal(user.calls.length, 0)
  } finally {
    await fiber.dispose()
  }
})

test('用户 id 缺失（空串）：落 no-user，不让整批抛错', async (t) => {
  const { service, user, pricing } = await boot(t)
  pricing.set('model-a', 1_000_000n)
  const result = await service.settle([candidate({ userId: '' })])
  assert.equal(result.noUser, 1)
  assert.equal(user.calls.length, 0)
})

test('零 token：settled 但未动余额（不写余额流水）', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 5_000_000n)
  pricing.set('model-a', 3_750_000n)
  const result = await service.settle([
    candidate({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ])
  assert.equal(result.settled, 1)
  assert.equal(user.calls.length, 0)
  assert.equal(user.balanceOf(1), 5_000_000n)
})

test('没有用户 id：no-user，不扣费', async (t) => {
  const { service, user, pricing } = await boot(t)
  pricing.set('model-a', 1_000_000n)
  const result = await service.settle([candidate({ userId: '0' })])
  assert.equal(result.noUser, 1)
  assert.equal(user.calls.length, 0)
  assert.equal(service.list(API).items[0]?.status, 'no-user')
})

test('余额不足：照实扣成负数（后付费），并留下 overdrawn / balanceAfter 供管理面查', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 0n)
  pricing.set('model-a', 3_750_000n)
  const result = await service.settle([candidate()])
  assert.equal(result.settled, 1)
  assert.equal(result.chargedMicros, 3_750_000n)
  assert.equal(user.balanceOf(1), -3_750_000n)

  const row = service.list(API).items[0]
  assert.equal(row?.status, 'settled', '状态仍是稳定的 settled')
  assert.equal(row?.overdrawn, true, '透支是稳定的布尔事实')
  assert.equal(row?.balanceAfter, -3_750_000n)
  assert.match(row?.note ?? '', /余额不足/)
  assert.equal(service.summary(API).totals.overdrawn, 1)
})

test('余额够时 overdrawn=false，仍记下扣后余额', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 10_000_000n)
  pricing.set('model-a', 3_750_000n)
  await service.settle([candidate()])
  const row = service.list(API).items[0]
  assert.equal(row?.overdrawn, false)
  assert.equal(row?.balanceAfter, 6_250_000n)
  assert.equal(service.summary(API).totals.overdrawn, 0)
})

test('用户已不存在：落 no-user，不重试', async (t) => {
  const { service, user, pricing } = await boot(t)
  pricing.set('model-a', 1_000_000n)
  const result = await service.settle([candidate({ userId: '42' })])
  assert.equal(result.noUser, 1)
  assert.equal(user.calls.length, 0)
  assert.equal(service.list(API).items[0]?.status, 'no-user')
})

// ───────────────────────────── 失败与残留 ─────────────────────────────

test('配置性拒绝（不在 balanceWriters）：落 failed，不阻塞后续记录', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 10_000_000n)
  pricing.set('model-a', 1_000_000n)
  user.failNext('USER_ACTOR_FORBIDDEN', 'fake 白名单拒绝')

  const result = await service.settle([candidate(), candidate()])
  assert.equal(result.failed, 1)
  assert.equal(result.settled, 1, '一笔被拒不影响下一笔')
  assert.equal(service.list(API, { status: 'problem' }).total, 1)
})

test('可重试失败：退回 pending 并抛出（usage 据此不推进游标）', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 10_000_000n)
  pricing.set('model-a', 1_000_000n)
  user.failNext('SOME_TRANSIENT', '网络抖了一下')
  const record = candidate()

  await assert.rejects(service.settle([record]), (error: unknown) => {
    return error instanceof BillingError && error.code === 'BILLING_SETTLE_FAILED'
  })
  const page = service.list(API)
  assert.equal(page.items[0]?.status, 'pending', '失败要退回 pending 等重放')
  assert.equal(page.items[0]?.costMicro, 0n)
  assert.equal(user.calls.length, 0, '失败那一笔没扣钱')

  // 下一轮重放：这次成功，只扣一次。
  const retry = await service.settle([record])
  assert.equal(retry.settled, 1)
  assert.equal(user.calls.length, 1)
  assert.equal(service.list(API).items[0]?.status, 'settled')
})

test('崩溃残留 settling：余额流水里已有扣款 → 收尾为 settled，不重复扣', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dizzyapi-billing-'))
  const dataPath = join(root, 'billing.db')
  const { service, user, pricing, dispose } = await boot(t, { dataPath })
  user.add(1, 10n * 1_000_000n)
  pricing.set('model-a', 1_000_000n)
  const record = candidate()
  await service.settle([record])
  assert.equal(user.calls.length, 1)
  const charged = user.calls[0]?.delta

  // 模拟进程在「已扣款、未标记 settled」之间被杀：手工把行改回 settling。
  const raw = new DatabaseSync(dataPath)
  raw.exec("UPDATE settle SET status = 'settling', settled_at = NULL WHERE req_id = " + quote(record.requestId))
  raw.close()
  await dispose()

  const again = await boot(t, { dataPath })
  // 上一轮进程已经扣过款：余额流水里应该有这笔（reason 以「结算 <reqId>」开头）。
  again.user.seedEntry(1, 10n * 1_000_000n + (charged ?? 0n), `结算 ${record.requestId}`)
  const result = await again.service.settle([record])
  assert.equal(result.settled, 1)
  assert.equal(again.user.calls.length, 0, '绝不重复扣款')
  const row = again.service.list(API).items[0]
  assert.equal(row?.status, 'settled')
  assert.match(row?.note ?? '', /残留结算收尾/)

  // 清理放在两次 boot 之后注册：after 钩子按注册顺序执行，先关库再删目录。
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
})

test('崩溃残留 settling：流水里查不到扣款 → review，不重复扣', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dizzyapi-billing-'))
  const dataPath = join(root, 'billing.db')
  const { service, user, pricing, dispose } = await boot(t, { dataPath })
  user.add(1, 10n * 1_000_000n)
  pricing.set('model-a', 1_000_000n)
  const record = candidate()
  await service.settle([record])
  // 把它改回 settling，并让新进程的余额流水里没有这笔（模拟「扣款其实没发生」）。
  const raw = new DatabaseSync(dataPath)
  raw.exec("UPDATE settle SET status = 'settling', settled_at = NULL WHERE req_id = " + quote(record.requestId))
  raw.close()
  await dispose()

  const again = await boot(t, { dataPath })
  again.user.add(1, 10_000_000n)
  const result = await again.service.settle([record])
  assert.equal(result.review, 1)
  assert.equal(again.user.calls.length, 0, '无法确认时绝不扣款')
  const row = again.service.list(API).items[0]
  assert.equal(row?.status, 'review')
  assert.match(row?.note ?? '', /人工核查/)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
})

// ───────────────────────────── 管理面 ─────────────────────────────

test('管理面白名单：不在名单的插件读不到', async (t) => {
  const { service } = await boot(t)
  assert.throws(
    () => service.list(WEB),
    (error: unknown) => error instanceof BillingError && error.code === 'BILLING_ACTOR_FORBIDDEN',
  )
  assert.throws(() => service.summary(WEB), BillingError)
  assert.equal(service.list(API).total, 0)
})

test('汇总：按状态计数、按天与今日扣费', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 100n * 1_000_000n)
  pricing.set('model-a', 1_000_000n)
  pricing.set('model-b', 2_000_000n)

  await service.settle([
    candidate({ startedAt: '2026-10-18T01:00:00.000Z' }),
    candidate({ startedAt: '2026-10-19T01:00:00.000Z', model: 'model-b' }),
    candidate({ startedAt: '2026-10-19T02:00:00.000Z', model: 'no-price-model' }),
  ])
  const summary = service.summary(API, Date.parse('2026-10-19T12:00:00.000Z'))
  assert.equal(summary.totals.records, 3)
  assert.equal(summary.totals.settled, 2)
  assert.equal(summary.totals.noPrice, 1)
  assert.equal(summary.totals.chargedMicros, 3_000_000n)
  assert.equal(summary.totals.todayChargedMicros, 2_000_000n)
  assert.equal(summary.totals.overdrawn, 0)
  assert.deepEqual(
    summary.daily.map((point) => [point.date, point.records, point.chargedMicros]),
    [
      ['2026-10-18', 1, 1_000_000n],
      ['2026-10-19', 2, 2_000_000n],
    ],
  )
  assert.equal(summary.models[0]?.model, 'model-b')
  assert.equal(summary.models[0]?.chargedMicros, 2_000_000n)
})

test('分页与 problem 过滤', async (t) => {
  const { service, user, pricing } = await boot(t)
  user.add(1, 100n * 1_000_000n)
  pricing.set('model-a', 1_000_000n)
  user.failNext('USER_ACTOR_FORBIDDEN')
  await service.settle([candidate(), candidate(), candidate()])

  const all = service.list(API, { limit: 2 })
  assert.equal(all.total, 3)
  assert.equal(all.items.length, 2)
  const second = service.list(API, { limit: 2, offset: 2 })
  assert.equal(second.items.length, 1)

  const problems = service.list(API, { status: 'problem' })
  assert.equal(problems.total, 1)
  assert.equal(problems.items[0]?.status, 'failed')

  assert.throws(
    () => service.list(API, { status: 'bogus' as never }),
    (error: unknown) => error instanceof BillingError && error.code === 'BILLING_INPUT_INVALID',
  )
})

// ───────────────────────────── 配置与生命周期 ─────────────────────────────

test('配置校验：未知字段 / 类型不对都明确失败', async () => {
  const issues = validateBillingConfig({ nope: 1 })
  assert.ok(Array.isArray(issues) && issues.length > 0)
  assert.ok(!Array.isArray(validateBillingConfig({ dataPath: './data/billing.db', adminPlugins: [API] })))

  const ctx = new Context()
  await ctx.plugin(FakeUser)
  await ctx.plugin(FakePricing)
  let failure: unknown
  try {
    await ctx.plugin(BillingService, { dataPath: 42 } as unknown as BillingConfig)
  } catch (error) {
    failure = error
  }
  // 配置非法在 schema 层就被拒（cordis 不会构造插件）；错误信息必须点名字段。
  assert.ok(failure instanceof Error, '非法配置必须让插件装载失败')
  assert.match(failure.message, /dataPath/)
})

test('真重开账本：记录仍在（不是只活在内层）', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dizzyapi-billing-'))
  const dataPath = join(root, 'billing.db')
  const first = await boot(t, { dataPath })
  first.user.add(1, 10_000_000n)
  first.pricing.set('model-a', 1_000_000n)
  await first.service.settle([candidate()])
  await first.dispose()

  const second = await boot(t, { dataPath })
  const page = second.service.list(API)
  assert.equal(page.total, 1)
  assert.equal(page.items[0]?.status, 'settled')
  assert.equal(page.items[0]?.costMicro, 1_000_000n)

  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
})

test('卸载后不可再用（禁用即回收）', async (t) => {
  const { service, dispose } = await boot(t)
  await dispose()
  await assert.rejects(
    service.settle([candidate()]),
    (error: unknown) => error instanceof BillingError && error.code === 'BILLING_NOT_READY',
  )
  assert.throws(() => service.summary(API), (error: unknown) => {
    return error instanceof BillingError && error.code === 'BILLING_NOT_READY'
  })
})

test('入参非法：明确失败而不是静默跳过', async (t) => {
  const { service } = await boot(t)
  await assert.rejects(service.settle([{ ...candidate(), requestId: '' }]), (error: unknown) => {
    return error instanceof BillingError && error.code === 'BILLING_INPUT_INVALID'
  })
  await assert.rejects(service.settle([{ ...candidate(), startedAt: 'not-a-date' }]), BillingError)
})

/** SQL 字符串字面量；reqId 只由测试构造，无注入面。 */
function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
