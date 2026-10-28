/**
 * 充值订单插件的测试。
 *
 * 覆盖：创建（金额换算整数微元 / 范围 / 非法输入）、订单号唯一与并发创建、
 * 人工确认到账（幂等：重复与并发只加一次钱）、取消（自己 / 管理员）、过期不能再确认、
 * provider seam（manual 说明文案 / 未知 provider 明确失败）、管理面白名单、统计与筛选、
 * 禁用回收（库关闭、定时器停）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import TopupService, {
  PAYMENT_PROVIDERS,
  TOPUP_ACTOR,
  TopupError,
  formatMicrosAsYuan,
  providerIds,
  validateTopupConfig,
  type TopupConfig,
  type TopupOptions,
} from '../src/index.ts'

const API = '@dizzyapi/plugin-api'
const WEB = '@dizzyapi/plugin-web'

/** 配置校验有两个返回值：合法时是解析结果，非法时是错误列表。 */
function issuesOf(value: unknown): readonly unknown[] {
  const result = validateTopupConfig(value)
  if (!Array.isArray(result)) throw new Error('这份配置本该被判为非法')
  return result
}

interface BalanceCall {
  readonly consumer: string
  readonly id: number
  readonly delta: bigint
  readonly reason: string
}

/** 只声明充值插件用到的 user 面：adjustBalance。 */
class FakeUser extends Service {
  private readonly balances = new Map<number, bigint>()
  readonly calls: BalanceCall[] = []
  private failure: string | undefined

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  add(id: number, balance = 0n): void {
    this.balances.set(id, balance)
  }

  balanceOf(id: number): bigint {
    return this.balances.get(id) ?? 0n
  }

  failNext(message: string): void {
    this.failure = message
  }

  async adjustBalance(consumer: string, id: number, delta: bigint, reason: string): Promise<bigint> {
    const failure = this.failure
    if (failure !== undefined) {
      this.failure = undefined
      throw new Error(failure)
    }
    const current = this.balances.get(id) ?? 0n
    const next = current + delta
    this.balances.set(id, next)
    this.calls.push({ consumer, id, delta, reason })
    return next
  }
}

interface World {
  readonly ctx: Context
  readonly service: TopupService
  readonly user: FakeUser
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, config: TopupConfig = {}): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  const user = ctx.get('user') as unknown as FakeUser
  const fiber = await ctx.plugin(TopupService, {
    dataPath: ':memory:',
    adminPlugins: [API],
    provider: 'manual',
    expiresMinutes: 30,
    minAmountYuan: 1,
    maxAmountYuan: 1000,
    ...config,
  })
  const service = ctx.get('topup') as TopupService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // dispose 返回 void；测试清理忽略异常。
    }
  })
  return {
    ctx,
    service,
    user,
    dispose: async () => {
      await fiber.dispose()
    },
  }
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined
}

// ───────────────────────────────── 创建 ─────────────────────────────────

test('创建订单：金额换算成整数微元，manual 说明文案进响应', async (t) => {
  const { service, user } = await boot(t)
  user.add(1, 0n)
  const created = await service.createOrder({ userId: 1, amountYuan: '99.5' })
  const order = created.order

  assert.equal(order.amountMicro, 99_500_000n, '99.5 元 = 99_500_000 微元')
  assert.equal(order.status, 'pending')
  assert.equal(order.provider, 'manual')
  assert.equal(order.providerLabel, '人工确认（线下转账）')
  assert.equal(order.userId, 1)
  assert.match(order.instructions ?? '', /线下/)
  assert.match(order.instructions ?? '', new RegExp(order.orderNo), '说明里要有单号')
  assert.ok(Date.parse(order.expiresAt) > Date.parse(order.createdAt))
  assert.equal(service.listMine(1).total, 1)
})

test('非法金额与范围外金额明确失败', async (t) => {
  const { service } = await boot(t)
  for (const bad of ['', 'abc', '-1', '1e3', '0', '0.0000001', '1.1234567']) {
    await assert.rejects(
      service.createOrder({ userId: 1, amountYuan: bad }),
      (error: unknown) => codeOf(error) === 'TOPUP_AMOUNT_INVALID',
      `金额 ${JSON.stringify(bad)} 应被拒绝`,
    )
  }
  for (const out of ['0.5', '1000.01']) {
    await assert.rejects(
      service.createOrder({ userId: 1, amountYuan: out }),
      (error: unknown) => codeOf(error) === 'TOPUP_AMOUNT_OUT_OF_RANGE',
      `金额 ${out} 应在范围外被拒绝`,
    )
  }
  // 边界值必须接受（含等于）。
  assert.equal((await service.createOrder({ userId: 1, amountYuan: '1' })).order.amountMicro, 1_000_000n)
  assert.equal(
    (await service.createOrder({ userId: 1, amountYuan: '1000' })).order.amountMicro,
    1_000_000_000n,
  )
  assert.equal(service.listMine(1).total, 2)
})

test('订单号唯一：并发创建 20 笔不撞号', async (t) => {
  const { service } = await boot(t)
  const created = await Promise.all(
    Array.from({ length: 20 }, () => service.createOrder({ userId: 1, amountYuan: '10' })),
  )
  const numbers = new Set(created.map((item) => item.order.orderNo))
  assert.equal(numbers.size, 20)
  assert.equal(service.listMine(1).total, 20)
})

test('未知支付通道：配置阶段明确失败（不回落 manual）', async () => {
  assert.ok(issuesOf({ provider: 'alipay' }).length > 0)
  assert.ok(!Array.isArray(validateTopupConfig({ provider: 'manual' })))
  assert.deepEqual(providerIds(), ['manual'])
  assert.equal(PAYMENT_PROVIDERS.length, 1)

  const ctx = new Context()
  await ctx.plugin(FakeUser)
  let failure: unknown
  try {
    await ctx.plugin(TopupService, { provider: 'alipay' })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error, '未知 provider 必须让插件装载失败')
  assert.match(failure.message, /provider/)
  assert.equal(ctx.get('topup', false), undefined)
})

test('下单时指定未启用的通道：明确失败', async (t) => {
  const { service } = await boot(t)
  await assert.rejects(service.createOrder({ userId: 1, amountYuan: '10', provider: 'alipay' }), (error: unknown) => {
    return codeOf(error) === 'TOPUP_PROVIDER_UNKNOWN'
  })
})

// ───────────────────────────────── 到账 ─────────────────────────────────

test('人工确认到账：余额与流水正确（整数微元，走 user.adjustBalance）', async (t) => {
  const { service, user } = await boot(t)
  user.add(7, 1_000_000n)
  const created = await service.createOrder({ userId: 7, amountYuan: '88.88' })
  const result = await service.confirmPaid(API, created.order.orderNo)

  assert.equal(result.credited, true)
  assert.equal(result.order.status, 'paid')
  assert.ok(result.order.paidAt !== null)
  assert.equal(user.balanceOf(7), 1_000_000n + 88_880_000n)
  assert.equal(user.calls.length, 1)
  assert.equal(user.calls[0]?.consumer, TOPUP_ACTOR)
  assert.equal(user.calls[0]?.id, 7)
  assert.equal(user.calls[0]?.delta, 88_880_000n)
  assert.match(user.calls[0]?.reason ?? '', /充值到账/)
})

test('重复确认与并发确认：只加一次钱', async (t) => {
  const { service, user } = await boot(t)
  user.add(3, 0n)
  const created = await service.createOrder({ userId: 3, amountYuan: '10' })
  const orderNo = created.order.orderNo

  const first = await service.confirmPaid(API, orderNo)
  assert.equal(first.credited, true)
  const again = await service.confirmPaid(API, orderNo)
  assert.equal(again.credited, false, '重复确认不再加钱')
  assert.equal(user.calls.length, 1)
  assert.equal(user.balanceOf(3), 10_000_000n)

  // 并发：另起一笔，两个确认同时进。
  const other = await service.createOrder({ userId: 3, amountYuan: '5' })
  const [a, b] = await Promise.all([
    service.confirmPaid(API, other.order.orderNo),
    service.confirmPaid(API, other.order.orderNo),
  ])
  assert.equal([a.credited, b.credited].filter(Boolean).length, 1, '并发确认只有一个成功')
  assert.equal(user.balanceOf(3), 15_000_000n, '只加了一次 5 元')
  assert.equal(user.calls.length, 2)
})

test('加余额失败：订单退回 pending，可以再次确认', async (t) => {
  const { service, user } = await boot(t)
  user.add(4, 0n)
  const created = await service.createOrder({ userId: 4, amountYuan: '20' })
  user.failNext('fake 余额写入失败')

  await assert.rejects(service.confirmPaid(API, created.order.orderNo), (error: unknown) => {
    return codeOf(error) === 'TOPUP_BALANCE_FAILED'
  })
  assert.equal(service.list(API, { userId: 4 }).items[0]?.status, 'pending', '钱没到账要退回待确认')
  assert.equal(user.calls.length, 0)

  const retry = await service.confirmPaid(API, created.order.orderNo)
  assert.equal(retry.credited, true)
  assert.equal(user.balanceOf(4), 20_000_000n)
})

test('取消后不能再到账；已到账不能取消', async (t) => {
  const { service, user } = await boot(t)
  user.add(5, 0n)
  const created = await service.createOrder({ userId: 5, amountYuan: '10' })
  const canceled = await service.cancelMine(5, created.order.orderNo)
  assert.equal(canceled.status, 'canceled')

  await assert.rejects(service.confirmPaid(API, created.order.orderNo), (error: unknown) => {
    return codeOf(error) === 'TOPUP_ORDER_STATE'
  })
  assert.equal(user.calls.length, 0)

  const paidOrder = await service.createOrder({ userId: 5, amountYuan: '10' })
  await service.confirmPaid(API, paidOrder.order.orderNo)
  assert.throws(() => service.cancel(API, paidOrder.order.orderNo), (error: unknown) => {
    return codeOf(error) === 'TOPUP_ORDER_STATE'
  })
})

test('过期订单不能再确认到账', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzy-topup-'))
  const dataPath = join(dir, 'topup.db')
  const world = await boot(t, { dataPath })
  try {
    world.user.add(6, 0n)
    const created = await world.service.createOrder({ userId: 6, amountYuan: '10' })

    // 把到期时间改到过去（模拟「已经过期但定时器还没扫到」）。
    const db = new DatabaseSync(dataPath)
    db.prepare('UPDATE orders SET expires_at = ? WHERE order_no = ?').run(
      '2026-10-01T00:00:00.000Z',
      created.order.orderNo,
    )
    db.close()

    await assert.rejects(world.service.confirmPaid(API, created.order.orderNo), (error: unknown) => {
      return codeOf(error) === 'TOPUP_ORDER_STATE'
    })
    assert.equal(world.user.calls.length, 0)
    // 确认失败还会顺手把状态刷成 expired。
    assert.equal(world.service.list(API).items[0]?.status, 'expired')
  } finally {
    try {
      await world.dispose()
    } catch {
      // 清理忽略
    }
    await rm(dir, { recursive: true, force: true })
  }
})

test('只能取消自己的订单', async (t) => {
  const { service } = await boot(t)
  const mine = await service.createOrder({ userId: 1, amountYuan: '10' })
  assert.throws(() => service.cancelMine(2, mine.order.orderNo), (error: unknown) => {
    return codeOf(error) === 'TOPUP_ORDER_NOT_FOUND'
  })
  // 别人的订单也不能看到。
  assert.throws(() => service.getMine(2, mine.order.orderNo), (error: unknown) => {
    return codeOf(error) === 'TOPUP_ORDER_NOT_FOUND'
  })
  assert.equal(service.cancelMine(1, mine.order.orderNo).status, 'canceled')
  // 已取消再取消是幂等成功。
  assert.equal(service.cancelMine(1, mine.order.orderNo).status, 'canceled')
})

// ───────────────────────────────── 管理面 ─────────────────────────────────

test('管理面白名单：不在名单的插件读不到、也确认不了', async (t) => {
  const { service } = await boot(t)
  assert.throws(() => service.list(WEB), (error: unknown) => codeOf(error) === 'TOPUP_ACTOR_FORBIDDEN')
  await assert.rejects(service.confirmPaid(WEB, 'T20261019110000ABCD1234'), (error: unknown) => {
    return codeOf(error) === 'TOPUP_ACTOR_FORBIDDEN'
  })
  assert.equal(service.list(API).total, 0)
})

test('管理面：筛选、分页与统计', async (t) => {
  const { service, user } = await boot(t)
  user.add(1, 0n)
  user.add(2, 0n)
  const paid = await service.createOrder({ userId: 1, amountYuan: '10' })
  await service.confirmPaid(API, paid.order.orderNo)
  const pending = await service.createOrder({ userId: 2, amountYuan: '20' })
  const canceled = await service.createOrder({ userId: 1, amountYuan: '30' })
  await service.cancel(API, canceled.order.orderNo)

  const all = service.list(API, { limit: 2 })
  assert.equal(all.total, 3)
  assert.equal(all.items.length, 2)
  const page2 = service.list(API, { limit: 2, offset: 2 })
  assert.equal(page2.items.length, 1)

  assert.equal(service.list(API, { status: 'pending' }).total, 1)
  assert.equal(service.list(API, { status: 'paid' }).items[0]?.orderNo, paid.order.orderNo)
  assert.equal(service.list(API, { userId: 1 }).total, 2)

  const stats = service.stats(API, Date.parse('2026-10-19T12:00:00.000Z'))
  assert.equal(stats.totalPaidCount, 1)
  assert.equal(stats.totalPaidMicros, 10_000_000n)
  assert.equal(stats.pendingCount, 1)
  assert.equal(stats.expiredCount, 0)
  assert.equal(pending.order.status, 'pending')
})

test('充值选项来自插件配置', async (t) => {
  const { service } = await boot(t, { minAmountYuan: 5, maxAmountYuan: 500, expiresMinutes: 45 })
  const options: TopupOptions = service.options()
  assert.equal(options.currency, 'CNY')
  assert.equal(options.providerId, 'manual')
  assert.equal(options.online, false)
  assert.equal(options.minAmountMicros, 5_000_000n)
  assert.equal(options.maxAmountMicros, 500_000_000n)
  assert.equal(options.expiresMinutes, 45)
  assert.match(options.notice, /人工确认/)
})

// ───────────────────────────────── 生命周期 ─────────────────────────────────

test('禁用即回收：库关闭、定时器停、服务不可再用', async (t) => {
  const { service, dispose } = await boot(t)
  await service.createOrder({ userId: 1, amountYuan: '10' })
  await dispose()
  await assert.rejects(service.createOrder({ userId: 1, amountYuan: '10' }), (error: unknown) => {
    return codeOf(error) === 'TOPUP_NOT_READY'
  })
  assert.equal(service.expireDue(), 0, '卸载后没有库可写')
})

test('金额格式化：整数微元 → 元（只用于展示）', () => {
  assert.equal(formatMicrosAsYuan(99_500_000n), '99.5')
  assert.equal(formatMicrosAsYuan(1_000_000n), '1')
  assert.equal(formatMicrosAsYuan(0n), '0')
  assert.equal(formatMicrosAsYuan(-2_500_000n), '-2.5')
})

test('配置校验：未知字段 / 未知通道 / 范围倒挂都明确失败', async () => {
  assert.ok(issuesOf({ nope: 1 }).length > 0)
  assert.ok(issuesOf({ provider: 'alipay' }).length > 0)
  assert.ok(issuesOf({ minAmountYuan: 100, maxAmountYuan: 10 }).length > 0)
  assert.ok(issuesOf({ expiresMinutes: 0 }).length > 0)

  const ctx = new Context()
  await ctx.plugin(FakeUser)
  let failure: unknown
  try {
    await ctx.plugin(TopupService, { expiresMinutes: 0 })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof TopupError || failure instanceof Error)
})
