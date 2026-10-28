/**
 * 账号快照的形状测试（第 3、4 段链路）。
 *
 * 这里不 spawn gatewayd：直接驱动 `buildAccountSnapshot()`，断言推给 Go 的那份快照
 * 真的带上了 tags / weight / concurrency / health，并且**账号没声明时不带这些键**
 * （旧快照形状不被破坏，Go 侧 `DisallowUnknownFields` 也才不会踩到新键）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import CredentialsService from '../../credentials/src/index.ts'
import IdentityService from '../../identity/src/index.ts'
import AccountPriorityService, { labelsToTags, type GatewayAccountSnapshot } from '../src/index.ts'

interface FakeAccount {
  readonly id: string
  readonly provider: string
  readonly kind: string
  readonly enabled: boolean
  readonly status: string
  readonly baseUrl?: string | null
  readonly protocol?: string | null
  readonly models?: readonly string[] | null
  readonly modelMap?: Record<string, string> | null
  readonly priority?: number
  readonly labels?: readonly string[] | null
  readonly weight?: number | null
  readonly concurrency?: number | null
  readonly health?: string | null
  readonly accessExpiresAt: string | null
}

class FakeIdentity extends Service {
  private readonly accounts = new Map<string, FakeAccount>()
  private readonly tokens = new Map<string, string>()
  /** 记录最近一次 list() 的返回，便于断言「按身份写者给的形状取数据」。 */
  listed = 0

  constructor(ctx: Context) {
    super(ctx, 'identity')
  }

  list(): FakeAccount[] {
    this.listed += 1
    return [...this.accounts.values()]
  }

  async getAccessToken(id: string): Promise<string> {
    const token = this.tokens.get(id)
    if (token === undefined) throw new Error(`账号 ${id} 没有令牌`)
    return token
  }

  add(account: FakeAccount, token: string | null = 'sk-token'): void {
    this.accounts.set(account.id, account)
    if (token === null) this.tokens.delete(account.id)
    else this.tokens.set(account.id, token)
  }
}

interface World {
  readonly ctx: Context
  readonly service: AccountPriorityService
  readonly identity: FakeIdentity
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-account-snapshot-'))
  const ctx = new Context()
  await ctx.plugin(FakeIdentity)
  const identity = ctx.get('identity') as unknown as FakeIdentity
  const fiber = await ctx.plugin(AccountPriorityService, {
    dataPath: join(dir, 'strategies.json'),
    autoStart: false,
    transport: 'tcp',
    upstreamBaseUrls: { openai: 'https://api.openai.com/v1' },
  })
  const world: World = {
    ctx,
    service: ctx.get('accountPriority') as AccountPriorityService,
    identity,
    dispose: async () => {
      try {
        await fiber.dispose()
      } catch {
        // 用例可能已经卸载过。
      }
      await rm(dir, { recursive: true, force: true })
    },
  }
  t.after(world.dispose)
  return world
}

/** `buildAccountSnapshot` 是内部方法；测试直接驱动它，避免为断言形状去 spawn 子进程。 */
function snapshotOf(service: AccountPriorityService): Promise<GatewayAccountSnapshot> {
  return (
    service as unknown as { buildAccountSnapshot(): Promise<GatewayAccountSnapshot> }
  ).buildAccountSnapshot()
}

function account(id: string, overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id,
    provider: 'openai',
    kind: 'api_key',
    enabled: true,
    status: 'active',
    baseUrl: null,
    priority: 0,
    accessExpiresAt: null,
    ...overrides,
  }
}

test('标签 → tags 约定：带值、纯标签、重复 key、空 label、非法 label', () => {
  assert.deepEqual(labelsToTags([]), {})
  assert.deepEqual(labelsToTags(null), {})
  assert.deepEqual(labelsToTags(undefined), {})

  // 带值：第一个冒号切分，值里可以再出现冒号。
  assert.deepEqual(labelsToTags(['tier:pro']), { tier: 'pro' })
  assert.deepEqual(labelsToTags(['route:https://x.test/v1']), { route: 'https://x.test/v1' })

  // 纯标签：键就是标签名、值为空串（Go 侧精确匹配「带这个标签」）。
  assert.deepEqual(labelsToTags(['beta']), { beta: '' })

  // 同一个 key 先出现的胜出。
  assert.deepEqual(labelsToTags(['tier:pro', 'tier:free']), { tier: 'pro' })

  // 空 label / 纯空白 / 空 key 被丢弃。
  assert.deepEqual(labelsToTags(['', '   ', ':value', '  :  ']), {})
  assert.deepEqual(labelsToTags(['tier:pro', '', 'team:ops']), { tier: 'pro', team: 'ops' })

  // 键值都 trim。
  assert.deepEqual(labelsToTags([' tier : pro ']), { tier: 'pro' })
})

test('快照带 tags / weight / concurrency / health；没声明的账号不带这些键', async (t) => {
  const world = await boot(t)
  world.identity.add(
    account('acc-rich', {
      labels: ['tier:pro', 'beta', 'team:ops'],
      weight: 2.5,
      concurrency: 4,
      health: 'degraded',
    }),
  )
  world.identity.add(account('acc-plain'))

  const snapshot = await snapshotOf(world.service)
  assert.equal(snapshot.version, 1)
  const byId = new Map(snapshot.accounts.map((item) => [item.accountId, item]))

  const rich = byId.get('acc-rich')
  assert.ok(rich !== undefined)
  assert.deepEqual(rich.tags, { tier: 'pro', beta: '', team: 'ops' })
  assert.equal(rich.weight, 2.5)
  assert.equal(rich.concurrency, 4)
  assert.equal(rich.health, 'degraded')

  const plain = byId.get('acc-plain')
  assert.ok(plain !== undefined)
  // 未声明 = 不带键：旧快照形状不被破坏，Go 侧按「未知」处理。
  assert.ok(!('tags' in plain), '没打标签的账号不该带 tags 键')
  assert.ok(!('weight' in plain), '没声明权重的账号不该带 weight 键')
  assert.ok(!('concurrency' in plain), '没声明并发的账号不该带 concurrency 键')
  assert.ok(!('health' in plain), '没声明健康的账号不该带 health 键')

  // 令牌只进快照，不进任何日志 / 状态；这里只确认它确实在快照里（桥帧需要）。
  assert.equal(rich.token, 'sk-token')
})

test('健康状态只透传四个合法值；来路不明的字符串当成未声明', async (t) => {
  const world = await boot(t)
  world.identity.add(account('acc-ok', { health: 'healthy' }))
  // 结构性 seam 的用户可能不守约：非法值必须被挡在快照之外，否则 Go 会整份拒绝。
  world.identity.add(account('acc-bogus', { health: 'sick' }))

  const snapshot = await snapshotOf(world.service)
  const byId = new Map(snapshot.accounts.map((item) => [item.accountId, item]))
  assert.equal(byId.get('acc-ok')?.health, 'healthy')
  assert.ok(!('health' in (byId.get('acc-bogus') ?? {})))
})

test('不可参与调度的账号不进快照：停用、待重新授权、自动停用、没有令牌', async (t) => {
  const world = await boot(t)
  world.identity.add(account('acc-active'))
  world.identity.add(account('acc-disabled', { enabled: false, labels: ['x'] }))
  world.identity.add(account('acc-reauth', { status: 'needs_reauth' }))
  world.identity.add(account('acc-auto', { status: 'auto_disabled' }))
  world.identity.add(account('acc-no-token'), null)

  const snapshot = await snapshotOf(world.service)
  assert.deepEqual(
    snapshot.accounts.map((item) => item.accountId),
    ['acc-active'],
  )
})

// ───────────────────────── 与真实 identity 的接缝（第 1→4 段的形状一致性） ─────────────────────────

test('真 identity 的记录直接进快照：字段名与空值语义一致，不需要额外适配', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-identity-snapshot-'))
  const ctx = new Context()
  const credentialsFiber = await ctx.plugin(CredentialsService, { dataPath: join(dir, 'credentials.json') })
  const identityFiber = await ctx.plugin(IdentityService, {
    dataPath: join(dir, 'accounts.json'),
    pollIntervalMs: 3_600_000,
  })
  t.after(async () => {
    try {
      await identityFiber.dispose()
    } catch {
      // ignore
    }
    try {
      await credentialsFiber.dispose()
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true })
  })

  const identity = ctx.get('identity') as IdentityService
  const rich = await identity.create({
    provider: 'custom',
    kind: 'api_key',
    label: '真实记录',
    baseUrl: 'https://upstream.example.com/v1',
    secret: { apiKey: 'sk-real' },
  })
  await identity.setLabels(rich.id, ['tier:pro', 'beta'])
  await identity.setWeight(rich.id, 3)
  await identity.setConcurrency(rich.id, 2)
  await identity.setHealth(rich.id, 'healthy')

  // 自动停用的账号不该进快照（它不参与调度）。
  const auto = await identity.create({
    provider: 'custom',
    kind: 'api_key',
    label: '自动停用',
    baseUrl: 'https://upstream.example.com/v1',
    secret: { apiKey: 'sk-auto' },
  })
  await identity.autoDisable(auto.id, '连续失败 3 次：HTTP 502')

  const priorityFiber = await ctx.plugin(AccountPriorityService, {
    dataPath: join(dir, 'strategies.json'),
    autoStart: false,
    upstreamBaseUrls: {},
  })
  t.after(async () => {
    try {
      await priorityFiber.dispose()
    } catch {
      // ignore
    }
  })

  const snapshot = await snapshotOf(ctx.get('accountPriority') as AccountPriorityService)
  assert.equal(snapshot.accounts.length, 1, '只应有 active 且 enabled 的账号')
  const account = snapshot.accounts[0]
  assert.ok(account !== undefined)
  assert.equal(account.accountId, rich.id)
  assert.deepEqual(account.tags, { tier: 'pro', beta: '' })
  assert.equal(account.weight, 3)
  assert.equal(account.concurrency, 2)
  assert.equal(account.health, 'healthy')
  assert.equal(account.baseUrl, 'https://upstream.example.com/v1')
  // 令牌只有真的（这里是真的）才在桥帧里；账号文件里没有它。
  assert.equal(account.token, 'sk-real')
})
