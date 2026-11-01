/**
 * 档案服务（`clientMask`）的护栏：**它是档案的唯一写者**。
 *
 * 这一组用例证明的是「能不能安全地用」：
 * 1. 只读面（`list` / `get` / `resolve` / `status`）不需要任何权限，且**不抛错**——
 *    账号引用了不存在的档案、档案被禁用、插件关掉，都不该让账号快照推送失败；
 * 2. 写面（`upsert` / `update` / `remove` / `reset`）**只对白名单开放**，且入参全校验；
 * 3. 落盘能活：写完之后新建一个服务实例（模拟重启）能读回来；
 * 4. 内置预置删不掉、改坏了能 reset；
 * 5. 升级友好：文件里缺了某个预置，装载时补回来（老文件不该看不见新预置）。
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from 'cordis'

import ClientMaskService, { ClientMaskError, PRESET_IDS } from '../src/index.ts'

/** 生产上改档案的那个 actor（与 settings / user 的 adminPlugins 同一批）。 */
const ACTOR = '@dizzyapi/plugin-api'

interface World {
  readonly ctx: Context
  readonly mask: ClientMaskService
  readonly fiber: { dispose(): Promise<void> | void }
  readonly dir: string
}

/** 起一个插件实例；不传 `dataPath` 时用这个用例自己的临时文件（不碰工作区）。 */
async function boot(t: TestContext, options: { dataPath?: string; enabled?: boolean } = {}): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'client-mask-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(ClientMaskService, {
    dataPath: options.dataPath ?? join(dir, 'client-mask.json'),
    enabled: options.enabled ?? true,
    adminPlugins: [ACTOR],
  })
  const mask = ctx.get('clientMask') as ClientMaskService
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能自己卸载过。
    }
    await rm(dir, { recursive: true, force: true })
  })
  return { ctx, mask, fiber, dir }
}

function errorCodeOf(error: unknown): string | undefined {
  return error instanceof ClientMaskError ? error.code : undefined
}

test('只读面：五个内置预置都在，resolve 按 id 取', async (t) => {
  const { mask } = await boot(t)
  const profiles = mask.list()
  assert.deepEqual(profiles.map((profile) => profile.id), [...PRESET_IDS])
  assert.deepEqual(mask.get('opencode')?.headers.map((header) => header.name), [
    'x-opencode-session',
    'x-opencode-client',
  ])

  const resolved = mask.resolve('opencode')
  assert.ok(resolved !== undefined)
  assert.equal(resolved.profileId, 'opencode')
  assert.equal(resolved.userAgent, 'opencode/0.4.2 (cli; linux x64)')
  assert.deepEqual(resolved.headers[0], { name: 'x-opencode-session', value: '{{session}}' })

  // 没挂 / 引用了不存在的档案 → undefined（不抛错：账号快照推送不能因一条坏引用整份失败）。
  assert.equal(mask.resolve(null), undefined)
  assert.equal(mask.resolve(undefined), undefined)
  assert.equal(mask.resolve(''), undefined)
  assert.equal(mask.resolve('missing-profile'), undefined)

  const status = mask.status()
  assert.equal(status.profiles, PRESET_IDS.length)
  assert.equal(status.builtin, PRESET_IDS.length)
  assert.equal(status.custom, 0)
  assert.equal(status.enabled, true)
})

test('总闸关掉：档案还在，但 resolve 一律 undefined', async (t) => {
  const { mask } = await boot(t, { enabled: false })
  assert.equal(mask.status().enabled, false)
  assert.equal(mask.list().length, PRESET_IDS.length, '档案不该因为总闸关掉就消失')
  assert.equal(mask.resolve('opencode'), undefined, '总闸关掉 = 完全不伪装')
})

test('档案被禁用：resolve undefined（账号挂它等于不伪装）', async (t) => {
  const { mask } = await boot(t)
  await mask.update(ACTOR, 'opencode', { enabled: false })
  assert.equal(mask.resolve('opencode'), undefined)
  assert.equal(mask.status().enabledProfiles, PRESET_IDS.length - 1)
  // 再打开就回来。
  await mask.update(ACTOR, 'opencode', { enabled: true })
  assert.ok(mask.resolve('opencode') !== undefined)
})

test('新建自定义档案 → 可解析；坏入参一律拒绝', async (t) => {
  const { mask } = await boot(t)
  const created = await mask.upsert(ACTOR, {
    id: 'my-client',
    label: '我的客户端',
    description: '自定义',
    userAgent: 'my-client/1.0',
    headers: [{ name: 'x-my-session', value: '{{session}}' }],
  })
  assert.equal(created.builtin, false)
  assert.equal(mask.status().custom, 1)
  assert.deepEqual(mask.resolve('my-client')?.headers, [{ name: 'x-my-session', value: '{{session}}' }])

  const bad = [
    { id: 'Bad-Id', label: 'x' },
    { id: 'ok-id', label: 'x', headers: [{ name: 'Authorization', value: 'Bearer x' }] },
    { id: 'ok-id', label: 'x', headers: [{ name: 'x-a', value: 'a\r\nb' }] },
    { id: 'ok-id', label: 'x', headers: [{ name: 'x-a', value: '{{token}}' }] },
    { id: 'ok-id', label: 'x', headers: [{ name: 'x-a', value: '1' }, { name: 'X-A', value: '2' }] },
    { id: 'ok-id', label: '  ' },
  ]
  for (const input of bad) {
    await assert.rejects(
      () => mask.upsert(ACTOR, input as never),
      (error: unknown) => {
        assert.equal(errorCodeOf(error), 'CLIENT_MASK_INPUT_INVALID', `应拒绝：${JSON.stringify(input)}`)
        return true
      },
    )
  }
})

test('写面只对白名单开放', async (t) => {
  const { mask } = await boot(t)
  for (const action of [
    () => mask.upsert('@dizzyapi/plugin-evil', { id: 'evil', label: 'evil' }),
    () => mask.update('@dizzyapi/plugin-evil', 'opencode', { label: 'x' }),
    () => mask.remove('@dizzyapi/plugin-evil', 'codex'),
    () => mask.reset('@dizzyapi/plugin-evil', 'opencode'),
  ]) {
    await assert.rejects(action, (error: unknown) => {
      assert.equal(errorCodeOf(error), 'CLIENT_MASK_ACTOR_FORBIDDEN')
      return true
    })
  }
  // 拒绝之后档案没变。
  assert.equal(mask.get('opencode')?.label, 'opencode 客户端')
})

test('内置预置：能改、能 reset、不许删', async (t) => {
  const { mask } = await boot(t)
  const original = mask.get('opencode')
  assert.ok(original !== undefined)

  await mask.update(ACTOR, 'opencode', { label: '改过的名字', userAgent: 'opencode/9.9.9' })
  assert.equal(mask.get('opencode')?.label, '改过的名字')

  const restored = await mask.reset(ACTOR, 'opencode')
  assert.equal(restored.label, original.label)
  assert.equal(restored.userAgent, original.userAgent)

  await assert.rejects(() => mask.remove(ACTOR, 'opencode'), (error: unknown) => {
    assert.equal(errorCodeOf(error), 'CLIENT_MASK_INPUT_INVALID')
    assert.match((error as Error).message, /内置预置/)
    return true
  })

  // 自定义的可以删。
  await mask.upsert(ACTOR, { id: 'temp-profile', label: '临时' })
  assert.equal(await mask.remove(ACTOR, 'temp-profile').then((result) => result.removed), true)
  assert.equal(mask.get('temp-profile'), undefined)
  await assert.rejects(() => mask.remove(ACTOR, 'nope'), (error: unknown) => {
    assert.equal(errorCodeOf(error), 'CLIENT_MASK_PROFILE_UNKNOWN')
    return true
  })
})

test('落盘能活：重启后读到改过的档案', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'client-mask-store-'))
  const dataPath = join(dir, 'client-mask.json')
  t.after(() => rm(dir, { recursive: true, force: true }))

  const first = await boot(t, { dataPath })
  await first.mask.update(ACTOR, 'opencode', { userAgent: 'opencode/9.9.9' })
  await first.mask.upsert(ACTOR, { id: 'persisted', label: '落盘的', headers: [{ name: 'x-p', value: 'v' }] })
  await first.fiber.dispose()

  const raw = JSON.parse(await readFile(dataPath, 'utf8')) as { version: number; profiles: { id: string }[] }
  assert.equal(raw.version, 1)
  assert.ok(raw.profiles.some((profile) => profile.id === 'persisted'), '自定义档案没落盘')

  const second = await boot(t, { dataPath })
  assert.equal(second.mask.get('opencode')?.userAgent, 'opencode/9.9.9')
  assert.equal(second.mask.get('persisted')?.label, '落盘的')
})

test('升级友好：文件缺了某个预置 → 装载时补回来；坏文件整份拒绝', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'client-mask-upgrade-'))
  const dataPath = join(dir, 'client-mask.json')
  t.after(() => rm(dir, { recursive: true, force: true }))

  // 只有 codex 一份：其余预置应该在装载时补回来。
  await writeFile(
    dataPath,
    JSON.stringify({ version: 1, profiles: [{ id: 'codex', label: '我的 codex', enabled: true, headers: [] }] }),
    'utf8',
  )
  const world = await boot(t, { dataPath })
  assert.deepEqual(world.mask.list().map((profile) => profile.id), [...PRESET_IDS])
  assert.equal(world.mask.get('codex')?.label, '我的 codex', '文件里的改动要保留')
  assert.equal(world.mask.get('opencode')?.builtin, true, '补回来的预置必须标成内置')

  // 坏文件：头名非法 → 装载失败（不静默丢档案）。
  const badPath = join(dir, 'bad.json')
  await writeFile(
    badPath,
    JSON.stringify({ version: 1, profiles: [{ id: 'x', label: 'x', headers: [{ name: 'bad name', value: 'v' }] }] }),
    'utf8',
  )
  await assert.rejects(() => boot(t, { dataPath: badPath }))
})
