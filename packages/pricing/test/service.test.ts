/**
 * 价格表服务的集成用例：真实的 cordis Service + JSON 存储。
 *
 * 重点覆盖：写者白名单、快照隔离、落盘再读回、坏文件明确失败、
 * 持久化失败时内存不留下半个状态，以及 `*` 兜底。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import PricingService, {
  isPricingError,
  priceOfModel,
  type PricingConfig,
} from '../src/index.ts'

const ACTOR = '@test/actor'

interface World {
  readonly ctx: Context
  readonly service: PricingService
  readonly fiber: { dispose(): Promise<void> | void }
  readonly dir: string
  readonly path: string
}

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-pricing-'))
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

async function boot(t: TestContext, dir: string, overrides: PricingConfig = {}): Promise<World> {
  const path = overrides.dataPath ?? join(dir, 'pricing.json')
  const ctx = new Context()
  const fiber = await ctx.plugin(PricingService, {
    dataPath: path,
    adminPlugins: [ACTOR],
    ...overrides,
  })
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能已经主动卸载过。
    }
  })
  return { ctx, service: ctx.get('pricing') as PricingService, fiber, dir, path }
}

function errorCode(error: unknown): string | undefined {
  return isPricingError(error) ? error.code : undefined
}

test('set/get/list/remove：价格规范化、更新时间与复制语义', async (t) => {
  const { service } = await boot(t, await tempDir(t))

  const created = await service.set(ACTOR, '  gpt-4o  ', {
    inputPerMillion: '3.750000',
    outputPerMillion: 2,
    cacheReadPerMillion: '0.5',
  })
  assert.equal(created.model, 'gpt-4o', '模型名去首尾空白')
  assert.equal(created.inputPerMillion, '3.75')
  assert.equal(created.outputPerMillion, '2')
  assert.equal(created.cacheReadPerMillion, '0.5')
  assert.equal(created.cacheWritePerMillion, '0', '缺省缓存写按 0')
  assert.equal(created.currency, 'CNY')
  assert.ok(Number.isFinite(Date.parse(created.updatedAt)))

  assert.deepEqual(service.get('gpt-4o'), created)

  // get 返回副本：调用方改它不会污染内部状态。
  const copy = service.get('gpt-4o') as unknown as { inputPerMillion: string }
  copy.inputPerMillion = '999'
  assert.equal(service.get('gpt-4o')?.inputPerMillion, '3.75')

  await service.set(ACTOR, 'alpha', { inputPerMillion: '1', outputPerMillion: '1' })
  await service.set(ACTOR, 'gamma', { inputPerMillion: '1', outputPerMillion: '1' })
  assert.deepEqual(
    service.list().map((price) => price.model),
    ['alpha', 'gamma', 'gpt-4o'],
    '列表按模型名排序',
  )

  assert.equal(await service.remove(ACTOR, 'alpha'), true)
  assert.equal(await service.remove(ACTOR, 'alpha'), false)
  assert.equal(service.get('alpha'), null)
})

test('写者白名单：不在 adminPlugins 的 actor 一律 PRICING_FORBIDDEN，读不受限', async (t) => {
  const dir = await tempDir(t)
  const { service } = await boot(t, dir, { adminPlugins: [ACTOR] })

  await assert.rejects(
    service.set('@evil/plugin', 'gpt-4o', { inputPerMillion: '1', outputPerMillion: '1' }),
    (error) => errorCode(error) === 'PRICING_FORBIDDEN',
  )
  await assert.rejects(
    service.remove('@evil/plugin', 'gpt-4o'),
    (error) => errorCode(error) === 'PRICING_FORBIDDEN',
  )
  assert.equal(service.get('gpt-4o'), null)

  // 省略白名单 = 谁都不许写（默认拒绝），但读仍然可用。
  const locked = await boot(t, dir, { adminPlugins: [] })
  await assert.rejects(
    locked.service.set(ACTOR, 'gpt-4o', { inputPerMillion: '1', outputPerMillion: '1' }),
    (error) => errorCode(error) === 'PRICING_FORBIDDEN',
  )
  assert.deepEqual(locked.service.list(), [])
})

test('snapshot：新 Map + 冻结的条目，调用方改不动内部状态', async (t) => {
  const { service } = await boot(t, await tempDir(t))
  await service.set(ACTOR, 'alpha', { inputPerMillion: '1', outputPerMillion: '2' })

  const snapshot = service.snapshot()
  assert.equal(snapshot.size, 1)
  const entry = snapshot.get('alpha')
  assert.ok(entry !== undefined)
  assert.equal(Object.isFrozen(entry), true, '快照条目必须冻结')
  assert.throws(() => {
    ;(entry as unknown as { inputPerMillion: string }).inputPerMillion = '9'
  }, TypeError)

  // 快照不随后来的写入变化。
  await service.set(ACTOR, 'gamma', { inputPerMillion: '1', outputPerMillion: '1' })
  assert.equal(snapshot.size, 1, '旧快照看不到后来的写入')
  assert.equal(service.snapshot().size, 2)

  // 改快照这份 Map 本身不影响服务。
  ;(snapshot as Map<string, typeof entry>).set('beta', entry as NonNullable<typeof entry>)
  assert.equal(service.get('beta'), null)
})

test('JSON 落盘：文件形状稳定，重启后完整读回', async (t) => {
  const dir = await tempDir(t)
  const first = await boot(t, dir)
  const saved = await first.service.set(ACTOR, 'deepseek-ai/DeepSeek-V3', {
    inputPerMillion: '3.750000',
    outputPerMillion: '15',
    cacheReadPerMillion: '0.75',
    cacheWritePerMillion: '0',
  })

  const raw = JSON.parse(await readFile(first.path, 'utf8')) as {
    version: number
    prices: Record<string, Record<string, string>>
  }
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.prices['deepseek-ai/DeepSeek-V3'], {
    input: '3.75',
    output: '15',
    cacheRead: '0.75',
    cacheWrite: '0',
    updatedAt: saved.updatedAt,
  })

  await first.fiber.dispose()
  const second = await boot(t, dir)
  assert.deepEqual(second.service.get('deepseek-ai/DeepSeek-V3'), saved)
})

test('坏文件：装载明确失败，不带着半张表继续运行', async (t) => {
  const dir = await tempDir(t)
  const path = join(dir, 'pricing.json')

  await writeFile(path, '{ not json', 'utf8')
  const broken = new Context()
  await assert.rejects(
    async () => {
      await broken.plugin(PricingService, { dataPath: path, adminPlugins: [ACTOR] })
    },
    (error: unknown) => errorCode(error) === 'PRICING_STORE_FAILED',
  )

  await writeFile(
    path,
    JSON.stringify({ version: 1, prices: { 'gpt-4o': { input: 'not-a-price', output: '1' } } }),
    'utf8',
  )
  const invalid = new Context()
  await assert.rejects(
    async () => {
      await invalid.plugin(PricingService, { dataPath: path, adminPlugins: [ACTOR] })
    },
    (error: unknown) => errorCode(error) === 'PRICING_STORE_FAILED',
  )
})

test('dataPath 为空串：使用内存存储，进程内可读可写', async (t) => {
  const dir = await tempDir(t)
  const { service } = await boot(t, dir, { dataPath: '' })

  await service.set(ACTOR, 'memory-only', { inputPerMillion: '1.5', outputPerMillion: '2.5' })
  assert.equal(service.get('memory-only')?.inputPerMillion, '1.5')
  await assert.rejects(readFile(join(dir, 'pricing.json'), 'utf8'), /ENOENT/)
})

test('持久化失败：先落盘、成功后才替换内存，失败不留脏状态', async (t) => {
  const { service, path } = await boot(t, await tempDir(t))
  await service.set(ACTOR, 'existing', { inputPerMillion: '1', outputPerMillion: '1' })

  const internals = service as unknown as {
    store: { write(value: unknown): Promise<void> }
  }
  const originalWrite = internals.store.write
  internals.store.write = async () => {
    throw new Error('模拟磁盘写入失败')
  }
  t.after(() => {
    internals.store.write = originalWrite
  })

  await assert.rejects(
    service.set(ACTOR, 'existing', { inputPerMillion: '9', outputPerMillion: '9' }),
    (error) => errorCode(error) === 'PRICING_STORE_FAILED',
  )
  assert.equal(service.get('existing')?.inputPerMillion, '1', '写失败后内存保持旧值')

  await assert.rejects(
    service.set(ACTOR, 'brand-new', { inputPerMillion: '1', outputPerMillion: '1' }),
    (error) => errorCode(error) === 'PRICING_STORE_FAILED',
  )
  assert.equal(service.get('brand-new'), null, '写失败后不会多出一个条目')

  const raw = JSON.parse(await readFile(path, 'utf8')) as { prices: Record<string, { input: string }> }
  assert.equal(raw.prices.existing?.input, '1')
  assert.equal(raw.prices['brand-new'], undefined)
})

test('* 兜底：精确名优先，其次 *，都没有返回 0 且 priceOfModel 为 null', async (t) => {
  const { service } = await boot(t, await tempDir(t))
  await service.set(ACTOR, '*', { inputPerMillion: '2', outputPerMillion: '2' })
  await service.set(ACTOR, 'exact', { inputPerMillion: '1', outputPerMillion: '1' })

  const oneMillionInput = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  assert.equal(service.quote('exact', oneMillionInput), '1000000')
  assert.equal(service.quote('unknown-model', oneMillionInput), '2000000')

  const snapshot = service.snapshot()
  assert.equal(priceOfModel(snapshot, 'exact')?.model, 'exact')
  assert.equal(priceOfModel(snapshot, 'unknown-model')?.model, '*')

  await service.remove(ACTOR, '*')
  assert.equal(service.quote('unknown-model', oneMillionInput), '0')
  assert.equal(priceOfModel(service.snapshot(), 'unknown-model'), null)
  assert.equal(priceOfModel(service.snapshot(), 'exact')?.model, 'exact')
})

test('并发写：exclusive 队列串行化，全部条目都落盘', async (t) => {
  const { service, path } = await boot(t, await tempDir(t))

  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      service.set(ACTOR, `model-${String(index).padStart(2, '0')}`, {
        inputPerMillion: String(index),
        outputPerMillion: String(index + 1),
      }),
    ),
  )

  assert.equal(service.list().length, 20)
  const raw = JSON.parse(await readFile(path, 'utf8')) as { prices: Record<string, unknown> }
  assert.equal(Object.keys(raw.prices).length, 20)
})
