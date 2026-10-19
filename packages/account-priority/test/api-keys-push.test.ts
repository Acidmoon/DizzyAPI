import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import AccountPriorityService, {
  type GatewayKey,
  type GatewayKeySnapshot,
} from '../src/index.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-gatewayd.mjs', import.meta.url))

/**
 * api-key 的结构性替身：只实现 snapshot()，并用 api-key/changed 提示重推。
 * 真实实现是 packages/api-key；这里不 import 它的实现。
 */
class FakeApiKey extends Service {
  private keys: GatewayKey[] = []
  private generation = 0

  constructor(ctx: Context) {
    super(ctx, 'apiKey')
  }

  async snapshot(): Promise<GatewayKeySnapshot> {
    return {
      version: 1,
      generation: this.generation,
      keys: this.keys.map((key) => ({ ...key })),
    }
  }

  replace(keys: GatewayKey[], emit = true): void {
    this.keys = keys.map((key) => ({ ...key }))
    this.generation += 1
    if (!emit) return
    const emitEvent = this.ctx.emit as unknown as (name: string, event: unknown) => void
    emitEvent.call(this.ctx, 'api-key/changed', {
      userId: 1,
      keyId: keys[0]?.keyId ?? 'none',
      action: 'created',
    })
  }
}

interface World {
  readonly ctx: Context
  readonly service: AccountPriorityService
  readonly apiKey: FakeApiKey | undefined
  readonly apiKeyFiber: { dispose(): Promise<void> | void } | undefined
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, withApiKey = true): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-keys-push-'))
  const ctx = new Context()
  let apiKey: FakeApiKey | undefined
  let apiKeyFiber: { dispose(): Promise<void> | void } | undefined
  if (withApiKey) {
    apiKeyFiber = await ctx.plugin(FakeApiKey)
    apiKey = ctx.get('apiKey') as unknown as FakeApiKey
  }
  const fiber = await ctx.plugin(AccountPriorityService, {
    dataPath: join(dir, 'strategies.json'),
    binaryPath: process.execPath,
    args: [FAKE],
    socketPath: join(dir, 'gatewayd.sock'),
    transport: 'tcp',
    autoStart: true,
    startTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    stopTimeoutMs: 2_000,
    restartDelayMs: 100,
    maxRestartDelayMs: 1_000,
    httpListen: '127.0.0.1:0',
  })
  const world: World = {
    ctx,
    service: ctx.get('accountPriority') as AccountPriorityService,
    apiKey,
    apiKeyFiber,
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

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

function key(id: string, hashChar: string): GatewayKey {
  return {
    keyId: id,
    userId: 1,
    keyHash: hashChar.repeat(64),
    profile: 'billed',
    name: `name-${id}`,
  }
}

/** user/changed 的事件类型由 feat/user-system 分支声明；这里按字符串发。 */
function emitUserChanged(ctx: Context): void {
  const emitEvent = ctx.emit as unknown as (name: string, event: unknown) => void
  emitEvent.call(ctx, 'user/changed', { userId: 1, action: 'updated', fields: ['status'] })
}

test('启动后推送空 key 快照，事件触发重推且只带最小字段', async (t) => {
  const world = await boot(t)
  assert.ok(world.apiKey)
  await waitFor(() => world.service.status().state === 'ready')
  await waitFor(() => world.service.status().keysRevision !== null)
  assert.equal(world.service.status().keys, 0)

  const first = key('key-1', 'a')
  const second = key('key-2', 'b')
  world.apiKey.replace([first, second])

  await waitFor(() => world.service.status().keys === 2)
  const status = world.service.status()
  assert.ok(status.keysRevision?.startsWith('fake-keys-'))
  const payload = JSON.stringify(status)
  assert.ok(!payload.includes(first.keyHash), '状态不得包含 keyHash')
  assert.ok(!payload.includes(second.keyHash), '状态不得包含 keyHash')

  // 假 gatewayd 也校验形状；能走到这里说明没有多余字段。
  const remote = (await world.service.remoteStatus()) as { keys?: number }
  assert.equal(remote.keys, 2)
})

test('sync() 会重推没有触发事件的 key 快照', async (t) => {
  const world = await boot(t)
  assert.ok(world.apiKey)
  await waitFor(() => world.service.status().keysRevision !== null)

  world.apiKey.replace([key('key-sync', 'c')], false)
  assert.equal(world.service.status().keys, 0)

  await world.service.sync()
  await waitFor(() => world.service.status().keys === 1)
  assert.equal(world.service.status().keys, 1)
})

test('没有 api-key 服务时跳过推送，不阻塞 gatewayd 就绪', async (t) => {
  const world = await boot(t, false)
  await waitFor(() => world.service.status().state === 'ready')
  // 等启动时的账号快照推送完成，确认 keys 推送确实被跳过而不是还在路上。
  await waitFor(() => world.service.status().accountsRevision !== null)
  assert.equal(world.service.status().keys, 0)
  assert.equal(world.service.status().keysRevision, null)
})

test('user/changed 触发 key 快照重推', async (t) => {
  const world = await boot(t)
  await waitFor(() => world.service.status().keysRevision !== null)
  const before = world.service.status().keysRevision

  emitUserChanged(world.ctx)
  await waitFor(() => world.service.status().keysRevision !== before)
  assert.notEqual(world.service.status().keysRevision, before)
})

test('api-key 服务在 account-priority 之后出现时推送一次', async (t) => {
  const world = await boot(t, false)
  await waitFor(() => world.service.status().state === 'ready')
  await waitFor(() => world.service.status().accountsRevision !== null)
  assert.equal(world.service.status().keysRevision, null)

  // HMR 场景：服务出现 -> internal/service(apiKey, impl) -> 防抖推送。
  await world.ctx.plugin(FakeApiKey)
  const fake = world.ctx.get('apiKey') as unknown as FakeApiKey
  // 不触发 api-key/changed；能否推送完全取决于服务出现时的 watcher。
  fake.replace([key('late-key', 'd')], false)

  await waitFor(() => world.service.status().keys === 1)
  assert.ok(world.service.status().keysRevision?.startsWith('fake-keys-'))
})

test('api-key 服务被卸载时推送空快照撤销旧 key（D5）', async (t) => {
  const world = await boot(t)
  assert.ok(world.apiKey)
  assert.ok(world.apiKeyFiber)
  world.apiKey.replace([key('revoked-key', 'e')])
  await waitFor(() => world.service.status().keys === 1)
  const before = world.service.status().keysRevision
  const beforeGeneration = (
    (await world.service.remoteStatus()) as { keysGeneration?: number }
  ).keysGeneration

  await world.apiKeyFiber.dispose()
  await waitFor(
    () =>
      world.service.status().keys === 0 &&
      world.service.status().keysRevision !== before,
  )

  const remote = (await world.service.remoteStatus()) as {
    keys?: number
    keysGeneration?: number
  }
  assert.equal(remote.keys, 0)
  assert.equal(typeof beforeGeneration, 'number')
  assert.equal(typeof remote.keysGeneration, 'number')
  assert.ok((remote.keysGeneration ?? 0) > (beforeGeneration ?? 0))
})

test('api-key 服务撤销后重新出现，再推非空快照', async (t) => {
  const world = await boot(t)
  assert.ok(world.apiKey)
  assert.ok(world.apiKeyFiber)
  world.apiKey.replace([key('before-disable', 'a')])
  await waitFor(() => world.service.status().keys === 1)

  await world.apiKeyFiber.dispose()
  await waitFor(() => world.service.status().keys === 0)
  const revokedGeneration = (
    (await world.service.remoteStatus()) as { keysGeneration?: number }
  ).keysGeneration

  await world.ctx.plugin(FakeApiKey)
  const fake = world.ctx.get('apiKey') as unknown as FakeApiKey
  fake.replace([key('after-enable', 'b')], false)
  await waitFor(() => world.service.status().keys === 1)

  const remote = (await world.service.remoteStatus()) as {
    keys?: number
    keysGeneration?: number
  }
  assert.equal(remote.keys, 1)
  assert.equal(typeof revokedGeneration, 'number')
  assert.equal(typeof remote.keysGeneration, 'number')
  // 新实例的 generation 从 1 重新开始，但推送时必须钳到不小于撤销时的值。
  assert.ok((remote.keysGeneration ?? 0) >= (revokedGeneration ?? 0))
})
