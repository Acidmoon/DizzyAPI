/**
 * 兑换码插件的测试。
 *
 * 覆盖：生成（整批 / 明文只出现一次 / 库里只有哈希与掩码）、兑换成功与金额精确性、
 * 幂等（并发只成功一次、余额只加一次）、加余额失败的回退、状态拒绝（停用 / 过期 /
 * 不存在 / 格式错 / 兑换中）、删除拒删已用与兑换中、管理面白名单、码规范化、
 * 人工核查两种结论、禁用回收（数据库连接关闭）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import RedeemService, {
  REDEEM_ACTOR,
  RedeemError,
  formatCodeForDisplay,
  generateCode,
  normalizeCode,
  validateRedeemConfig,
  type RedeemChangedEvent,
  type RedeemConfig,
  type RedeemErrorCode,
  type ResolvedRedeemConfig,
} from '../src/index.ts'

const ADMIN = '@dizzyapi/plugin-api'
const OTHER = '@dizzyapi/plugin-web'

interface Hold {
  /** 已经进入 adjustBalance（说明 CAS 占位已完成）。 */
  readonly started: Promise<void>
  /** 放行；`fail` 为 true 时让 adjustBalance 抛错。 */
  release(fail?: boolean): void
}

interface AdjustGate {
  readonly promise: Promise<boolean>
  readonly markStarted: () => void
  readonly release: (value: boolean) => void
}

/** 只声明兑换码插件用到的 user 面：get(id) / adjustBalance(...)。 */
class FakeUser extends Service {
  private readonly users = new Map<number, 'enabled' | 'banned'>()
  private readonly balances = new Map<number, bigint>()
  readonly calls: { consumer: string; id: number; delta: bigint; reason: string }[] = []
  private hold: AdjustGate | undefined

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  add(id: number, status: 'enabled' | 'banned' = 'enabled', balance = 0n): void {
    this.users.set(id, status)
    this.balances.set(id, balance)
  }

  /** 让下一次 adjustBalance 挂起：进入时 resolve `started`，等 release() 才继续。 */
  holdNextAdjust(): Hold {
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    let releaseAdjust!: (value: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      releaseAdjust = resolve
    })
    this.hold = { promise, markStarted, release: (value) => releaseAdjust(value) }
    const gate = this.hold
    return {
      started,
      release: (fail = false) => {
        gate.release(fail)
      },
    }
  }

  balanceOf(id: number): bigint {
    return this.balances.get(id) ?? 0n
  }

  async get(id: number): Promise<{ id: number; name: string; status: 'enabled' | 'banned' } | undefined> {
    const status = this.users.get(id)
    return status === undefined ? undefined : { id, name: `user-${id}`, status }
  }

  async adjustBalance(consumer: string, id: number, delta: bigint, reason: string): Promise<bigint> {
    const hold = this.hold
    if (hold !== undefined) {
      this.hold = undefined
      hold.markStarted()
      const fail = await hold.promise
      if (fail) throw new Error('fake adjustBalance 失败')
    }
    const current = this.balances.get(id)
    if (current === undefined) throw new Error(`fake user ${id} 不存在`)
    const next = current + delta
    this.balances.set(id, next)
    this.calls.push({ consumer, id, delta, reason })
    return next
  }
}

interface World {
  readonly ctx: Context
  readonly service: RedeemService
  readonly user: FakeUser
  readonly events: RedeemChangedEvent[]
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, config: RedeemConfig = {}): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  const user = ctx.get('user') as unknown as FakeUser
  const fiber = await ctx.plugin(RedeemService, { adminPlugins: [ADMIN], ...config })
  const service = ctx.get('redeem') as RedeemService
  const events: RedeemChangedEvent[] = []
  ctx.on('redeem/changed', (event) => {
    events.push(event)
  })
  const dispose = async (): Promise<void> => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能已经卸载过。
    }
  }
  t.after(dispose)
  return { ctx, service, user, events, dispose }
}

async function rejectsCode(promise: Promise<unknown>, code: RedeemErrorCode): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RedeemError, `期望 RedeemError，实际是 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

/** 从「分组展示码」拿回规范化明文，再拿去兑换（模拟用户输入）。 */
function displayCodeOf(display: string): string {
  return normalizeCode(display)
}

/** 按展示码末 4 位找对应的列表记录（列表只给掩码）。 */
function itemByDisplay<T extends { readonly codeMask: string }>(items: readonly T[], display: string): T {
  const suffix = displayCodeOf(display).slice(-4)
  const found = items.find((item) => item.codeMask.endsWith(suffix))
  assert.ok(found !== undefined, '列表里应当能找到这个码的掩码')
  return found
}

/** 测试里要打印含 bigint 的视图（金额是微元 bigint）。 */
function toJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  )
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'redeem-test-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

// ───────────────────────────────── 生成 ─────────────────────────────────

test('生成：整批成功，明文只在返回值里出现一次', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, {
    name: '双十一',
    amountMicro: 5_000_000n,
    count: 3,
  })

  assert.equal(created.batch.total, 3)
  assert.equal(created.batch.codeCount, 3)
  assert.equal(created.batch.usedCount, 0)
  assert.equal(created.batch.amountMicro, 5_000_000n)
  assert.equal(created.batch.kind, 'balance')
  assert.equal(created.codes.length, 3)
  for (const code of created.codes) {
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){5}$/)
  }
  assert.equal(new Set(created.codes).size, 3)

  // 管理面列表：只有掩码，没有哈希、没有明文。
  const page = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  assert.equal(page.total, 3)
  assert.equal(page.items.length, 3)
  const masks = page.items.map((item) => item.codeMask)
  for (const mask of masks) assert.match(mask, /^\*{4}[0-9A-Z]{4}$/)
  for (const code of created.codes) {
    const plain = displayCodeOf(code)
    assert.ok(!masks.includes(plain), '列表不得出现明文')
    for (const item of page.items) {
      assert.ok(!toJson(item).includes(plain), '列表行不得包含明文')
    }
  }

  // 事件不含明文与哈希。
  const emitted = toJson(world.events)
  for (const code of created.codes) assert.ok(!emitted.includes(displayCodeOf(code)))
  const batchEvent = world.events.find((event) => event.action === 'batch-created')
  assert.deepEqual(batchEvent, { action: 'batch-created', batchId: created.batch.id, count: 3 })
})

test('生成：库里只有哈希与掩码，明文不落盘', async (t) => {
  const dir = await tempDir(t)
  const world = await boot(t, { dataPath: join(dir, 'redeem.db') })
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, {
    name: '磁盘检查',
    amountMicro: 1_000_000n,
    count: 2,
  })
  const plains = created.codes.map(displayCodeOf)

  await world.dispose()

  const files = [join(dir, 'redeem.db'), join(dir, 'redeem.db-wal')].filter((path) => existsSync(path))
  assert.ok(files.length > 0, '数据库文件应已落盘')
  for (const file of files) {
    const raw = (await readFile(file)).toString('latin1')
    for (const plain of plains) {
      assert.ok(!raw.includes(plain), `明文不得出现在 ${file}`)
    }
    // 掩码应当落库（它是唯一允许出现在列表里的片段）。
    assert.ok(raw.includes(plains[0]!.slice(-4)) === true || raw.includes(plains[1]!.slice(-4)) === true)
  }
})

test('生成：非法输入明确失败，且不留半批', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const base = { name: '整批失败', amountMicro: 1_000_000n, count: 2 }

  await rejectsCode(world.service.createBatch(ADMIN, { ...base, name: 'x'.repeat(21) }), 'REDEEM_INVALID_INPUT')
  await rejectsCode(world.service.createBatch(ADMIN, { ...base, count: 0 }), 'REDEEM_INVALID_INPUT')
  await rejectsCode(world.service.createBatch(ADMIN, { ...base, count: 101 }), 'REDEEM_INVALID_INPUT')
  await rejectsCode(world.service.createBatch(ADMIN, { ...base, amountMicro: 0n }), 'REDEEM_INVALID_INPUT')
  await rejectsCode(
    world.service.createBatch(ADMIN, { ...base, amountMicro: '1.5' }),
    'REDEEM_INVALID_INPUT',
  )
  await rejectsCode(
    world.service.createBatch(ADMIN, { ...base, amountMicro: 1.5 as unknown as bigint }),
    'REDEEM_INVALID_INPUT',
  )
  await rejectsCode(
    world.service.createBatch(ADMIN, { ...base, expiresAt: '2020-01-01T00:00:00.000Z' }),
    'REDEEM_INVALID_INPUT',
  )

  const stats = await world.service.stats(ADMIN)
  assert.equal(stats.batches, 0)
  assert.equal(stats.codes, 0)

  // 合法输入仍然能成功（错误没有污染连接）。
  const ok = await world.service.createBatch(ADMIN, base)
  assert.equal(ok.codes.length, 2)
})

test('配置：未知字段与非法白名单直接报错', () => {
  assert.ok(Array.isArray(validateRedeemConfig({ nope: 1 })))
  assert.ok(Array.isArray(validateRedeemConfig({ adminPlugins: [1] })))
  const resolved = validateRedeemConfig({}) as ResolvedRedeemConfig
  assert.deepEqual(resolved.adminPlugins, [])
})

test('配置：dataPath 写 :memory: 时按内存库处理，不当成相对路径', async (t) => {
  const world = await boot(t, { dataPath: ':memory:' })
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, {
    name: '内存库',
    amountMicro: 1_000_000n,
    count: 1,
  })
  await world.service.redeemCode({ userId: 1, code: created.codes[0]! })
  assert.equal(world.user.balanceOf(1), 1_000_000n)
})

// ───────────────────────────────── 兑换 ─────────────────────────────────

test('兑换：余额按微元精确增加，consumer 与 reason 正确', async (t) => {
  const world = await boot(t)
  world.user.add(1, 'enabled', 1_000_000n)
  const created = await world.service.createBatch(ADMIN, {
    name: '精确额度',
    amountMicro: 3_500_000n,
    count: 1,
  })
  const plain = displayCodeOf(created.codes[0]!)

  const result = await world.service.redeemCode({ userId: 1, code: created.codes[0]! })
  assert.equal(result.amount, 3_500_000n)
  assert.equal(result.balance, 4_500_000n)
  assert.equal(result.batchName, '精确额度')

  assert.equal(world.user.balanceOf(1), 4_500_000n)
  assert.equal(world.user.calls.length, 1)
  const call = world.user.calls[0]!
  assert.equal(call.consumer, REDEEM_ACTOR)
  assert.equal(call.delta, 3_500_000n)
  assert.match(call.reason, /\*{4}[0-9A-Z]{4}$/)
  assert.ok(!call.reason.includes(plain), '余额流水不得包含明文')

  // 已用：状态与记录都对得上。
  const page = await world.service.listCodes(ADMIN, { status: 'used' })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0]!.redeemedBy, '1')
  assert.ok(page.items[0]!.redeemedAt !== null)

  const mine = await world.service.listMyRedemptions(1)
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.amountMicro, 3_500_000n)
  assert.equal(mine[0]!.batchName, '精确额度')
  assert.equal(mine[0]!.codeMask, page.items[0]!.codeMask)

  const stats = await world.service.stats(ADMIN)
  assert.equal(stats.used, 1)
  assert.equal(stats.redeemedAmountMicro, 3_500_000n)
})

test('幂等：同一码第二次失败，余额只加一次；并发也只成功一次', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, {
    name: '幂等',
    amountMicro: 2_000_000n,
    count: 2,
  })

  await world.service.redeemCode({ userId: 1, code: created.codes[0]! })
  await rejectsCode(
    world.service.redeemCode({ userId: 1, code: created.codes[0]! }),
    'REDEEM_CODE_USED',
  )
  assert.equal(world.user.balanceOf(1), 2_000_000n)
  assert.equal(world.user.calls.length, 1)

  // 并发：同一个码同时兑两次，只能成功一次。
  const results = await Promise.allSettled([
    world.service.redeemCode({ userId: 1, code: created.codes[1]! }),
    world.service.redeemCode({ userId: 1, code: created.codes[1]! }),
  ])
  const fulfilled = results.filter((item) => item.status === 'fulfilled')
  const rejected = results.filter((item) => item.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  const reason = (rejected[0] as PromiseRejectedResult).reason
  assert.ok(reason instanceof RedeemError)
  assert.ok(
    reason.code === 'REDEEM_CODE_USED' || reason.code === 'REDEEM_CODE_REDEEMING',
    `并发输家应报已用或兑换中，实际 ${reason.code}`,
  )
  assert.equal(world.user.balanceOf(1), 4_000_000n)
  assert.equal(world.user.calls.length, 2)
})

test('失败回退：加余额失败时码回到 enabled，重试可以兑成功', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, {
    name: '回退',
    amountMicro: 1_000_000n,
    count: 1,
  })
  const plain = displayCodeOf(created.codes[0]!)

  const gate = world.user.holdNextAdjust()
  const pending = world.service.redeemCode({ userId: 1, code: created.codes[0]! })
  await gate.started
  // 此刻已抢占：兑换中。
  await rejectsCode(
    world.service.redeemCode({ userId: 1, code: created.codes[0]! }),
    'REDEEM_CODE_REDEEMING',
  )
  gate.release(true)
  await rejectsCode(pending, 'REDEEM_CODE_BALANCE_FAILED')

  const after = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  assert.equal(after.items[0]!.status, 'enabled')
  assert.equal(after.items[0]!.reservedAt, null)
  assert.equal(after.items[0]!.reservedBy, null)
  assert.equal(world.user.balanceOf(1), 0n)

  // 回退之后仍然可用。
  await world.service.redeemCode({ userId: 1, code: plain })
  assert.equal(world.user.balanceOf(1), 1_000_000n)
})

test('状态：停用 / 不存在 / 格式错各自明确报错，且不回显码', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '状态', amountMicro: 1_000_000n, count: 2 })
  const page = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  const disabledTarget = itemByDisplay(page.items, created.codes[0]!)

  const disabled = await world.service.setCodeStatus(ADMIN, disabledTarget.id, 'disabled')
  assert.equal(disabled.status, 'disabled')
  await rejectsCode(
    world.service.redeemCode({ userId: 1, code: created.codes[0]! }),
    'REDEEM_CODE_DISABLED',
  )

  const missing = await world.service
    .redeemCode({ userId: 1, code: generateCode() })
    .catch((error: unknown) => error)
  assert.ok(missing instanceof RedeemError)
  assert.equal(missing.code, 'REDEEM_CODE_NOT_FOUND')

  const malformed = await world.service
    .redeemCode({ userId: 1, code: 'not-a-code' })
    .catch((error: unknown) => error)
  assert.ok(malformed instanceof RedeemError)
  assert.equal(malformed.code, 'REDEEM_CODE_INVALID')
  assert.ok(!malformed.message.includes('not-a-code'), '错误信息不得回显输入的码')

  const shortCode = await world.service
    .redeemCode({ userId: 1, code: created.codes[1]!.slice(0, 8) })
    .catch((error: unknown) => error)
  assert.ok(shortCode instanceof RedeemError)
  assert.equal(shortCode.code, 'REDEEM_CODE_INVALID')
})

test('过期：有效期过后报 REDEEM_CODE_EXPIRED', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
  const created = await world.service.createBatch(ADMIN, {
    name: '会过期',
    amountMicro: 1_000_000n,
    count: 1,
    expiresAt,
  })

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60 * 60_000 })
  await rejectsCode(
    world.service.redeemCode({ userId: 1, code: created.codes[0]! }),
    'REDEEM_CODE_EXPIRED',
  )
  assert.equal(world.user.balanceOf(1), 0n)
})

test('用户：被封禁或不存在时拒绝兑换', async (t) => {
  const world = await boot(t)
  world.user.add(1, 'banned')
  const created = await world.service.createBatch(ADMIN, { name: '封禁', amountMicro: 1_000_000n, count: 1 })

  await rejectsCode(
    world.service.redeemCode({ userId: 1, code: created.codes[0]! }),
    'REDEEM_USER_FORBIDDEN',
  )
  await rejectsCode(
    world.service.redeemCode({ userId: 999, code: created.codes[0]! }),
    'REDEEM_USER_FORBIDDEN',
  )
  // 码没有被占用。
  const page = await world.service.listCodes(ADMIN, { status: 'enabled' })
  assert.equal(page.items.length, 1)
})

test('规范化：大小写与分隔符不同也能兑成功', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '规范化', amountMicro: 1_000_000n, count: 1 })
  const plain = displayCodeOf(created.codes[0]!)
  const messy = `  ${plain.toLowerCase().replaceAll('-', ' - ')}  `

  await world.service.redeemCode({ userId: 1, code: messy })
  assert.equal(world.user.balanceOf(1), 1_000_000n)

  // 展示形式符合分组约定。
  assert.equal(formatCodeForDisplay(plain), created.codes[0])
})

// ───────────────────────────────── 管理面 ─────────────────────────────────

test('删除：used 与 redeeming 拒删，enabled / disabled 可删', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '删除', amountMicro: 1_000_000n, count: 4 })
  const page = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  const byId = new Map(page.items.map((item) => [item.id, item]))
  assert.equal(page.items.length, 4)

  // 一个用掉、一个停用。
  await world.service.redeemCode({ userId: 1, code: created.codes[0]! })
  await world.service.setCodeStatus(
    ADMIN,
    itemByDisplay(page.items, created.codes[1]!).id,
    'disabled',
  )

  // 造一个「兑换中」：占位完成后不放行 adjustBalance。
  const gate = world.user.holdNextAdjust()
  const pending = world
    .service.redeemCode({ userId: 1, code: created.codes[2]! })
    .catch((error: unknown) => error)
  await gate.started
  const redeemingItem = (await world.service.listCodes(ADMIN, { status: 'redeeming' })).items[0]!
  assert.ok(byId.has(redeemingItem.id))

  // 剩下那个还 enabled 的码（codes[3]）应当可以删。
  const fresh = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  const usedItem = itemByDisplay(fresh.items, created.codes[0]!)
  const disabledItem = itemByDisplay(fresh.items, created.codes[1]!)
  const keep = itemByDisplay(fresh.items, created.codes[3]!)
  assert.equal(keep.status, 'enabled')

  const result = await world.service.deleteCodes(ADMIN, [
    usedItem.id,
    redeemingItem.id,
    disabledItem.id,
    keep.id,
  ])
  assert.equal(result.deleted, 2)
  const reasons = result.rejected.map((item) => item.reason).sort()
  assert.deepEqual(reasons, ['REDEEM_CODE_REDEEMING', 'REDEEM_CODE_USED'])

  gate.release(true)
  const pendingError = await pending
  assert.ok(pendingError instanceof RedeemError)
  assert.equal(pendingError.code, 'REDEEM_CODE_BALANCE_FAILED')

  const left = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  assert.equal(left.items.length, 2)
  assert.deepEqual(
    left.items.map((item) => item.status).sort(),
    ['enabled', 'used'],
  )
})

test('人工核查：redeeming 可标记为已用或退回可用', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '核查', amountMicro: 1_000_000n, count: 2 })

  // 标记为已用：redeemed_by 取自占位时记下的用户。
  const gateUsed = world.user.holdNextAdjust()
  const pendingUsed = world.service
    .redeemCode({ userId: 1, code: created.codes[0]! })
    .catch((error: unknown) => error)
  await gateUsed.started
  const redeemingUsed = (await world.service.listCodes(ADMIN, { status: 'redeeming' })).items[0]!
  const asUsed = await world.service.resolveRedeeming(ADMIN, redeemingUsed.id, 'used')
  assert.equal(asUsed.status, 'used')
  assert.equal(asUsed.redeemedBy, '1')
  assert.equal(asUsed.reservedAt, null)
  gateUsed.release(true)
  const usedFailure = await pendingUsed
  assert.ok(usedFailure instanceof RedeemError)
  assert.equal(usedFailure.code, 'REDEEM_CODE_BALANCE_FAILED')

  // 退回可用。
  const gateEnabled = world.user.holdNextAdjust()
  const pendingEnabled = world.service
    .redeemCode({ userId: 1, code: created.codes[1]! })
    .catch((error: unknown) => error)
  await gateEnabled.started
  const redeemingEnabled = (await world.service.listCodes(ADMIN, { status: 'redeeming' })).items[0]!
  const asEnabled = await world.service.resolveRedeeming(ADMIN, redeemingEnabled.id, 'enabled')
  assert.equal(asEnabled.status, 'enabled')
  assert.equal(asEnabled.reservedBy, null)
  gateEnabled.release(true)
  await pendingEnabled

  // 非 redeeming 的码不能用核查动作改状态。
  const page = await world.service.listCodes(ADMIN, { status: 'enabled' })
  await rejectsCode(
    world.service.resolveRedeeming(ADMIN, page.items[0]!.id, 'used'),
    'REDEEM_CODE_CONFLICT',
  )
})

test('白名单：非白名单 actor 的读写都被拒', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '白名单', amountMicro: 1_000_000n, count: 1 })

  await rejectsCode(
    world.service.createBatch(OTHER, { name: 'x', amountMicro: 1_000_000n, count: 1 }),
    'REDEEM_ACTOR_FORBIDDEN',
  )
  await rejectsCode(world.service.listBatches(OTHER), 'REDEEM_ACTOR_FORBIDDEN')
  await rejectsCode(world.service.listCodes(OTHER), 'REDEEM_ACTOR_FORBIDDEN')
  await rejectsCode(world.service.stats(OTHER), 'REDEEM_ACTOR_FORBIDDEN')
  await rejectsCode(world.service.getBatch(OTHER, created.batch.id), 'REDEEM_ACTOR_FORBIDDEN')
  await rejectsCode(world.service.deleteCodes(OTHER, []), 'REDEEM_ACTOR_FORBIDDEN')

  // 白名单内的 actor 正常。
  assert.equal((await world.service.listBatches(ADMIN)).length, 1)
})

test('列表：状态 / 掩码关键字 / 分页筛选', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '筛选', amountMicro: 1_000_000n, count: 5 })
  const page = await world.service.listCodes(ADMIN, { batchId: created.batch.id })
  const target = page.items[0]!

  const found = await world.service.listCodes(ADMIN, { keyword: target.codeMask.slice(-4) })
  assert.equal(found.total, 1)
  assert.equal(found.items[0]!.id, target.id)

  const limited = await world.service.listCodes(ADMIN, { batchId: created.batch.id, limit: 2 })
  assert.equal(limited.items.length, 2)
  assert.equal(limited.total, 5)

  const second = await world.service.listCodes(ADMIN, {
    batchId: created.batch.id,
    limit: 2,
    offset: 2,
  })
  assert.equal(second.items.length, 2)
  const overlap = second.items.filter((item) => limited.items.some((first) => first.id === item.id))
  assert.equal(overlap.length, 0)

  // 过期筛选：把时钟推到有效期之后，派生状态 expired 与统计都要跟上。
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
  await world.service.createBatch(ADMIN, {
    name: '会过期',
    amountMicro: 1_000_000n,
    count: 2,
    expiresAt,
  })
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 2 * 60 * 60_000 })
  const expired = await world.service.listCodes(ADMIN, { status: 'expired' })
  assert.equal(expired.total, 2)
  assert.ok(expired.items.every((item) => item.id !== target.id))
  const expiredStats = await world.service.stats(ADMIN)
  assert.equal(expiredStats.expired, 2)
})

test('禁用回收：卸载后数据库连接关闭', async (t) => {
  const world = await boot(t)
  world.user.add(1)
  const created = await world.service.createBatch(ADMIN, { name: '回收', amountMicro: 1_000_000n, count: 1 })
  await world.dispose()

  await assert.rejects(world.service.listCodes(ADMIN))
  await assert.rejects(world.service.listMyRedemptions(1))
  await assert.rejects(world.service.redeemCode({ userId: 1, code: created.codes[0]! }))
})
