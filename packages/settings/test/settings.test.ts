/**
 * 设置插件的集成用例：真 Loader + 真插件树。
 *
 * 这里必须用真 loader：设置插件的命名空间就是插件树里的 entry，
 * 光 `ctx.plugin(X)` 造不出 entry 来。
 *
 * 顺带跑了 mailer 的假 SMTP 辅助文件（跨包相对路径），为的是验证
 * 「改完 SMTP 配置真的能发出去」，而不只是「配置对象看着变了」。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader'
import MailerService from '@dizzyapi/plugin-mailer'
import SettingsService, { type SettingsConfig, type SettingsNamespaceView } from '../src/index.ts'
import { startFakeSmtp } from '../../mailer/test/fake-smtp.ts'

const ACTOR = 'test/actor'

/**
 * 补一个上游的类型缺口：`EntryTree.create` 的声明参数是 `Omit<EntryOptions, 'id'>`，
 * 但实现里 `ensureId(options)` 会**原样采用**传进来的 `id`（没有才随机生成）。
 * app.yml 的 entry 全都带显式 id，而设置插件的命名空间正是这个 id，所以测试必须能指定它。
 */
function createEntry(ctx: Context, options: Omit<EntryOptions, 'id'> & { id?: string }): Promise<string> {
  return ctx.loader.create(options as Omit<EntryOptions, 'id'>)
}

interface World {
  readonly ctx: Context
  readonly settings: SettingsService
  readonly dataPath: string | undefined
}

async function boot(options: { settings?: SettingsConfig; mailer?: Record<string, unknown> } = {}): Promise<World> {
  const dataPath = options.settings?.dataPath
  const ctx = new Context()
  await ctx.plugin(Loader)
  await createEntry(ctx, {
    id: 'mailer',
    name: '@dizzyapi/plugin-mailer',
    config: options.mailer ?? { transport: 'log' },
  })
  await createEntry(ctx, {
    id: 'settings',
    name: '@dizzyapi/plugin-settings',
    config: { adminPlugins: [ACTOR], ...options.settings },
  })
  await ctx.loader.await()
  return { ctx, settings: ctx.get('settings') as SettingsService, dataPath }
}

function mailerOf(ctx: Context): MailerService {
  return ctx.get('mailer') as MailerService
}

/** 等到条件成立为止——启动重放走的是微任务，测试里不去猜它跑完没有。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.ok(predicate(), '等待超时')
}

function fieldOf(view: SettingsNamespaceView, path: string): SettingsNamespaceView['fields'][number] {
  const seen: SettingsNamespaceView['fields'][number][] = []
  const walk = (fields: SettingsNamespaceView['fields']): void => {
    for (const field of fields) {
      seen.push(field)
      if (field.children !== undefined) walk(field.children)
    }
  }
  walk(view.fields)
  const found = seen.find((field) => field.path === path)
  assert.ok(found !== undefined, `没找到字段 ${path}（有：${seen.map((item) => item.path).join(' / ')}）`)
  return found
}

async function assertCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    return true
  })
}

test('describe：能看到树上的插件，秘密字段只给「配没配」', async () => {
  const { settings } = await boot()
  const all = await settings.describe()
  const mailer = all.find((item) => item.ns === 'mailer')

  assert.ok(mailer !== undefined)
  assert.equal(mailer.plugin, '@dizzyapi/plugin-mailer')
  assert.equal(mailer.active, true)
  assert.equal(mailer.overridden, false)
  assert.equal(mailer.revision, null)
  assert.equal(mailer.writable, true)

  const pass = fieldOf(mailer, 'smtp.pass')
  assert.equal(pass.secret, true)
  assert.equal(pass.writable, false)
  assert.equal('value' in pass, false, '秘密字段不许带出 value')
  assert.equal(pass.configured, false)

  const passRef = fieldOf(mailer, 'smtp.passRef')
  assert.equal(passRef.credentialRef, true)
  assert.equal(passRef.writable, true)

  const host = fieldOf(mailer, 'smtp.host')
  assert.equal(host.kind, 'string')
  assert.equal(host.value, undefined)
})

test('运行期没有可写字段的插件只是只读可见', async () => {
  const { settings } = await boot()
  const settingsNs = (await settings.describe()).find((item) => item.ns === 'settings')
  assert.ok(settingsNs !== undefined, '设置插件自己也应该在清单里')
  assert.equal(settingsNs.writable, false, 'dataPath 与 adminPlugins 都不许运行期改')
  assert.equal(fieldOf(settingsNs, 'adminPlugins').writable, false)
})

test('改 SMTP 配置：目标插件软重启，新配置真的能用', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  const { ctx, settings } = await boot()
  const before = mailerOf(ctx)
  assert.equal(before.config.transport, 'log')

  await settings.update(ACTOR, 'mailer', {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: server.port, user: 'robot' },
  })

  const after = mailerOf(ctx)
  assert.equal(before.config.transport, 'log', '旧实例停留在旧配置上')
  assert.equal(after.config.transport, 'smtp', '新实例拿到了新配置')
  assert.equal(after.config.smtp?.host, '127.0.0.1')

  // 不只是「看着变了」：真发一封，走的是刚改出来的那个配置
  const receipt = await after.send({ to: 'alice@example.com', subject: '验证码', text: '验证码：123456' })
  assert.equal(receipt.transport, 'smtp')
  assert.ok(server.commands.some((line) => line.startsWith('MAIL FROM:')))
})

test('覆盖落在设置插件自己的文件里，app.yml 的基线不动', async () => {
  const dataPath = join(await mkdtemp(join(tmpdir(), 'dizzyapi-settings-')), 'settings.json')
  const { ctx, settings } = await boot({ settings: { dataPath } })

  await settings.update(ACTOR, 'mailer', { heloDomain: 'changed.example.com' })

  const written = JSON.parse(await readFile(dataPath, 'utf8')) as {
    version: number
    namespaces: Record<string, { revision: string; config: Record<string, unknown> }>
  }
  assert.equal(written.version, 1)
  assert.deepEqual(written.namespaces.mailer?.config, { heloDomain: 'changed.example.com' })
  assert.match(written.namespaces.mailer?.revision ?? '', /^[0-9a-f]{16}$/)

  // 基线（entry.options.config）在这个进程里也没被改过——`noSave: true` 的效果
  const entry = [...(ctx.loader as unknown as { entries(): { options: { id: string; config: unknown } }[] }).entries()]
    .find((item) => item.options.id === 'mailer')
  assert.deepEqual(entry?.options.config, { transport: 'log' })
})

test('启动重放：文件里有覆盖，起来就生效', async () => {
  const dataPath = join(await mkdtemp(join(tmpdir(), 'dizzyapi-settings-')), 'settings.json')
  await writeFile(
    dataPath,
    JSON.stringify({
      version: 1,
      namespaces: { mailer: { revision: 'x', config: { heloDomain: 'replayed.example.com' }, updatedAt: 't' } },
    }),
    'utf8',
  )

  const { ctx } = await boot({ settings: { dataPath } })
  await waitFor(() => mailerOf(ctx).config.heloDomain === 'replayed.example.com')
})

test('校验不过：不部分应用、保留旧配置、也不落盘', async () => {
  const dataPath = join(await mkdtemp(join(tmpdir(), 'dizzyapi-settings-')), 'settings.json')
  const { ctx, settings } = await boot({ settings: { dataPath } })

  await settings.update(ACTOR, 'mailer', { heloDomain: 'good.example.com' })
  const before = await readFile(dataPath, 'utf8')

  // port 超出范围，mailer 自己的 schema 会拒绝
  await assertCode(settings.update(ACTOR, 'mailer', { smtp: { port: 99_999 } }), 'SETTINGS_VALUE_INVALID')

  assert.equal(mailerOf(ctx).config.heloDomain, 'good.example.com', '旧配置原样保留')
  assert.equal(await readFile(dataPath, 'utf8'), before, '文件没被写进那份坏配置')
})

test('目标缺失 / 被禁用：显式失败，绝不静默跳过', async () => {
  const { ctx, settings } = await boot()
  await assertCode(settings.update(ACTOR, '没有这个', { transport: 'log' }), 'SETTINGS_TARGET_MISSING')

  await createEntry(ctx, {
    id: 'off',
    name: '@dizzyapi/plugin-mailer',
    config: { transport: 'log' },
    disabled: true,
  })
  await ctx.loader.await()
  await assertCode(settings.update(ACTOR, 'off', { transport: 'smtp' }), 'SETTINGS_TARGET_DISABLED')
})

test('写权限：白名单默认拒绝，调用方必须自报名字', async () => {
  const { settings } = await boot({ settings: { adminPlugins: [] } })
  await assertCode(settings.update(ACTOR, 'mailer', { heloDomain: 'x' }), 'SETTINGS_ACTOR_FORBIDDEN')
  await assertCode(settings.update('  ', 'mailer', { heloDomain: 'x' }), 'SETTINGS_ACTOR_REQUIRED')
})

test('字段级：不认识的键拒绝，不可写的键拒绝', async () => {
  const { settings } = await boot()
  await assertCode(settings.update(ACTOR, 'mailer', { nope: 1 }), 'SETTINGS_FIELD_UNKNOWN')
  await assertCode(settings.update(ACTOR, 'mailer', { smtp: { nope: 1 } }), 'SETTINGS_FIELD_UNKNOWN')
  await assertCode(
    settings.update(ACTOR, 'mailer', { smtp: { pass: 'plaintext-secret' } }),
    'SETTINGS_FIELD_NOT_WRITABLE',
  )
})

test('null 是删除：能把基线里的旧键清掉（改字段用）', async () => {
  const { ctx, settings } = await boot({
    mailer: { transport: 'log', replyTo: 'reply@dizzyapi.test' },
  })

  await settings.update(ACTOR, 'mailer', { replyTo: null })
  // replyTo 是可选字段，删掉之后走默认（undefined），而不是变成 null
  assert.equal(mailerOf(ctx).config.replyTo, undefined)
})

test('revision：带上过期的指纹就报冲突', async () => {
  const { settings } = await boot()
  const view = await settings.update(ACTOR, 'mailer', { heloDomain: 'a.example.com' })
  assert.ok(view.revision !== null)

  await assertCode(
    settings.update(ACTOR, 'mailer', { heloDomain: 'b.example.com' }, 'deadbeefdeadbeef'),
    'SETTINGS_CONFLICT',
  )

  const applied = await settings.update(ACTOR, 'mailer', { heloDomain: 'b.example.com' }, view.revision!)
  assert.equal(applied.revision !== null, true)
})

test('reset：清掉覆盖，回到基线', async () => {
  const { ctx, settings } = await boot()
  await settings.update(ACTOR, 'mailer', { heloDomain: 'temp.example.com' })
  assert.equal(mailerOf(ctx).config.heloDomain, 'temp.example.com')

  const view = await settings.reset(ACTOR, 'mailer')
  assert.equal(view.overridden, false)
  assert.equal(view.revision, null)
  assert.equal(mailerOf(ctx).config.heloDomain, 'localhost', '回到基线默认值')
})

test('get：未知命名空间报错；已知的能给', async () => {
  const { settings } = await boot()
  await assertCode(settings.get('没有这个'), 'SETTINGS_NS_UNKNOWN')
  assert.equal((await settings.get('mailer')).ns, 'mailer')
})

test('覆盖变化会发出 settings/updated', async () => {
  const { ctx, settings } = await boot()
  const seen: string[] = []
  ctx.on('settings/updated', (ns: string) => seen.push(ns))
  await settings.update(ACTOR, 'mailer', { heloDomain: 'x' })
  assert.deepEqual(seen, ['mailer'])
})

test('applyAll 是幂等的：一致的覆盖不会重复重启插件', async () => {
  const { ctx, settings } = await boot()
  await settings.update(ACTOR, 'mailer', { heloDomain: 'x.example.com' })
  const stable = mailerOf(ctx)

  await settings.applyAll()
  await settings.applyAll()
  assert.equal(mailerOf(ctx).config.heloDomain, 'x.example.com')
  // 没有重启的间接证据：这几次 applyAll 之后实例仍是同一个（配置一致就跳过）
  assert.equal(mailerOf(ctx).describe, stable.describe)
})

test('软重启会级联：改 mailer 会连带重启 inject 了它的 auth', async (t) => {
  // 这是软重启最容易咬人的一面：auth 的 static inject 里有 mailer，
  // 所以「只想改个 SMTP 主机」的加作会把 auth 也重启一遍。这里把它钉成契约。
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-cascade-'))
  const ctx = new Context()
  await ctx.plugin(Loader)
  await createEntry(ctx, {
    id: 'user',
    name: '@dizzyapi/plugin-user',
    config: { dataPath: join(dir, 'users.db'), adminPlugins: ['@dizzyapi/plugin-auth'] },
  })
  await createEntry(ctx, { id: 'mailer', name: '@dizzyapi/plugin-mailer', config: { transport: 'log' } })
  await createEntry(ctx, {
    id: 'auth',
    name: '@dizzyapi/plugin-auth',
    config: { dataPath: join(dir, 'auth.db'), userActor: '@dizzyapi/plugin-auth' },
  })
  await createEntry(ctx, {
    id: 'settings',
    name: '@dizzyapi/plugin-settings',
    config: { adminPlugins: [ACTOR] },
  })
  await ctx.loader.await()

  // 服务被重新提供时 cordis 会发 internal/service；收它比去摸 traced proxy 安全得多。
  const touched = new Set<string>()
  ctx.root.on(
    'internal/service',
    (name: string) => {
      touched.add(name)
    },
    { global: true },
  )

  await (ctx.get('settings') as SettingsService).update(ACTOR, 'mailer', { heloDomain: `cascade-${Date.now()}.local` })

  assert.ok(touched.has('mailer'), 'mailer 自己应该重启')
  assert.ok(touched.has('auth'), 'auth inject 了 mailer，应该跟着重启')
  assert.equal(touched.has('user'), false, 'user 与 mailer 无关，不该被牵连')
})

test('R1：改配置绝不回写 app.yml —— Include 拥有的那份文件一字不动', async (t) => {
  // 这条用例复刻的是**真实启动路径**，不是 `ctx.loader.create` 直连：
  // cordis 的 bin.js 是 `ctx.baseUrl = cwd` → `plugin(Loader)` →
  // `loader.create({ name: '@cordisjs/plugin-include', config: { path } })`，
  // 也就是说 app.yml 里的 entry 全都长在 include 那棵子树里。设置插件的发现逻辑
  // 必须能穿过这一层（靠 EntryTree 把子树挂在 entry.subtree 上），否则线上会「什么都看不见」。
  //
  // 夹具必须放在仓库里：entry 的插件名要沿目录往上解析到 workspace 链接，
  // 放到系统临时目录就解析不到 @dizzyapi/plugin-mailer 了。
  const testDir = fileURLToPath(new URL('.', import.meta.url))
  const dir = await mkdtemp(join(testDir, '.r1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'app.yml')

  // 基线里的这条注释就是 R1 的观测点：noSave 那条链路一旦断掉，
  // Include 会用 yaml.dump 整份重写，注释第一个消失。
  const baseline = [
    '# 人写的基线：这条注释必须活下来（R1）',
    '- id: mailer',
    "  name: '@dizzyapi/plugin-mailer'",
    '  config:',
    '    transport: log',
    '',
    '- id: settings',
    "  name: '@dizzyapi/plugin-settings'",
    '  config:',
    '    adminPlugins:',
    '      - test/actor',
    '',
  ].join('\n')
  await writeFile(file, baseline, 'utf8')

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'
  await ctx.plugin(Loader)
  await createEntry(ctx, {
    name: '@cordisjs/plugin-include',
    config: { path: relative(process.cwd(), file).replaceAll('\\', '/') },
  })
  await ctx.loader.await()

  const settings = ctx.get('settings') as SettingsService
  assert.equal(mailerOf(ctx).config.transport, 'log')

  await settings.update(ACTOR, 'mailer', { heloDomain: 'yaml-stays.com' })

  // 先证明这次改动**真的生效了**，否则「文件没变」可能只是更新空转的假绿
  assert.equal(mailerOf(ctx).config.heloDomain, 'yaml-stays.com')

  // 关键的一步：Include 的落盘是 fire-and-forget（`commit()` 里 `_drain()` 不 await），
  // 立刻读文件会**抢在写之前**，用例就成了永远绿的摆设。等它把该写的都写完再断言。
  const includeEntry = [...ctx.loader.entries()].find((entry) => entry.options.name === '@cordisjs/plugin-include')
  assert.ok(includeEntry?.subtree !== undefined, 'include 的子树应该挂在 loader 树上')
  await (includeEntry.subtree as unknown as { flush(): Promise<void> }).flush()

  assert.equal(await readFile(file, 'utf8'), baseline, 'app.yml 被回写了：注释或内容变了')
})

test('直接装载：覆盖文件损坏就报错，不带着空覆盖跑起来', async () => {
  const dataPath = join(await mkdtemp(join(tmpdir(), 'dizzyapi-settings-')), 'settings.json')
  await writeFile(dataPath, '坏掉的 JSON', 'utf8')

  const ctx = new Context()
  await ctx.plugin(Loader)
  // ctx.plugin 返回的是 thenable 的 Fiber，交给 assert.rejects 要包一层
  await assertCode(
    (async () => {
      await ctx.plugin(SettingsService, { dataPath })
    })(),
    'SETTINGS_STORE_CORRUPT',
  )
})

test('经 loader 装载：损坏的覆盖让设置插件起不来（错误进日志，服务取不到）', async () => {
  const dataPath = join(await mkdtemp(join(tmpdir(), 'dizzyapi-settings-')), 'settings.json')
  await writeFile(dataPath, '坏掉的 JSON', 'utf8')

  const ctx = new Context()
  await ctx.plugin(Loader)
  await createEntry(ctx, { id: 'settings', name: '@dizzyapi/plugin-settings', config: { dataPath } })
  // loader 不把装载失败往上抛（只记日志、fiber 停在 FAILED），所以这里断言的是后果：
  // 严格取服务取不到 = 它没跑起来，而不是「跑起来了但覆盖是空的」。
  await ctx.loader.await()
  assert.equal(ctx.get('settings'), undefined)
})
