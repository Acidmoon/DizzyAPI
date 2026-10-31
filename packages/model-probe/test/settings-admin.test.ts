/**
 * **管理员能不能在设置页改模型探测** —— 批 3 的第 4 条验收项。
 *
 * `总工` 的原话：「可调项已经是 `writable: true`，所以 `/dashboard/settings` 的
 * `model-probe` 命名空间应该直接能改。**你只需要确认它真的出现在设置页并且能改**」。
 *
 * 光读代码不算确认：设置页的命名空间来自**插件树里的 entry**，
 * 字段来自 `fiber.runtime.Config.fields`（`packages/settings/src/discover.ts`）。
 * 只要那个 fiber 是 PENDING / 没装 Config / 没声明 fields，命名空间就会静默消失，
 * 页面上一片空白 —— 而这在源码里完全看不出来。所以这里用**真 Loader + 真插件树**验：
 *
 * 1. 命名空间在 `describe()` 里出现，且 `writable: true`；
 * 2. 9 个「管理员该调的」字段都可写（间隔 / 超时 / 慢阈值 / 并发 / 阈值 / 点数 / 保留期 / 开关 / 白名单）；
 * 3. 5 个「不该让管理员在页面上改的」字段**只读**（探测库路径 / 目标网关 / key 引用名 /
 *    归属用户 / 授权插件）—— 改网关等于让探测打到别的服务上，改归属用户等于花别人的钱，
 *    改 key 引用名等于指向另一个凭据，三条都是提权面；
 * 4. 改一个真字段 → 插件软重启 → 新实例拿到新配置；
 * 5. 非法值 / 只读字段 → **明确报错**，不静默降级（AGENTS.md §2.4.5）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from 'cordis'
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader'

import SettingsService, { type SettingsNamespaceView } from '../../settings/src/index.ts'
import type { ModelProbeService } from '../src/index.ts'

/** 生产上真正改设置的那个 actor（`packages/api/src/constants.ts` 的 `API_ACTOR`）。 */
const ACTOR = '@dizzyapi/plugin-api'

/** 补上游类型缺口：`create` 的声明参数没有 `id`，但实现会原样采用传进来的 id。 */
function createEntry(ctx: Context, options: Omit<EntryOptions, 'id'> & { id?: string }): Promise<string> {
  return ctx.loader.create(options as Omit<EntryOptions, 'id'>)
}

interface World {
  readonly ctx: Context
  readonly settings: SettingsService
  readonly dir: string
}

/**
 * 起一棵最小的真插件树：`model-probe` + `settings`。
 *
 * `enabled: false` 是刻意的：这条用例验的是**配置面**，不是探测执行；关掉定时器
 * 就不用给测试进程留一个永远在跑的 interval（node:test 会因此不退出）。
 */
async function boot(): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'model-probe-settings-'))
  const ctx = new Context()
  await ctx.plugin(Loader)
  // **必须先有 timer**：`modelProbe` 的 inject 是 `['timer']`，缺了它 fiber 停在 PENDING。
  // 那时设置页仍然列出命名空间（`runtime.Config` 已经解析出来了），但每次写都会报
  // `SETTINGS_TARGET_INACTIVE` —— 「看得见、改不动」，正是这条用例要防的那种状态。
  await createEntry(ctx, { id: 'timer', name: '@cordisjs/plugin-timer' })
  await createEntry(ctx, {
    id: 'model-probe',
    name: '@dizzyapi/plugin-model-probe',
    config: {
      dataPath: join(dir, 'model-probe.db'),
      probeUserId: 1,
      enabled: false,
    },
  })
  await createEntry(ctx, {
    id: 'settings',
    name: '@dizzyapi/plugin-settings',
    config: { dataPath: join(dir, 'settings.json'), adminPlugins: [ACTOR] },
  })
  await ctx.loader.await()
  const settings = ctx.get('settings') as SettingsService | undefined
  assert.ok(settings !== undefined, '设置插件没起来')
  return { ctx, settings, dir }
}

function namespaceOf(list: readonly SettingsNamespaceView[], ns: string): SettingsNamespaceView {
  const found = list.find((item) => item.ns === ns)
  assert.ok(found !== undefined, `设置清单里没有 ${ns}（有：${list.map((item) => item.ns).join(' / ')}）`)
  return found
}

function fieldOf(view: SettingsNamespaceView, path: string): SettingsNamespaceView['fields'][number] {
  const found = view.fields.find((field) => field.path === path)
  assert.ok(found !== undefined, `没有字段 ${path}（有：${view.fields.map((item) => item.path).join(' / ')}）`)
  return found
}

async function assertCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    return true
  })
}

/**
 * 拆树 + 删临时目录。
 *
 * **必须先 dispose**：`model-probe` 在 `[Service.init]` 里打开了 SQLite，句柄由
 * `ctx.effect` 的回收器关闭；不 dispose 就直接删目录，Windows 会报 EBUSY（连 `-wal` / `-shm`
 * 都删不掉）。顺带保证测试进程里不留活 fiber。
 */
async function teardown(ctx: Context, dir: string): Promise<void> {
  await ctx.fiber.dispose()
  await rm(dir, { recursive: true, force: true })
}

/** 管理员该能改的 9 项（`config.ts` 的 `fields`）。 */
const WRITABLE = [
  'enabled',
  'intervalMs',
  'timeoutMs',
  'degradedThresholdMs',
  'maxConcurrent',
  'failureThreshold',
  'historyPoints',
  'retentionDays',
  'probeModels',
] as const

/** 页面上**不许**改的 5 项（改它们要重新部署，不是点两下的事）。 */
const READ_ONLY = ['dataPath', 'gatewayBaseUrl', 'probeKeyRef', 'probeUserId', 'adminPlugins'] as const

test('设置页能看到 model-probe 命名空间', async (t) => {
  const { ctx, settings, dir } = await boot()
  t.after(() => teardown(ctx, dir))

  const view = namespaceOf(await settings.describe(), 'model-probe')
  assert.equal(view.plugin, '@dizzyapi/plugin-model-probe')
  assert.equal(view.active, true, '插件 fiber 不是 active：命名空间就是从这里来的')
  assert.equal(view.disabled, false)
  assert.equal(view.writable, true, '一个可写字段都没有的话，页面只会显示「没有可改字段」')
  assert.equal(view.overridden, false)
  assert.equal(view.revision, null)
})

test('9 个可调项都能改，5 个危险项只读', async (t) => {
  const { ctx, settings, dir } = await boot()
  t.after(() => teardown(ctx, dir))

  const view = namespaceOf(await settings.describe(), 'model-probe')
  for (const path of WRITABLE) {
    const field = fieldOf(view, path)
    assert.equal(field.writable, true, `${path} 应该可写`)
    assert.equal(field.secret, false, `${path} 不是秘密`)
  }
  for (const path of READ_ONLY) {
    assert.equal(fieldOf(view, path).writable, false, `${path} 必须只读`)
  }

  // 数字字段要把上下界带给页面（表单据此做就地校验，不靠服务端兜底）。
  assert.equal(fieldOf(view, 'intervalMs').min, 10_000)
  assert.equal(fieldOf(view, 'intervalMs').max, 3_600_000)
  assert.equal(fieldOf(view, 'probeModels').kind, 'stringArray')
})

test('改探测间隔：插件软重启，新实例拿到新配置', async (t) => {
  const { ctx, settings, dir } = await boot()
  t.after(() => teardown(ctx, dir))

  const before = ctx.get('modelProbe') as ModelProbeService
  assert.equal(before.config.intervalMs, 300_000, '基线是 app.yml 的默认值')

  const updated = await settings.update(ACTOR, 'model-probe', { intervalMs: 60_000 })
  assert.equal(updated.overridden, true)
  assert.ok(updated.revision !== null, '写完之后必须有覆盖指纹（乐观锁用）')

  const after = ctx.get('modelProbe') as ModelProbeService
  assert.notEqual(after, before, '设置写完要软重启，不能改一个没人读的覆盖文件')
  assert.equal(after.config.intervalMs, 60_000)
  assert.equal(fieldOf(updated, 'intervalMs').value, 60_000, '页面回读时看到的是覆盖后的值')
})

test('非法值明确失败，不静默降级', async (t) => {
  const { ctx, settings, dir } = await boot()
  t.after(() => teardown(ctx, dir))

  // 低于下限（10s）：探测插件自己的 schema 必须拒绝，设置插件把它翻成 SETTINGS_VALUE_INVALID。
  await assertCode(settings.update(ACTOR, 'model-probe', { intervalMs: 5_000 }), 'SETTINGS_VALUE_INVALID')
  // 只读字段：探测目标网关不能让管理员在页面上改成别的服务。
  await assertCode(
    settings.update(ACTOR, 'model-probe', { gatewayBaseUrl: 'http://example.com' }),
    'SETTINGS_FIELD_NOT_WRITABLE',
  )
  // 失败之后基线没被改脏。
  const view = namespaceOf(await settings.describe(), 'model-probe')
  assert.equal(view.overridden, false)
  assert.equal(fieldOf(view, 'intervalMs').value ?? 300_000, 300_000)
})
