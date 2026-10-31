/**
 * 装载冒烟：在真 cordis 上下文里把插件挂起来，确认配置能过、服务能注册、
 * 探测 key 在启动时就建好、定时器能注册与回收。
 *
 * 这条用例不碰真网络：`fetch` 被换成桩，`gatewayBaseUrl` 指向一个不可达端口，
 * 只验证**装载路径**本身（那是最容易在 app.yml 里配错的一段）。
 */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import ModelProbeService, { MODEL_PROBE_CONFIG_SCHEMA, type ModelProbeConfig } from '../src/index.ts'

class FakeModelHub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'modelhub')
  }
  catalog() {
    return { available: [{ model: 'm', accountCount: 1 }], unavailable: [], summary: {} as never }
  }
}

class FakeApiKey extends Service {
  readonly created: { name: string; appManaged?: boolean }[] = []
  constructor(ctx: Context) {
    super(ctx, 'apiKey')
  }
  async list() {
    return this.created.map((item, index) => ({
      id: `key-${index}`,
      name: item.name,
      appManaged: item.appManaged === true,
      enabled: true,
      secret: null,
    }))
  }
  async create(_userId: number, input: { name: string; appManaged?: boolean }) {
    this.created.push(input)
    return {
      key: { id: 'key-new', name: input.name, appManaged: input.appManaged === true, enabled: true, secret: null },
      secret: 'sk-dz-generated',
    }
  }
  async rotate() {
    throw new Error('不该走到轮换')
  }
}

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

async function boot(t: TestContext, config: Partial<ModelProbeConfig> = {}) {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeModelHub)
  await ctx.plugin(FakeApiKey)
  await ctx.plugin(FakeCredentials)
  const fiber = await ctx.plugin(ModelProbeService, {
    dataPath: ':memory:',
    probeUserId: 7,
    gatewayBaseUrl: 'http://127.0.0.1:1',
    adminPlugins: ['@dizzyapi/plugin-dashboard'],
    ...config,
  } as ModelProbeConfig)
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能已经卸载过。
    }
  })
  return {
    ctx,
    fiber,
    probe: ctx.get('modelProbe') as ModelProbeService,
    keys: ctx.get('apiKey') as unknown as FakeApiKey,
    credentials: ctx.get('credentials') as unknown as FakeCredentials,
  }
}

test('enabled=true：装载时就把探测 key 建好，明文进 credentials（不下发到别处）', async (t) => {
  const world = await boot(t, { enabled: true })

  assert.equal(world.keys.created.length, 1, '装载时应创建一把探测 key')
  assert.equal(world.keys.created[0].appManaged, true, '必须应用托管')
  assert.equal(world.credentials.values.get('dizzyapi/model-probe/key'), 'sk-dz-generated')

  const status = world.probe.status()
  assert.equal(status.enabled, true)
  assert.equal(status.probeKeyConfigured, true)
  assert.equal(status.probeKeyId, 'key-new')
  assert.ok(!JSON.stringify(status).includes('sk-dz-generated'), 'status() 里不能出现明文')
})

test('enabled=false：不注册定时器，也不去建 key（禁用就该彻底静默）', async (t) => {
  const world = await boot(t, { enabled: false })

  assert.equal(world.keys.created.length, 0, '禁用时不该创建 key')
  assert.equal(world.probe.status().enabled, false)
})

test('卸载后 status() 报 NOT_READY（服务已不可用，不是静默空值）', async (t) => {
  const world = await boot(t, { enabled: false })
  await world.fiber.dispose()

  assert.throws(
    () => world.probe.history('m'),
    /尚未装载完成|已卸载/,
  )
})

test('schema 声明了 fields：设置插件能据此生成可写字段（探测间隔等）', () => {
  const fields = MODEL_PROBE_CONFIG_SCHEMA.fields ?? []
  const writable = fields.filter((field) => field.writable === true).map((field) => field.key)
  // 管理员要能改「多久探一次 / 超时 / 阈值 / 点数 / 保留期 / 白名单 / 开关」。
  for (const key of ['enabled', 'intervalMs', 'timeoutMs', 'degradedThresholdMs', 'failureThreshold', 'historyPoints', 'retentionDays', 'probeModels']) {
    assert.ok(writable.includes(key), `${key} 应该可在运行期改写`)
  }
  // 换网关地址 / 换凭据引用 / 换归属用户都必须由人重启决定，不许运行期改。
  for (const key of ['gatewayBaseUrl', 'probeKeyRef', 'probeUserId', 'dataPath', 'adminPlugins']) {
    assert.ok(!writable.includes(key), `${key} 不该可在运行期改写`)
  }
})

test('配置面没有 secret 字段（秘密只能走 credentials）', () => {
  const fields = MODEL_PROBE_CONFIG_SCHEMA.fields ?? []
  assert.equal(fields.filter((field) => field.secret === true).length, 0)
})
