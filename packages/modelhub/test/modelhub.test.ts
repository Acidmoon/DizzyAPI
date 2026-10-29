/**
 * 模型广场插件的测试。
 *
 * 覆盖：价格 + 账号覆盖度聚合、可用性口径（停用 / 凭据 / 过期 / 健康）、
 * 不可用原因、兜底价 `'*'` 不算模型、过滤与统计口径、查询参数校验、
 * 配置非法明确失败、依赖服务缺席时降级不抛错、以及**不泄漏账号信息**。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import ModelHubService, {
  ModelHubError,
  validateModelHubConfig,
  type ModelCatalog,
  type ModelHubConfig,
} from '../src/index.ts'

interface PriceFake {
  readonly model: string
  readonly inputPerMillion: string
  readonly outputPerMillion: string
  readonly cacheReadPerMillion: string
  readonly cacheWritePerMillion: string
  readonly currency: string
  readonly updatedAt: string
}

interface AccountFake {
  readonly enabled: boolean
  readonly status: string
  readonly protocol?: string | null
  readonly models?: readonly string[] | null
  readonly modelMap?: Readonly<Record<string, string>> | null
  readonly health?: string | null
  readonly credentialConfigured?: boolean
  readonly accessExpiresAt?: string | null
}

const PRICE_TIME = '2026-10-19T00:00:00.000Z'

function priceOf(model: string, patch: Partial<PriceFake> = {}): PriceFake {
  return {
    model,
    inputPerMillion: '2',
    outputPerMillion: '8',
    cacheReadPerMillion: '0.5',
    cacheWritePerMillion: '0',
    currency: 'CNY',
    updatedAt: PRICE_TIME,
    ...patch,
  }
}

function accountOf(patch: Partial<AccountFake> = {}): AccountFake {
  return {
    enabled: true,
    status: 'active',
    protocol: 'openai-chat',
    models: [],
    modelMap: null,
    health: 'healthy',
    credentialConfigured: true,
    accessExpiresAt: null,
    ...patch,
  }
}

interface World {
  readonly ctx: Context
  readonly service: ModelHubService
  readonly dispose: () => Promise<void>
}

interface BootOptions {
  readonly prices?: readonly PriceFake[]
  readonly accounts?: readonly AccountFake[]
  readonly config?: ModelHubConfig
  /** 模拟 pricing 不在运行（没有提供 pricing 服务）。 */
  readonly withoutPricing?: boolean
  /** 模拟 accountAdmin 不在运行。 */
  readonly withoutAccounts?: boolean
  /** 让 pricing.list() 抛错，验证目录降级不炸。 */
  readonly pricingThrows?: boolean
}

async function boot(t: TestContext, options: BootOptions = {}): Promise<World> {
  const ctx = new Context()
  if (options.withoutPricing !== true) {
    ctx.provide('pricing', {
      list() {
        if (options.pricingThrows === true) throw new Error('价格表炸了')
        return options.prices ?? []
      },
    })
  }
  if (options.withoutAccounts !== true) {
    ctx.provide('accountAdmin', {
      list() {
        return options.accounts ?? []
      },
    })
  }
  const fiber = await ctx.plugin(ModelHubService, options.config ?? {})
  const service = ctx.get('modelhub') as ModelHubService
  const dispose = async (): Promise<void> => {
    await fiber.dispose()
  }
  t.after(async () => {
    try {
      await dispose()
    } catch {
      // fiber.dispose() 返回 void；测试清理忽略异常。
    }
  })
  return { ctx, service, dispose }
}

function catalogOf(service: ModelHubService, query = {}): ModelCatalog {
  return service.catalog(query)
}

// ───────────────────────────────── 聚合 ─────────────────────────────────

test('聚合：价格 + 账号覆盖度（协议 / 上游名 / 计数）', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('deepseek-chat', { inputPerMillion: '0.5', outputPerMillion: '2' })],
    accounts: [
      accountOf({ models: ['deepseek-chat'], protocol: 'openai-chat', modelMap: { 'deepseek-chat': 'up-chat-1' } }),
      accountOf({ models: ['deepseek-chat'], protocol: 'openai-responses' }),
      accountOf({ models: ['deepseek-chat'], protocol: 'openai-chat', health: 'unknown' }),
      // 没有声明这个模型的账号不计入覆盖度。
      accountOf({ models: ['other-model'], protocol: 'anthropic' }),
    ],
  })

  const catalog = catalogOf(service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model),
    ['deepseek-chat', 'other-model'],
  )

  const chat = catalog.available.find((entry) => entry.model === 'deepseek-chat')
  assert.ok(chat !== undefined)
  assert.equal(chat.priced, true)
  assert.equal(chat.price?.inputPerMillion, '0.5')
  assert.equal(chat.price?.outputPerMillion, '2')
  assert.equal(chat.price?.currency, 'CNY')
  assert.equal(chat.accountCount, 3)
  assert.equal(chat.healthyAccountCount, 3)
  assert.deepEqual(chat.protocols, ['openai-chat', 'openai-responses'])
  assert.deepEqual(chat.upstreamModels, ['up-chat-1'])
  assert.equal(chat.mapped, true)

  // 没配价的模型：priced=false 且 price=null，但照样列出来（默认 includeUnpriced）。
  const other = catalog.available.find((entry) => entry.model === 'other-model')
  assert.ok(other !== undefined)
  assert.equal(other.priced, false)
  assert.equal(other.price, null)
  assert.deepEqual(other.protocols, ['anthropic'])
  assert.deepEqual(other.upstreamModels, [])
  assert.equal(other.mapped, false)
})

test('不可用：有价但没人提供带 no_account 原因', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('ghost-model')],
    accounts: [accountOf({ models: ['real-model'] })],
  })

  const catalog = catalogOf(service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model),
    ['real-model'],
  )
  assert.deepEqual(catalog.unavailable, [
    {
      model: 'ghost-model',
      reason: 'no_account',
      detail: '还没有账号声明提供这个模型',
      accountCount: 0,
      price: {
        inputPerMillion: '2',
        outputPerMillion: '8',
        cacheReadPerMillion: '0.5',
        cacheWritePerMillion: '0',
        currency: 'CNY',
        updatedAt: PRICE_TIME,
      },
      priced: true,
    },
  ])
})

test('不可用：账号都在但全不健康带 no_healthy_account 原因', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('sick-model')],
    accounts: [
      accountOf({ models: ['sick-model'], health: 'unhealthy' }),
      accountOf({ models: ['sick-model'], enabled: false }),
    ],
  })

  const catalog = catalogOf(service)
  assert.equal(catalog.available.length, 0)
  assert.equal(catalog.unavailable.length, 1)
  const entry = catalog.unavailable[0]
  assert.ok(entry !== undefined)
  assert.equal(entry.model, 'sick-model')
  assert.equal(entry.reason, 'no_healthy_account')
  assert.equal(entry.accountCount, 2)
  assert.equal(entry.priced, true)
})

test('可用性口径：停用 / 非 active / unhealthy / 凭据缺失 / 令牌过期都不算健康', async (t) => {
  const { service } = await boot(t, {
    accounts: [
      accountOf({ models: ['m-disabled'], enabled: false }),
      accountOf({ models: ['m-needsreauth'], status: 'needs_reauth' }),
      accountOf({ models: ['m-autodisabled'], status: 'auto_disabled' }),
      accountOf({ models: ['m-unhealthy'], health: 'unhealthy' }),
      accountOf({ models: ['m-nocred'], credentialConfigured: false }),
      accountOf({ models: ['m-expired'], accessExpiresAt: '2020-01-01T00:00:00.000Z' }),
      // 未知健康与 degraded 仍然算可用（与 Go 侧 exclude_unhealthy 口径一致）。
      accountOf({ models: ['m-unknown'], health: 'unknown' }),
      accountOf({ models: ['m-degraded'], health: 'degraded' }),
    ],
  })

  const catalog = catalogOf(service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model).sort(),
    ['m-degraded', 'm-unknown'],
  )
  assert.deepEqual(
    catalog.unavailable.map((entry) => entry.model).sort(),
    ['m-autodisabled', 'm-disabled', 'm-expired', 'm-needsreauth', 'm-nocred', 'm-unhealthy'],
  )
  for (const entry of catalog.unavailable) {
    assert.equal(entry.reason, 'no_healthy_account', `${entry.model} 的原因`)
  }
})

test('兜底价 *：没精确价的模型显示兜底价但 priced=false，且 * 本身不列成模型', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('*', { inputPerMillion: '9' }), priceOf('priced-model', { inputPerMillion: '3' })],
    accounts: [accountOf({ models: ['priced-model', 'unpriced-model'] })],
  })

  const catalog = catalogOf(service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model).sort(),
    ['priced-model', 'unpriced-model'],
  )
  assert.ok(!catalog.available.some((entry) => entry.model === '*'), '* 不能当成模型列出来')

  const unpriced = catalog.available.find((entry) => entry.model === 'unpriced-model')
  assert.ok(unpriced !== undefined)
  assert.equal(unpriced.priced, false, '按兜底价计价不等于这个模型自己配了价')
  assert.equal(unpriced.price?.inputPerMillion, '9', '但展示兜底价，别让用户以为免费')
})

test('includeUnpriced=false：未定价的模型隐藏，有价的照常列出', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('priced-model')],
    accounts: [accountOf({ models: ['priced-model', 'unpriced-model'] })],
    config: { includeUnpriced: false },
  })
  const catalog = catalogOf(service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model),
    ['priced-model'],
  )
  assert.equal(catalog.unavailable.length, 0)
  assert.equal(catalog.summary.total, 1)
})

// ───────────────────────────────── 过滤与统计 ─────────────────────────────────

test('过滤：按名字（大小写不敏感）、可用性、是否定价', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('DeepSeek-Chat'), priceOf('ghost')],
    accounts: [accountOf({ models: ['DeepSeek-Chat', 'cheap-model'] })],
  })

  const byName = catalogOf(service, { search: 'deepseek' })
  assert.deepEqual(
    byName.available.map((entry) => entry.model),
    ['DeepSeek-Chat'],
  )
  assert.equal(byName.unavailable.length, 0)
  assert.equal(byName.summary.total, 1)

  const onlyAvailable = catalogOf(service, { availability: 'available' })
  assert.equal(onlyAvailable.unavailable.length, 0)
  assert.deepEqual(
    onlyAvailable.available.map((entry) => entry.model).sort(),
    ['DeepSeek-Chat', 'cheap-model'],
  )

  const onlyUnavailable = catalogOf(service, { availability: 'unavailable' })
  assert.equal(onlyUnavailable.available.length, 0)
  assert.deepEqual(
    onlyUnavailable.unavailable.map((entry) => entry.model),
    ['ghost'],
  )

  const onlyPriced = catalogOf(service, { priced: 'priced' })
  assert.deepEqual(
    onlyPriced.available.map((entry) => entry.model),
    ['DeepSeek-Chat'],
  )
  assert.equal(onlyPriced.unavailable.length, 1)

  const onlyUnpriced = catalogOf(service, { priced: 'unpriced' })
  assert.deepEqual(
    onlyUnpriced.available.map((entry) => entry.model),
    ['cheap-model'],
  )
  assert.equal(onlyUnpriced.unavailable.length, 0)
})

test('统计口径：跟随过滤结果，账号数是被读到的账号总数', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('a'), priceOf('b')],
    accounts: [accountOf({ models: ['a'] }), accountOf({ models: [] }), accountOf({ models: null })],
  })

  const all = catalogOf(service)
  assert.deepEqual(all.summary, {
    total: 2,
    availableCount: 1,
    unavailableCount: 1,
    pricedCount: 2,
    accountCount: 3,
  })

  const filtered = catalogOf(service, { availability: 'available' })
  assert.deepEqual(filtered.summary, {
    total: 1,
    availableCount: 1,
    unavailableCount: 0,
    pricedCount: 1,
    accountCount: 3,
  })
})

// ───────────────────────────────── 校验与降级 ─────────────────────────────────

test('查询参数不合法：明确抛 MODELHUB_QUERY_INVALID', async (t) => {
  const { service } = await boot(t)
  for (const query of [
    { availability: 'maybe' },
    { priced: 'cheap' },
    { search: 42 },
  ] as unknown as Record<string, unknown>[]) {
    assert.throws(
      () => service.catalog(query),
      (error: unknown) => error instanceof ModelHubError && error.code === 'MODELHUB_QUERY_INVALID',
      JSON.stringify(query),
    )
  }
})

test('配置非法：非布尔的 includeUnpriced / 未知字段都明确失败', async () => {
  const issues = validateModelHubConfig({ includeUnpriced: 'yes' })
  assert.ok(Array.isArray(issues) && issues.length > 0)
  assert.ok(Array.isArray(validateModelHubConfig({ nope: 1 })))
  assert.ok(!Array.isArray(validateModelHubConfig({ includeUnpriced: false })))

  const ctx = new Context()
  let failure: unknown
  try {
    await ctx.plugin(ModelHubService, { includeUnpriced: 'yes' } as unknown as ModelHubConfig)
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error, '非法配置必须让插件装载失败')
  assert.equal(ctx.get('modelhub', false), undefined)
})

test('依赖缺席：没有 pricing / accountAdmin 时降级，不抛错', async (t) => {
  const noPricing = await boot(t, {
    withoutPricing: true,
    accounts: [accountOf({ models: ['orphan-model'] })],
  })
  const catalog = catalogOf(noPricing.service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model),
    ['orphan-model'],
  )
  assert.equal(catalog.available[0]?.priced, false)
  assert.equal(catalog.available[0]?.price, null)

  const noAccounts = await boot(t, {
    withoutAccounts: true,
    prices: [priceOf('priced-but-orphan')],
  })
  const second = catalogOf(noAccounts.service)
  assert.equal(second.available.length, 0)
  assert.deepEqual(
    second.unavailable.map((entry) => entry.model),
    ['priced-but-orphan'],
  )
  assert.equal(second.summary.accountCount, 0)
})

test('价格表读取失败：目录降级为无价，不把异常抛给调用方', async (t) => {
  const { service } = await boot(t, {
    pricingThrows: true,
    accounts: [accountOf({ models: ['a-model'] })],
  })
  const catalog = catalogOf(service)
  assert.deepEqual(
    catalog.available.map((entry) => entry.model),
    ['a-model'],
  )
  assert.equal(catalog.available[0]?.priced, false)
})

// ───────────────────────────────── 秘密与回收 ─────────────────────────────────

test('不泄漏：结果里没有账号 id / label / baseUrl / 凭据字段', async (t) => {
  const { service } = await boot(t, {
    prices: [priceOf('secret-model')],
    accounts: [
      {
        ...accountOf({ models: ['secret-model'] }),
        // 故意塞进这些字段：它们**不能**出现在目录结果里。
        id: 'acc-secret-1',
        label: '生产主账号（勿动）',
        baseUrl: 'https://user:pass@upstream.example/v1',
        credentialRef: 'dizzyapi/prod-key',
      } as unknown as AccountFake,
    ],
  })

  const text = JSON.stringify(catalogOf(service))
  for (const secret of ['acc-secret-1', '生产主账号', 'upstream.example', 'dizzyapi/prod-key', 'user:pass']) {
    assert.ok(!text.includes(secret), `目录结果里出现了 ${secret}`)
  }
})

test('卸载：插件回收后服务不可再用（没有定时器 / 连接残留）', async (t) => {
  const world = await boot(t, { prices: [priceOf('a')] })
  assert.ok(catalogOf(world.service).summary.total >= 0)
  await world.dispose()
  assert.equal(world.ctx.get('modelhub', false), undefined)
})
