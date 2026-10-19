import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'
import AccountPriorityService, {
  isAccountPriorityError,
  validateAccountPriorityConfig,
  type AccountPriorityConfig,
  type StrategyGroup,
} from '../src/index.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-gatewayd.mjs', import.meta.url))

interface World {
  readonly ctx: Context
  readonly service: AccountPriorityService
  readonly fiber: { dispose(): Promise<void> | void }
  readonly dir: string
}

async function boot(
  t: TestContext,
  overrides: AccountPriorityConfig = {},
  existingDir?: string,
): Promise<World> {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), 'dizzyapi-account-priority-')))
  const ctx = new Context()
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
    ...overrides,
  })
  const world: World = {
    ctx,
    service: ctx.get('accountPriority') as AccountPriorityService,
    fiber,
    dir,
  }
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 用例里可能已经主动卸载过。
    }
    await rm(dir, { recursive: true, force: true })
  })
  return world
}

function customStrategy(id: string): StrategyGroup {
  return {
    id,
    name: id,
    factors: { health: { weight: 1 } },
    selection: 'rank',
    tieBreaker: ['accountId'],
  }
}

async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('等待条件超时')
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('启动 gatewayd 并完成 hello 握手', async (t) => {
  const world = await boot(t)
  const status = world.service.status()
  assert.equal(status.state, 'ready')
  assert.ok((status.pid ?? 0) > 0)
  assert.equal(status.transport, 'tcp')
  assert.equal(status.bridgeConnected, true)
  assert.equal(status.defaultStrategy, 'default')
  assert.equal(status.strategies, 1)
  assert.equal(status.revision, 'fake-1')

  const remote = await world.service.remoteStatus()
  assert.equal(remote.ready, true)
  assert.equal(remote.revision, 'fake-1')
})

test('策略组落盘并在重启后恢复', async (t) => {
  const world = await boot(t)
  await world.service.upsertStrategy(customStrategy('extra'))

  assert.equal(world.service.listStrategies().strategies.length, 2)
  assert.equal(world.service.status().revision, 'fake-2')

  const raw = JSON.parse(
    await readFile(join(world.dir, 'strategies.json'), 'utf8'),
  ) as { strategies: { id: string }[] }
  assert.deepEqual(
    raw.strategies.map((strategy) => strategy.id),
    ['default', 'extra'],
  )

  await world.fiber.dispose()
  const restored = await boot(t, {}, world.dir)
  const ids = restored.service.listStrategies().strategies.map((strategy) => strategy.id)
  assert.deepEqual(ids, ['default', 'extra'])
})

test('非法策略被拒绝，且不会写盘', async (t) => {
  const world = await boot(t)
  const before = world.service.listStrategies().strategies.length
  await assert.rejects(
    world.service.upsertStrategy({
      id: 'Bad ID',
      factors: { health: { weight: 1 } },
    }),
    (error: unknown) => {
      assert.ok(isAccountPriorityError(error))
      assert.equal(error.code, 'ACCOUNT_PRIORITY_STRATEGY_INVALID')
      return true
    },
  )
  assert.equal(world.service.listStrategies().strategies.length, before)
})

test('不能删除最后一个策略组', async (t) => {
  const world = await boot(t)
  await assert.rejects(world.service.removeStrategy('default'), (error: unknown) => {
    assert.ok(isAccountPriorityError(error))
    assert.equal(error.code, 'ACCOUNT_PRIORITY_STRATEGY_INVALID')
    return true
  })
})

test('preview / pick 经控制桥交给 Go', async (t) => {
  const world = await boot(t)
  const request = {
    candidates: [
      { accountId: 'b', provider: 'claude' },
      { accountId: 'a', provider: 'claude' },
    ],
  }
  const preview = await world.service.preview(request)
  assert.deepEqual(
    preview.ranked.map((entry) => entry.accountId),
    ['b', 'a'],
  )

  const picked = await world.service.pick(request)
  assert.equal(picked.accountId, 'b')

  await assert.rejects(
    world.service.pick({ candidates: [] }),
    (error: unknown) => {
      assert.ok(isAccountPriorityError(error))
      assert.equal(error.code, 'ACCOUNT_PRIORITY_REQUEST_FAILED')
      assert.equal(error.remoteCode, 'ACCOUNT_PRIORITY_NO_ELIGIBLE_ACCOUNT')
      return true
    },
  )
})

test('autoStart=false：先 stopped，start 后可用', async (t) => {
  const world = await boot(t, { autoStart: false })
  assert.equal(world.service.status().state, 'stopped')
  await assert.rejects(world.service.preview({ candidates: [] }), (error: unknown) => {
    assert.ok(isAccountPriorityError(error))
    assert.equal(error.code, 'ACCOUNT_PRIORITY_NOT_READY')
    return true
  })

  const started = await world.service.start()
  assert.equal(started.state, 'ready')
  assert.equal((await world.service.preview({ candidates: [] })).ranked.length, 0)
})

test('子进程崩溃后按退避重启', async (t) => {
  const world = await boot(t, { args: [FAKE, '--mode=crash-after-ready'] })
  await waitFor(() => world.service.status().restarts >= 1)
  assert.ok(world.service.status().restarts >= 1)
})

test('启动超时是可读错误，不会挂住插件', async (t) => {
  const world = await boot(t, {
    autoStart: false,
    args: [FAKE, '--mode=hang'],
    startTimeoutMs: 1_000,
    stopTimeoutMs: 1_000,
  })
  await assert.rejects(world.service.start(), (error: unknown) => {
    assert.ok(isAccountPriorityError(error))
    assert.equal(error.code, 'ACCOUNT_PRIORITY_START_TIMEOUT')
    return true
  })
  assert.equal(world.service.status().state, 'failed')
})

test('可执行文件不存在时报 BINARY_MISSING', async (t) => {
  const world = await boot(t, {
    autoStart: false,
    binaryPath: join(tmpdir(), 'dizzyapi-missing-gatewayd'),
  })
  await assert.rejects(world.service.start(), (error: unknown) => {
    assert.ok(isAccountPriorityError(error))
    assert.equal(error.code, 'ACCOUNT_PRIORITY_BINARY_MISSING')
    return true
  })
})

test('策略文件损坏：装载直接失败，不静默重建', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-account-priority-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'strategies.json'), '{ not json', 'utf8')

  const ctx = new Context()
  await assert.rejects(
    async () => {
      await ctx.plugin(AccountPriorityService, {
        dataPath: join(dir, 'strategies.json'),
        autoStart: false,
      })
    },
    (error: unknown) => {
      assert.ok(isAccountPriorityError(error))
      assert.equal(error.code, 'ACCOUNT_PRIORITY_STORE_CORRUPT')
      return true
    },
  )
})

test('卸载插件会停止子进程（D5）', async (t) => {
  const world = await boot(t)
  const pid = world.service.status().pid
  assert.ok(pid !== null)
  await world.fiber.dispose()
  await waitFor(() => !isAlive(pid as number), 5_000)
  assert.equal(isAlive(pid as number), false)
})

test('配置校验：默认值、未知键与枚举', () => {
  const resolved = validateAccountPriorityConfig({})
  assert.ok(!isIssueList(resolved))
  if (!isIssueList(resolved)) {
    assert.equal(resolved.transport, 'auto')
    assert.equal(resolved.autoStart, true)
    assert.equal(resolved.binaryPath, './bin/gatewayd')
  }

  const unknown = validateAccountPriorityConfig({ nope: 1 })
  assert.ok(Array.isArray(unknown))

  const wrongEnum = validateAccountPriorityConfig({ transport: 'udp' })
  assert.ok(Array.isArray(wrongEnum))
})

test('策略写入会发出事件', async (t) => {
  const world = await boot(t)
  const events: string[] = []
  world.ctx.on('account-priority/strategies-updated', (id, action) => {
    events.push(`${action}:${id}`)
  })
  await world.service.upsertStrategy(customStrategy('watched'))
  assert.deepEqual(events, ['upsert:watched'])
})
