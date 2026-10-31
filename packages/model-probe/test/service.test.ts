/**
 * 插件编排的护栏（真 cordis 上下文 + 假服务）。
 *
 * 护的是这一条链：取模型列表 → 从 credentials 解析明文 → 发探测 → 落库 → 派生状态。
 * 以及最重要的那两条：
 * - **探测 key 明文缺失时，一条请求都不发**（而不是发出去再记成 failed）；
 * - **探测用户没钱（402）时挂停摆原因，而不是把模型标红**。
 */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import ModelProbeService, {
  ModelProbeError,
  MODEL_PROBE_ACTOR,
  type ModelProbeConfig,
} from '../src/index.ts'

interface CatalogEntry {
  readonly model: string
  readonly accountCount: number
}

/** 假模型广场：本用例只关心「目录里有哪些模型 + 有没有账号声明」。 */
class FakeModelHub extends Service {
  available: CatalogEntry[] = []
  unavailable: CatalogEntry[] = []
  constructor(ctx: Context) {
    super(ctx, 'modelhub')
  }
  catalog() {
    return { available: this.available, unavailable: this.unavailable, summary: {} as never }
  }
}

/** 假 api-key：记录创建 / 轮换的入参。 */
class FakeApiKey extends Service {
  readonly created: { name: string; appManaged?: boolean }[] = []
  readonly rotated: string[] = []
  readonly existing: { id: string; name: string; appManaged: boolean; enabled: boolean; secret: string | null }[] = []
  constructor(ctx: Context) {
    super(ctx, 'apiKey')
  }
  async list() {
    return this.existing.map((key) => ({ ...key }))
  }
  async create(_userId: number, input: { name: string; appManaged?: boolean }) {
    this.created.push(input)
    const key = { id: 'probe-key-1', name: input.name, appManaged: input.appManaged === true, enabled: true, secret: 'sk-dz-probe' }
    this.existing.push(key)
    return { key: { ...key }, secret: 'sk-dz-probe' }
  }
  async rotate(_userId: number, id: string) {
    this.rotated.push(id)
    const key = this.existing.find((item) => item.id === id)
    assert.ok(key !== undefined)
    return { key: { ...key }, secret: 'sk-dz-rotated' }
  }
}

/** 假 credentials：只在内存里存，记录写过什么。 */
class FakeCredentials extends Service {
  readonly values = new Map<string, string>()
  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }
  describe(ref: string) {
    return { configured: this.values.has(ref) }
  }
  resolve(ref: string) {
    return this.values.get(ref)
  }
  async set(ref: string, value: string) {
    this.values.set(ref, value)
  }
}

const REF = 'dizzyapi/model-probe/key'
/** 固定门面地址：fetch 是被注入的桩，不会真的发请求。 */
const GATEWAY = 'http://127.0.0.1:65535'

interface World {
  readonly ctx: Context
  readonly probe: ModelProbeService
  readonly hub: FakeModelHub
  readonly keys: FakeApiKey
  readonly credentials: FakeCredentials
  readonly fiber: { dispose(): Promise<void> | void }
  /** 记录每次探测请求的 URL 与 body。 */
  readonly requests: { url: string; body: string; auth: string }[]
}

async function boot(
  t: TestContext,
  options: {
    readonly config?: ModelProbeConfig
    readonly respond?: (model: string) => { status: number; body: string }
    readonly models?: CatalogEntry[]
  } = {},
): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeModelHub)
  await ctx.plugin(FakeApiKey)
  await ctx.plugin(FakeCredentials)

  const hub = ctx.get('modelhub') as unknown as FakeModelHub
  hub.available = options.models ?? [{ model: 'model-a', accountCount: 1 }]
  const keys = ctx.get('apiKey') as unknown as FakeApiKey
  const credentials = ctx.get('credentials') as unknown as FakeCredentials

  const requests: { url: string; body: string; auth: string }[] = []
  const respond = options.respond ?? (() => ({ status: 200, body: '{"choices":[]}' }))
  // 关掉真定时器：用例自己调 runPass，避免测试里出现不确定的时钟。
  const fiber = await ctx.plugin(ModelProbeService, {
    enabled: false,
    dataPath: ':memory:',
    probeUserId: 1,
    probeKeyRef: REF,
    gatewayBaseUrl: GATEWAY,
    adminPlugins: [MODEL_PROBE_ACTOR],
    ...options.config,
  })
  const probe = ctx.get('modelProbe') as ModelProbeService
  // 用桩替换 fetch：真网络在单测里不可控，而且不该被单测打到。
  ;(probe as unknown as { fetchImpl: typeof fetch }).fetchImpl = (async (url: string, init: RequestInit) => {
    const body = String(init.body)
    const model = (JSON.parse(body) as { model: string }).model
    requests.push({ url: String(url), body, auth: String((init.headers as Record<string, string>).authorization) })
    const reply = respond(model)
    return new Response(reply.body, { status: reply.status })
  }) as unknown as typeof fetch

  const world = { ctx, probe, hub, keys, credentials, fiber, requests }
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能已经卸载过。
    }
  })
  return world
}

test('首次运行自动建探测 key（appManaged），明文进 credentials，然后逐模型探测并落库', async (t) => {
  const world = await boot(t, {
    models: [
      { model: 'model-a', accountCount: 1 },
      { model: 'model-b', accountCount: 2 },
    ],
  })
  // 首次 init 时 enabled=false 所以没建 key；这里手动触发一轮前先让 runPass 自己解析。
  // enabled=false 的插件不注册定时器，但 ensureKey 也没跑 —— 明文本地塞一份模拟「已就绪」。
  world.credentials.values.set(REF, 'sk-dz-probe')

  const pass = await world.probe.runPass()
  assert.equal(pass.probed, 2)
  assert.equal(pass.ok, 2)
  assert.equal(pass.failed, 0)
  assert.equal(pass.probeErrors, 0)
  assert.deepEqual([...pass.models].sort(), ['model-a', 'model-b'])

  assert.equal(world.requests.length, 2)
  assert.ok(world.requests.every((item) => item.url === `${GATEWAY}/v1/chat/completions`))
  assert.ok(world.requests.every((item) => item.auth === 'Bearer sk-dz-probe'))

  const history = world.probe.history('model-a')
  assert.equal(history.points.length, 1)
  assert.equal(history.health, 'up')
})

test('只探「有账号声明」的模型：没有账号的模型不花请求', async (t) => {
  const world = await boot(t, {
    models: [
      { model: 'served', accountCount: 1 },
      // 有名字但没人提供：探测它只会得到 MODEL_NOT_SERVED，而那种「不可用」目录已经说清楚了。
      { model: 'orphan', accountCount: 0 },
    ],
  })
  world.credentials.values.set(REF, 'sk-dz-probe')
  const pass = await world.probe.runPass()

  assert.deepEqual(pass.models, ['served'])
  assert.equal(world.requests.length, 1)
})

test('probeModels 白名单生效', async (t) => {
  const world = await boot(t, {
    models: [
      { model: 'keep-me', accountCount: 1 },
      { model: 'skip-me', accountCount: 1 },
    ],
    config: { probeModels: ['keep-me'] },
  })
  world.credentials.values.set(REF, 'sk-dz-probe')
  const pass = await world.probe.runPass()

  assert.deepEqual(pass.models, ['keep-me'])
  assert.equal(world.requests.length, 1)
})

test('【假红护栏】探测用户余额不足（402）→ probe-error + 停摆原因，不是 failed', async (t) => {
  const world = await boot(t, {
    models: [
      { model: 'model-a', accountCount: 1 },
      { model: 'model-b', accountCount: 1 },
    ],
    respond: () => ({
      status: 402,
      body: JSON.stringify({ error: { message: '余额不足', code: 'INSUFFICIENT_BALANCE' } }),
    }),
  })
  world.credentials.values.set(REF, 'sk-dz-probe')

  const pass = await world.probe.runPass()
  assert.equal(pass.failed, 0, '402 绝不能算成模型 failed')
  assert.equal(pass.probeErrors, 2)

  const status = world.probe.status()
  assert.equal(status.blockedReason, 'probe_user_balance_exhausted')
  assert.match(status.blockedDetail ?? '', /余额不足/)
  // 健康度必须是 unknown：探测没测出东西，就什么都不能断言。
  assert.equal(world.probe.history('model-a').health, 'unknown')
})

test('探针恢复后清掉停摆原因', async (t) => {
  let moneyGone = true
  const world = await boot(t, {
    respond: () =>
      moneyGone
        ? { status: 402, body: JSON.stringify({ error: { code: 'INSUFFICIENT_BALANCE' } }) }
        : { status: 200, body: '{}' },
  })
  world.credentials.values.set(REF, 'sk-dz-probe')

  await world.probe.runPass()
  assert.equal(world.probe.status().blockedReason, 'probe_user_balance_exhausted')

  moneyGone = false
  await world.probe.runPass()
  assert.equal(world.probe.status().blockedReason, null)
  assert.equal(world.probe.history('model-a').health, 'up')
})

test('探测 key 明文缺失时一条请求都不发', async (t) => {
  const world = await boot(t)
  // 不往 credentials 里塞明文。
  const pass = await world.probe.runPass()

  assert.equal(pass.probed, 0)
  assert.equal(pass.skippedReason, 'probe_key_secret_missing')
  assert.equal(world.requests.length, 0)
  assert.equal(world.probe.status().blockedReason, 'probe_key_secret_missing')
})

test('模型目录为空时跳过，不把「没模型」当成「全挂了」', async (t) => {
  const world = await boot(t, { models: [] })
  world.credentials.values.set(REF, 'sk-dz-probe')
  const pass = await world.probe.runPass()

  assert.equal(pass.probed, 0)
  assert.equal(pass.skippedReason, 'catalog_empty')
  assert.equal(world.requests.length, 0)
})

test('runOnce 只对 adminPlugins 白名单开放', async (t) => {
  const world = await boot(t)
  world.credentials.values.set(REF, 'sk-dz-probe')

  await assert.rejects(
    () => world.probe.runOnce('@dizzyapi/plugin-evil'),
    (error: unknown) => error instanceof ModelProbeError && error.code === 'MODEL_PROBE_ACTOR_FORBIDDEN',
  )
  const pass = await world.probe.runOnce(MODEL_PROBE_ACTOR)
  assert.equal(pass.probed, 1)
})

test('单飞：并发两次 runPass 拿同一个 Promise，不会翻倍发请求', async (t) => {
  const world = await boot(t)
  world.credentials.values.set(REF, 'sk-dz-probe')

  const [first, second] = await Promise.all([world.probe.runPass(), world.probe.runPass()])
  assert.equal(first, second, '单飞应返回同一个结果对象')
  assert.equal(world.requests.length, 1)
})

test('status() 不含秘密值：只回「配没配」与引用名', async (t) => {
  const world = await boot(t)
  world.credentials.values.set(REF, 'sk-dz-super-secret')
  await world.probe.runPass()

  const status = world.probe.status()
  assert.equal(status.probeKeyConfigured, true)
  const serialized = JSON.stringify(status)
  assert.ok(!serialized.includes('sk-dz-super-secret'), 'status() 里绝不能出现明文')
  // 引用名本身不是秘密，显示它有助于排障。
  assert.equal(status.probeKeyRef, REF)
})

test('probeUserId 越界 → 装载直接失败（配置非法不静默降级）', async (t) => {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  // cordis 在构造前就用 schema 拦下，抛 ValidationError（比构造里再抛更早、更准）。
  await assert.rejects(
    async () =>
      ctx.plugin(ModelProbeService, { enabled: false, dataPath: ':memory:', probeUserId: 0 } as ModelProbeConfig),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /probeUserId 不能小于 1/)
      return true
    },
  )
  t.diagnostic('probeUserId=0 在构造前被拒绝')
})

test('probeUserId 缺失 → 装载直接失败（没有它不知道扣谁的钱）', async (t) => {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await assert.rejects(
    async () => ctx.plugin(ModelProbeService, { enabled: false, dataPath: ':memory:' } as ModelProbeConfig),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /probeUserId 必填/)
      return true
    },
  )
  t.diagnostic('缺失 probeUserId 被拒绝')
})
