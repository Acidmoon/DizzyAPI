/**
 * `modelhub` 消费 `modelProbe` 的集成护栏（真 cordis 上下文 + 假探测服务）。
 *
 * 三条不变量：
 * 1. **判定权归 modelhub**：阈值是 modelhub 的 `probeFailureThreshold`，不是探测插件的；
 * 2. **形状向后兼容**：没接探测服务时，目录一个字节都不变（`probe` 键根本不出现）；
 * 3. **停摆不判死**：探测 `blockedReason` 非空时全部 `unknown`，绝不 `down`。
 */
import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { Context } from 'cordis'
import ModelHubService, { type ModelCatalog, type ModelHubConfig } from '../src/index.ts'

const PRICE_TIME = '2026-10-19T00:00:00.000Z'

function priceOf(model: string) {
  return {
    model,
    inputPerMillion: '2',
    outputPerMillion: '8',
    cacheReadPerMillion: '0.5',
    cacheWritePerMillion: '0',
    currency: 'CNY',
    updatedAt: PRICE_TIME,
  }
}

function accountOf(models: readonly string[]) {
  return {
    enabled: true,
    status: 'active',
    protocol: 'openai-chat',
    models,
    modelMap: null,
    health: 'healthy',
    credentialConfigured: true,
    accessExpiresAt: null,
  }
}

interface ProbePoint {
  status: string
  latencyMs: number
  httpStatus: number | null
  errorCode: string | null
  testedAtMs: number
}

function point(status: string, testedAtMs = 1_000): ProbePoint {
  return {
    status,
    latencyMs: status === 'probe-error' ? 0 : 120,
    httpStatus: null,
    errorCode: status === 'failed' ? 'MODEL_NOT_SERVED' : null,
    testedAtMs,
  }
}

interface ProbeHistory {
  model: string
  points: ProbePoint[]
  consecutiveFailures: number
  lastOkAtMs: number | null
  lastTestedAtMs: number | null
}

function historyOf(model: string, points: ProbePoint[], consecutiveFailures = 0): ProbeHistory {
  return {
    model,
    points,
    consecutiveFailures,
    lastOkAtMs: points.some((item) => item.status === 'ok') ? points[0].testedAtMs : null,
    lastTestedAtMs: points[0]?.testedAtMs ?? null,
  }
}

interface ProbeOptions {
  readonly histories?: readonly ProbeHistory[]
  readonly enabled?: boolean
  readonly blockedReason?: string | null
  readonly blockedDetail?: string | null
  readonly probeKeyConfigured?: boolean
}

interface BootOptions {
  readonly models?: readonly string[]
  readonly config?: ModelHubConfig
  /** 不给这个就模拟「探测服务不在运行」。 */
  readonly probe?: ProbeOptions
}

async function boot(t: TestContext, options: BootOptions = {}) {
  const ctx = new Context()
  const models = options.models ?? ['deepseek-chat']
  ctx.provide('pricing', { list: () => models.map(priceOf) })
  ctx.provide('accountAdmin', { list: () => models.map((model) => accountOf([model])) })
  if (options.probe !== undefined) {
    const probe = options.probe
    ctx.provide('modelProbe', {
      histories: () => probe.histories ?? [],
      status: () => ({
        enabled: probe.enabled ?? true,
        running: false,
        probeKeyConfigured: probe.probeKeyConfigured ?? true,
        blockedReason: probe.blockedReason ?? null,
        blockedDetail: probe.blockedDetail ?? null,
        lastPassAt: '2026-10-31T00:00:00.000Z',
      }),
    })
  }
  const fiber = await ctx.plugin(ModelHubService, options.config ?? {})
  const service = ctx.get('modelhub') as ModelHubService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 已卸载。
    }
  })
  return service
}

function catalogOf(service: ModelHubService): ModelCatalog {
  return service.catalog({})
}

test('【兼容护栏】没接探测服务时，条目里没有 probe 键、目录也没有 probe 汇总', async (t) => {
  const service = await boot(t)
  const catalog = catalogOf(service)

  assert.equal(catalog.available.length, 1)
  assert.equal('probe' in catalog.available[0], false, '没探测数据时不该出现 probe 键')
  // 探测插件缺席时汇总仍有一份「禁用」的说明，但条目上没有任何探测数据。
  assert.equal(catalog.probe.enabled, false)
  assert.equal(catalog.probe.downCount, 0)
  assert.equal(catalog.probe.blockedReason, null)
})

test('接了探测服务且有历史 → 条目带 probe（含点与健康度）', async (t) => {
  const service = await boot(t, {
    probe: {
      histories: [historyOf('deepseek-chat', [point('ok', 300), point('degraded', 200), point('ok', 100)])],
    },
  })
  const entry = catalogOf(service).available[0]

  assert.ok(entry.probe !== undefined)
  assert.equal(entry.probe.health, 'up')
  assert.equal(entry.probe.probed, true)
  assert.equal(entry.probe.points.length, 3)
  assert.deepEqual(
    entry.probe.points.map((item) => item.status),
    ['ok', 'degraded', 'ok'],
    '最新在前，前端自己决定怎么摆',
  )
})

test('【判定权护栏】阈值用 modelhub 的配置：改 probeFailureThreshold 结论就变', async (t) => {
  const histories = [
    historyOf('deepseek-chat', [point('failed', 300), point('failed', 200)], 2),
  ]

  const strict = await boot(t, { probe: { histories }, config: { probeFailureThreshold: 2 } })
  assert.equal(catalogOf(strict).available[0].probe?.health, 'down')

  const loose = await boot(t, { probe: { histories }, config: { probeFailureThreshold: 5 } })
  assert.equal(catalogOf(loose).available[0].probe?.health, 'degraded')
})

test('【停摆护栏】blockedReason 非空 → 全部 unknown，且汇总带出原因与说明', async (t) => {
  const service = await boot(t, {
    probe: {
      histories: [historyOf('deepseek-chat', [point('failed', 300)], 9)],
      blockedReason: 'probe_user_balance_exhausted',
      blockedDetail: '探测用户 #1 余额不足（402 INSUFFICIENT_BALANCE），探测已停摆；这不是模型故障',
    },
  })
  const catalog = catalogOf(service)

  assert.equal(catalog.available[0].probe?.health, 'unknown', '停摆时不能判死')
  assert.equal(catalog.probe.blockedReason, 'probe_user_balance_exhausted')
  assert.match(catalog.probe.blockedDetail ?? '', /这不是模型故障/)
  assert.equal(catalog.probe.downCount, 0)
})

test('汇总：downCount 只数被判 down 的模型，failureThreshold 原样透出', async (t) => {
  const service = await boot(t, {
    models: ['good', 'bad'],
    config: { probeFailureThreshold: 2 },
    probe: {
      histories: [
        historyOf('good', [point('ok', 300)]),
        historyOf('bad', [point('failed', 300), point('failed', 200)], 2),
      ],
    },
  })
  const catalog = catalogOf(service)

  assert.equal(catalog.probe.enabled, true)
  assert.equal(catalog.probe.failureThreshold, 2)
  assert.equal(catalog.probe.downCount, 1)
  const bad = catalog.available.find((entry) => entry.model === 'bad')
  assert.equal(bad?.probe?.health, 'down')
})

test('不可用的模型也带 probe（便于排障：账号不健康 + 探测也挂）', async (t) => {
  const ctx = new Context()
  ctx.provide('pricing', { list: () => [] })
  // 账号声明了模型但已停用 → 进 unavailable。
  ctx.provide('accountAdmin', {
    list: () => [{ ...accountOf(['ghost']), enabled: false }],
  })
  ctx.provide('modelProbe', {
    histories: () => [historyOf('ghost', [point('failed', 300)], 5)],
    status: () => ({
      enabled: true,
      running: false,
      probeKeyConfigured: true,
      blockedReason: null,
      blockedDetail: null,
      lastPassAt: null,
    }),
  })
  const fiber = await ctx.plugin(ModelHubService, { probeFailureThreshold: 3 })
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 已卸载。
    }
  })

  const service = ctx.get('modelhub') as ModelHubService
  const catalog = service.catalog({})
  const ghost = catalog.unavailable.find((entry) => entry.model === 'ghost')
  assert.ok(ghost !== undefined)
  assert.equal(ghost.probe?.health, 'down', '两条独立证据都要能看到')
})

test('探测被禁用：不读历史，但汇总说明 enabled=false', async (t) => {
  const service = await boot(t, {
    probe: { enabled: false, histories: [historyOf('deepseek-chat', [point('ok', 300)])] },
  })
  const catalog = catalogOf(service)

  assert.equal('probe' in catalog.available[0], false, '禁用时不该有探测数据')
  assert.equal(catalog.probe.enabled, false)
})

test('探测服务抛错：目录照常出，探测字段降级（不把广场打成 5xx）', async (t) => {
  const ctx = new Context()
  ctx.provide('pricing', { list: () => [priceOf('deepseek-chat')] })
  ctx.provide('accountAdmin', { list: () => [accountOf(['deepseek-chat'])] })
  ctx.provide('modelProbe', {
    histories: () => {
      throw new Error('boom')
    },
    status: () => {
      throw new Error('boom')
    },
  })
  const fiber = await ctx.plugin(ModelHubService, {})
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 已卸载。
    }
  })

  const service = ctx.get('modelhub') as ModelHubService
  const catalog = service.catalog({})
  assert.equal(catalog.available.length, 1, '目录必须照常出')
  assert.equal('probe' in catalog.available[0], false)
  assert.equal(catalog.probe.enabled, false)
})
