/**
 * 能力目录的集成用例：真 Loader + 三个测试夹具。
 *
 * 覆盖：
 *   - 稳定排序与 JSON 可序列化；
 *   - D5：禁用入口不出现在 `find()`，`available` 永远为 false；
 *   - 静态清单 / 模块级清单 / 没有清单三种来源；
 *   - 方法枚举（含 `_` 惯例私有）；
 *   - 配置字段只有元数据，秘密值一个字都不出现；
 *   - 存储路径：清单声明 + 字段名推导，秘密字段被拒绝。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader'
import { CatalogService, type CatalogPlugin } from '../src/index.ts'

const BASE = new URL('../', import.meta.url).href

/**
 * 补一个上游的类型缺口：`EntryTree.create` 的声明参数是 `Omit<EntryOptions, 'id'>`，
 * 但实现里 `ensureId(options)` 会原样采用传进来的 `id`（见 AGENTS.md §10）。
 */
function createEntry(
  ctx: Context,
  options: Omit<EntryOptions, 'id'> & { id?: string },
): Promise<string> {
  return ctx.loader.create(options as Omit<EntryOptions, 'id'>)
}

interface World {
  readonly ctx: Context
  readonly catalog: CatalogService
}

async function boot(): Promise<World> {
  const ctx = new Context()
  ctx.baseUrl = BASE
  await ctx.plugin(Loader)

  await createEntry(ctx, {
    id: 'alpha',
    name: './test/fixtures/fake-alpha.ts',
    config: { dataPath: './data/alpha.json', apiSecret: 'super-secret-alpha', mode: 'b' },
  })
  await createEntry(ctx, {
    id: 'beta',
    name: './test/fixtures/fake-beta.ts',
    config: { dataPath: './data/beta.json', token: 'super-secret-beta', limit: 5 },
  })
  await createEntry(ctx, {
    id: 'gamma',
    name: './test/fixtures/fake-module.ts',
    config: { dataPath: './data/gamma.json' },
  })
  await createEntry(ctx, {
    id: 'delta',
    name: './test/fixtures/fake-alpha.ts',
    config: { dataPath: './data/delta.json' },
    disabled: true,
  })
  await ctx.loader.await()

  const catalog = new CatalogService(ctx, { includeUnavailable: true })
  return { ctx, catalog }
}

function pluginOf(snapshot: { plugins: readonly CatalogPlugin[] }, id: string): CatalogPlugin {
  const plugin = snapshot.plugins.find((item) => item.id === id)
  assert.ok(plugin !== undefined, `快照里没有 ${id}`)
  return plugin
}

test('snapshot：稳定排序、计数与 JSON 可序列化', async () => {
  const { catalog } = await boot()
  const first = await catalog.snapshot()
  const second = await catalog.snapshot()

  assert.deepEqual(first.plugins.map((plugin) => plugin.id), ['alpha', 'beta', 'delta', 'gamma'])
  assert.deepEqual(
    second.plugins.map((plugin) => plugin.id),
    first.plugins.map((plugin) => plugin.id),
    '两次快照的排序必须一致',
  )
  assert.deepEqual(first.counts, { total: 4, available: 3, disabled: 1, inactive: 0, groups: 0 })
  assert.equal(typeof first.generatedAt, 'string')

  const parsed = JSON.parse(JSON.stringify(first)) as { plugins: { id: string }[] }
  assert.deepEqual(parsed.plugins.map((plugin) => plugin.id), ['alpha', 'beta', 'delta', 'gamma'])
})

test('D5：禁用入口不出现为 available，也进不了 find()', async () => {
  const { catalog } = await boot()

  const available = await catalog.find({})
  assert.deepEqual(available.map((plugin) => plugin.id), ['alpha', 'beta', 'gamma'])

  const withDisabled = await catalog.find({ includeUnavailable: true })
  assert.deepEqual(withDisabled.map((plugin) => plugin.id), ['alpha', 'beta', 'delta', 'gamma'])

  const delta = await catalog.describe('delta')
  assert.equal(delta.disabled, true)
  assert.equal(delta.available, false)
  assert.equal(delta.state, 'disabled')
  assert.deepEqual(delta.services, [])
  assert.equal(delta.config.settingsNamespace, 'delta', '被禁用的入口仍是设置插件的潜在命名空间')
  assert.equal(delta.config.writable, null, 'schema 没装载，可写性未知')

  assert.deepEqual(
    (await catalog.find({ capability: 'alpha-feature' })).map((plugin) => plugin.id),
    ['alpha'],
    '禁用的 delta 指向同一个包，但没有清单、也不该被当成能力提供者',
  )
})

test('清单：静态属性、模块级导出、以及「没有清单就标 unknown」', async () => {
  const { catalog } = await boot()

  const alpha = await catalog.describe('alpha')
  assert.equal(alpha.manifest.declared, true)
  assert.equal(alpha.manifest.source, 'plugin')
  assert.equal(alpha.manifest.version, 1)
  assert.deepEqual(alpha.events.map((event) => event.name), ['alpha/changed'])
  assert.deepEqual(alpha.bridge.map((command) => command.method), ['alpha.query'])
  assert.equal(alpha.bridge[0]?.direction, 'inbound')
  assert.deepEqual(Object.keys(alpha.dataShapes ?? {}), ['AlphaResult'])
  assert.equal(alpha.dataShapes?.AlphaResult.fields?.id.type, 'string')
  for (const capability of [
    'alpha-feature',
    'service:fakeAlpha',
    'event:alpha/changed',
    'bridge:alpha.query',
    'settings:alpha',
    'storage:dataPath',
  ]) {
    assert.ok(alpha.capabilities.includes(capability), `缺少能力 ${capability}`)
  }

  const gamma = await catalog.describe('gamma')
  assert.equal(gamma.manifest.declared, true)
  assert.equal(gamma.manifest.source, 'module')
  assert.deepEqual(gamma.events.map((event) => event.name), ['gamma/happened'])

  const beta = await catalog.describe('beta')
  assert.equal(beta.manifest.declared, false)
  assert.equal(beta.manifest.source, null)
  assert.deepEqual(beta.events, [])
  for (const facet of ['events', 'bridge', 'dataShapes']) {
    assert.ok(beta.unknown.includes(facet), `没有清单时 ${facet} 必须标 unknown`)
  }
})

test('方法枚举：名字 / 参数个数 / 惯例私有', async () => {
  const { catalog } = await boot()
  const alpha = await catalog.describe('alpha')
  const service = alpha.services.find((item) => item.name === 'fakeAlpha')
  assert.ok(service !== undefined)
  assert.deepEqual(
    service.methods.map((method) => method.name),
    ['_internal', 'ping', 'status'],
  )

  const ping = service.methods.find((method) => method.name === 'ping')
  assert.equal(ping?.arity, 2)
  assert.equal(ping?.isPrivate, false)
  assert.equal(ping?.description, 'ping 一下')

  const internal = service.methods.find((method) => method.name === '_internal')
  assert.equal(internal?.privateByConvention, true)
  assert.equal(internal?.declaredPrivate, true)
  assert.equal(internal?.isPrivate, true)

  const beta = await catalog.describe('beta')
  const betaService = beta.services.find((item) => item.name === 'fakeBeta')
  assert.equal(betaService?.methods.find((method) => method.name === 'work')?.arity, 0)
})

test('配置：只有 schema 元数据，秘密值绝不出现', async () => {
  const { catalog } = await boot()
  const snapshot = await catalog.snapshot()
  const json = JSON.stringify(snapshot)

  assert.equal(json.includes('super-secret-alpha'), false, '秘密值不许进快照')
  assert.equal(json.includes('super-secret-beta'), false, '秘密值不许进快照')

  const alpha = pluginOf(snapshot, 'alpha')
  const secret = alpha.config.fields.find((field) => field.path === 'apiSecret')
  assert.ok(secret !== undefined)
  assert.equal(secret.secret, true)
  assert.equal('value' in secret, false, '配置字段没有 value 槽位')
  assert.equal('configured' in secret, false, '目录不回答「配没配」')
  assert.equal(alpha.config.settingsNamespace, 'alpha')
  assert.equal(alpha.config.writable, true)

  const gamma = pluginOf(snapshot, 'gamma')
  assert.equal(gamma.config.fieldsKnown, true)
  assert.equal(gamma.config.writable, false, '只有不可写的 dataPath')

  const delta = pluginOf(snapshot, 'delta')
  assert.equal(delta.config.fieldsKnown, false)
  assert.ok(delta.unknown.includes('config'))
})

test('存储路径：清单声明优先，字段名可推导，秘密字段被拒绝', async () => {
  const { catalog } = await boot()
  const snapshot = await catalog.snapshot()

  const alpha = pluginOf(snapshot, 'alpha')
  const alphaStorage = new Map(alpha.storage.map((item) => [item.key, item]))
  assert.equal(alphaStorage.get('dataPath')?.path, './data/alpha.json')
  assert.equal(alphaStorage.get('dataPath')?.declared, true)
  assert.equal(alphaStorage.get('dataPath')?.kind, 'file')
  assert.equal(alphaStorage.has('apiSecret'), false, '指向秘密字段的声明必须被拒绝')
  assert.ok(alpha.unknown.includes('storage:apiSecret'))

  const beta = pluginOf(snapshot, 'beta')
  const betaStorage = beta.storage.find((item) => item.key === 'dataPath')
  assert.equal(betaStorage?.path, './data/beta.json')
  assert.equal(betaStorage?.declared, false, '没有清单时按字段名推导')
  assert.equal(betaStorage?.kind, 'file')
  assert.equal(beta.storage.some((item) => item.key === 'token'), false)
})

test('inject：解析结果与提供者 id', async () => {
  const { catalog } = await boot()
  const beta = await catalog.describe('beta')
  assert.deepEqual(beta.injects, [{ name: 'fakeAlpha', resolved: true, providerId: 'alpha' }])
})

test('find / query：能力匹配与错误码', async () => {
  const { catalog } = await boot()

  assert.deepEqual(
    (await catalog.find({ capability: 'service:fakeBeta' })).map((plugin) => plugin.id),
    ['beta'],
  )
  assert.deepEqual(
    (await catalog.find({ package: './test/fixtures/fake-module.ts' })).map((plugin) => plugin.id),
    ['gamma'],
  )

  const result = await catalog.query({ capability: 'gamma-feature' })
  assert.equal(result.count, 1)
  assert.equal(result.plugins[0]?.id, 'gamma')
  assert.equal(typeof result.generatedAt, 'string')

  await assert.rejects(catalog.describe('nope'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'CATALOG_PLUGIN_NOT_FOUND')
    return true
  })
  await assert.rejects(catalog.query({ nope: true }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'CATALOG_QUERY_INVALID')
    return true
  })
})

test('作为插件装载：默认导出、静态 Config 与 loader 注入', async () => {
  const ctx = new Context()
  ctx.baseUrl = BASE
  await ctx.plugin(Loader)
  await createEntry(ctx, {
    id: 'catalog',
    // 刻意用包名：app.yml 就是这么写的，顺带验证根 package.json 的 workspace 链接。
    name: '@dizzyapi/plugin-catalog',
    config: { includeUnavailable: false },
  })
  await ctx.loader.await()

  const impl = ctx.root.reflect._getImpl('catalog', false)
  assert.ok(impl !== undefined, 'loader 应该把 catalog 服务提供出来')
  const catalog = impl.value as CatalogService
  const snapshot = await catalog.snapshot()
  const self = snapshot.plugins.find((plugin) => plugin.id === 'catalog')
  assert.ok(self !== undefined)
  assert.equal(self.available, true)
  assert.equal(self.manifest.declared, true)
  assert.equal(self.manifest.source, 'plugin')
  assert.ok(self.capabilities.includes('plugin-catalog'))
})
