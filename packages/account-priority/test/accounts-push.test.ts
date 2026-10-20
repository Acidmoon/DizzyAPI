import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import AccountPriorityService from '../src/index.ts'

const FAKE = fileURLToPath(new URL('./fixtures/fake-gatewayd.mjs', import.meta.url))

interface FakeAccount {
  readonly id: string
  readonly provider: string
  readonly kind: string
  readonly enabled: boolean
  readonly status: string
  readonly baseUrl?: string | null
  readonly protocol?: string | null
  readonly priority?: number
  readonly accessExpiresAt: string | null
}

interface World {
  readonly ctx: Context
  readonly service: AccountPriorityService
  readonly identity: FakeIdentity
  readonly dispose: () => Promise<void>
}

class FakeIdentity extends Service {
  private accounts = new Map<string, FakeAccount>()
  private tokens = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'identity')
  }

  list(): FakeAccount[] {
    return [...this.accounts.values()]
  }

  async getAccessToken(id: string): Promise<string> {
    const token = this.tokens.get(id)
    if (token === undefined) throw new Error(`账号 ${id} 没有令牌`)
    return token
  }

  add(account: FakeAccount, token: string): void {
    this.accounts.set(account.id, account)
    this.tokens.set(account.id, token)
    this.ctx.emit('identity/account-updated', account.id, 'created')
  }

  remove(id: string): void {
    this.accounts.delete(id)
    this.tokens.delete(id)
    this.ctx.emit('identity/account-updated', id, 'removed')
  }
}

async function boot(t: TestContext, overrides: Record<string, unknown> = {}): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-accounts-push-'))
  const ctx = new Context()
  await ctx.plugin(FakeIdentity)
  const identity = ctx.get('identity') as unknown as FakeIdentity
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
    ...overrides,
  })
  const world: World = {
    ctx,
    service: ctx.get('accountPriority') as AccountPriorityService,
    identity,
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

function account(id: string, overrides: Partial<FakeAccount> = {}): FakeAccount {
  return {
    id,
    provider: 'openai',
    kind: 'api_key',
    enabled: true,
    status: 'active',
    baseUrl: null,
    priority: 0,
    accessExpiresAt: null,
    ...overrides,
  }
}

test('把 identity 的可用账号与令牌快照推给 Go', async (t) => {
  const world = await boot(t, {
    upstreamBaseUrls: {
      openai: 'https://api.openai.com/v1',
      custom: 'https://custom.example.com/v1',
    },
  })
  world.identity.add(account('acc-one'), 'sk-account-one')
  world.identity.add(
    account('acc-two', {
      provider: 'custom',
      kind: 'api_key',
      baseUrl: 'https://override.example.com/v1',
      priority: 9,
    }),
    'sk-account-two',
  )
  world.identity.add(account('acc-disabled', { enabled: false }), 'sk-disabled')
  world.identity.add(account('acc-needs-reauth', { status: 'needs_reauth' }), 'sk-reauth')
  // 没有上游地址的 provider 不进快照。
  world.identity.add(account('acc-claude', { provider: 'claude' }), 'sk-claude')

  await waitFor(() => world.service.status().accounts === 2)
  const status = world.service.status()
  assert.equal(status.accounts, 2)
  assert.ok(status.accountsRevision?.startsWith('fake-accounts-'))
  assert.ok(!JSON.stringify(status).includes('sk-account'))

  const remote = await world.service.remoteStatus()
  assert.equal(remote.accounts, 2)
})

test('identity 事件触发增量重推', async (t) => {
  const world = await boot(t, {
    upstreamBaseUrls: { openai: 'https://api.openai.com/v1' },
  })
  world.identity.add(account('acc-one'), 'sk-one')
  await waitFor(() => world.service.status().accounts === 1)

  world.identity.add(account('acc-two'), 'sk-two')
  await waitFor(() => world.service.status().accounts === 2)

  world.identity.remove('acc-one')
  await waitFor(() => world.service.status().accounts === 1)
})

test('账号快照带 protocol；未声明时不带这个键', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-accounts-protocol-'))
  const logPath = join(dir, 'accounts.json')
  const ctx = new Context()
  await ctx.plugin(FakeIdentity)
  const identity = ctx.get('identity') as unknown as FakeIdentity
  const fiber = await ctx.plugin(AccountPriorityService, {
    dataPath: join(dir, 'strategies.json'),
    binaryPath: process.execPath,
    args: [FAKE, `--accounts-log=${logPath}`],
    transport: 'tcp',
    autoStart: true,
    startTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    stopTimeoutMs: 2_000,
    httpListen: '127.0.0.1:0',
    upstreamBaseUrls: { openai: 'https://api.openai.com/v1' },
  })
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true })
  })
  const service = ctx.get('accountPriority') as AccountPriorityService
  await waitFor(() => service.status().state === 'ready')

  identity.add(account('acc-with', { protocol: 'openai-chat' }), 'sk-with')
  identity.add(account('acc-without'), 'sk-without')
  await waitFor(() => service.status().accounts === 2)

  const captured = JSON.parse(await readFile(logPath, 'utf8')) as {
    accountId: string
    protocol?: string
  }[]
  const withProtocol = captured.find((item) => item.accountId === 'acc-with')
  const withoutProtocol = captured.find((item) => item.accountId === 'acc-without')
  assert.equal(withProtocol?.protocol, 'openai-chat')
  assert.ok(withoutProtocol !== undefined && !('protocol' in withoutProtocol), '未声明时快照里不该有 protocol 键')
})

test('没有 identity 时推送空快照，不阻塞 gatewayd 就绪', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-accounts-empty-'))
  const ctx = new Context()
  const fiber = await ctx.plugin(AccountPriorityService, {
    dataPath: join(dir, 'strategies.json'),
    binaryPath: process.execPath,
    args: [FAKE],
    transport: 'tcp',
    autoStart: true,
    startTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    stopTimeoutMs: 2_000,
    httpListen: '127.0.0.1:0',
  })
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true })
  })
  const service = ctx.get('accountPriority') as AccountPriorityService
  await waitFor(() => service.status().state === 'ready')
  await waitFor(() => service.status().accountsRevision !== null)
  assert.equal(service.status().accounts, 0)
})
