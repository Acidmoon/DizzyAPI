import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import CredentialsService from '../../credentials/src/index.ts'
import IdentityService, {
  isIdentityError,
  type IdentityAccount,
  type IdentityConfig,
} from '../src/index.ts'

const CLAUDE_URL = 'https://platform.claude.com/v1/oauth/token'
const OPENAI_URL = 'https://auth.openai.com/oauth/token'

interface World {
  readonly ctx: Context
  readonly identity: IdentityService
  readonly fiber: { dispose(): Promise<void> | void }
  readonly dir: string
}

async function boot(t: TestContext, overrides: IdentityConfig = {}): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath: join(dir, 'credentials.json') })
  const fiber = await ctx.plugin(IdentityService, {
    dataPath: join(dir, 'accounts.json'),
    pollIntervalMs: 3_600_000,
    refreshLeadMs: 30 * 60_000,
    refreshConcurrency: 2,
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    requestTimeoutMs: 5_000,
    ...overrides,
  })
  return { ctx, identity: ctx.get('identity') as IdentityService, fiber, dir }
}

function mockFetch(
  t: TestContext,
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): { url: string; init: RequestInit | undefined }[] {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function dueOauth(identity: IdentityService, provider: 'claude' | 'openai' = 'claude'): Promise<IdentityAccount> {
  return identity.create({
    provider,
    kind: 'oauth',
    label: `${provider} 订阅`,
    subject: 'subject-1',
    secret: {
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  })
}

function bundleOf(world: World, account: IdentityAccount): Record<string, unknown> {
  const credentials = world.ctx.get('credentials') as CredentialsService
  const raw = credentials.resolve(account.credentialRef)
  assert.ok(raw, '凭据应当存在')
  return JSON.parse(raw) as Record<string, unknown>
}

test('创建账号：账号记录里没有令牌，秘密只在 credentials 里', async (t) => {
  const world = await boot(t)
  const account = await dueOauth(world.identity)

  assert.equal(account.kind, 'oauth')
  assert.equal(account.status, 'active')
  assert.ok(!JSON.stringify(account).includes('old-access'), '账号记录不能夹带 access token')
  assert.ok(!JSON.stringify(account).includes('old-refresh'), '账号记录不能夹带 refresh token')
  assert.equal(world.identity.credentialStatus(account.id).configured, true)
  assert.deepEqual(bundleOf(world, account).accessToken, 'old-access')
})

test('API-key 账号：取得到 key，调度器不刷新', async (t) => {
  const calls = mockFetch(t, async () => {
    throw new Error('api_key 账号不该打上游')
  })
  const world = await boot(t)
  const account = await world.identity.create({
    provider: 'custom',
    kind: 'api_key',
    label: '外部 API',
    baseUrl: 'https://example.com/v1/',
    priority: 12,
    secret: { apiKey: 'sk-test' },
  })

  assert.equal(await world.identity.getAccessToken(account.id), 'sk-test')
  assert.equal(account.refreshDueAt, null)
  assert.equal(account.baseUrl, 'https://example.com/v1')
  assert.equal(account.priority, 12)
  const updated = await world.identity.update(account.id, { baseUrl: null, priority: 3 })
  assert.equal(updated.baseUrl, null)
  assert.equal(updated.priority, 3)
  await world.identity.runRefreshPass()
  assert.equal(calls.length, 0)
})

test('protocol：创建落库；旧快照缺字段读出 null（不拒绝整份文件）', async (t) => {
  const first = await boot(t)
  const account = await first.identity.create({
    provider: 'openai',
    kind: 'api_key',
    label: '协议账号',
    protocol: 'openai-chat',
    secret: { apiKey: 'sk-protocol' },
  })
  assert.equal(account.protocol, 'openai-chat')
  await first.fiber.dispose()

  // 抹掉 protocol 字段，模拟升级前的旧快照。
  const path = join(first.dir, 'accounts.json')
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
    accounts: Record<string, Record<string, unknown>>
  }
  delete snapshot.accounts[account.id]?.protocol
  await writeFile(path, JSON.stringify(snapshot), 'utf8')

  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath: join(first.dir, 'credentials.json') })
  const fiber = await ctx.plugin(IdentityService, { dataPath: path })
  t.after(() => fiber.dispose())

  const identity = ctx.get('identity') as IdentityService
  assert.equal(identity.get(account.id).protocol, null, '缺 protocol 的旧快照按 null 读出')
})

test('protocol：update 可改可清空，非法值明确失败', async (t) => {
  const world = await boot(t)
  const account = await world.identity.create({
    provider: 'custom',
    kind: 'api_key',
    label: 'x',
    secret: { apiKey: 'sk-1' },
  })
  assert.equal(account.protocol, null, '未声明时默认 null')

  const changed = await world.identity.update(account.id, { protocol: 'anthropic' })
  assert.equal(changed.protocol, 'anthropic')

  const cleared = await world.identity.update(account.id, { protocol: null })
  assert.equal(cleared.protocol, null)

  await assert.rejects(
    world.identity.create({
      provider: 'custom',
      kind: 'api_key',
      label: 'y',
      protocol: 'bogus' as never,
    }),
    (error: unknown) => isIdentityError(error) && error.code === 'IDENTITY_ACCOUNT_INVALID',
  )
  await assert.rejects(
    world.identity.update(account.id, { protocol: 'bogus' as never }),
    (error: unknown) => isIdentityError(error) && error.code === 'IDENTITY_ACCOUNT_INVALID',
  )
  assert.equal(world.identity.get(account.id).protocol, null)
})

test('models / modelMap：创建落库；旧快照缺字段读出 null（不拒绝整份文件）', async (t) => {
  const first = await boot(t)
  const account = await first.identity.create({
    provider: 'openai',
    kind: 'api_key',
    label: '模型账号',
    models: ['gpt-5', 'gpt-5-codex', 'gpt-5'],
    modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
    secret: { apiKey: 'sk-models' },
  })
  assert.deepEqual(account.models, ['gpt-5', 'gpt-5-codex'], '去重且保序')
  assert.deepEqual(account.modelMap, { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' })
  await first.fiber.dispose()

  // 抹掉两个字段，模拟升级前的旧快照。
  const path = join(first.dir, 'accounts.json')
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
    accounts: Record<string, Record<string, unknown>>
  }
  delete snapshot.accounts[account.id]?.models
  delete snapshot.accounts[account.id]?.modelMap
  await writeFile(path, JSON.stringify(snapshot), 'utf8')

  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath: join(first.dir, 'credentials.json') })
  const fiber = await ctx.plugin(IdentityService, { dataPath: path })
  t.after(() => fiber.dispose())

  const identity = ctx.get('identity') as IdentityService
  assert.equal(identity.get(account.id).models, null, '缺 models 的旧快照按 null 读出')
  assert.equal(identity.get(account.id).modelMap, null, '缺 modelMap 的旧快照按 null 读出')
})

test('models / modelMap：update 可改可清空，空数组 / 空对象归一成 null，非法值被拒', async (t) => {
  const world = await boot(t)
  const account = await world.identity.create({
    provider: 'custom',
    kind: 'api_key',
    label: 'x',
    secret: { apiKey: 'sk-1' },
  })
  assert.equal(account.models, null, '未声明时默认 null')
  assert.equal(account.modelMap, null)

  const changed = await world.identity.update(account.id, {
    models: ['  gpt-5 ', '', 'gpt-5', 'o3'],
    modelMap: { 'gpt-5': 'gpt-5-2025', '  ': 'skip', empty: '   ' },
  })
  assert.deepEqual(changed.models, ['gpt-5', 'o3'], 'trim、丢弃空串、去重')
  assert.deepEqual(changed.modelMap, { 'gpt-5': 'gpt-5-2025' }, '空键 / 空值被丢弃')

  const cleared = await world.identity.update(account.id, { models: [], modelMap: {} })
  assert.equal(cleared.models, null, '空数组归一成 null')
  assert.equal(cleared.modelMap, null, '空对象归一成 null')

  const invalid = (error: unknown): boolean =>
    isIdentityError(error) && error.code === 'IDENTITY_ACCOUNT_INVALID'
  await assert.rejects(
    world.identity.create({ provider: 'custom', kind: 'api_key', label: 'y', models: [1] as never }),
    invalid,
  )
  await assert.rejects(
    world.identity.create({ provider: 'custom', kind: 'api_key', label: 'z', models: ['bad\nname'] }),
    invalid,
  )
  await assert.rejects(
    world.identity.create({ provider: 'custom', kind: 'api_key', label: 'w', models: ['x'.repeat(201)] }),
    invalid,
  )
  await assert.rejects(
    world.identity.update(account.id, { modelMap: { key: 1 } as never }),
    invalid,
  )
  assert.equal(world.identity.get(account.id).models, null, '非法值不会写进账号')
})

test('Claude RT 刷新：请求正确，轮换后的两个令牌都落盘', async (t) => {
  const calls = mockFetch(t, async () =>
    ok({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer' }),
  )
  const world = await boot(t)
  let refreshed = 0
  world.ctx.on('identity/account-refreshed', () => {
    refreshed += 1
  })

  const account = await dueOauth(world.identity)
  await world.identity.runRefreshPass()

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, CLAUDE_URL)
  const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>
  assert.equal(body.grant_type, 'refresh_token')
  assert.equal(body.refresh_token, 'old-refresh')

  const after = world.identity.get(account.id)
  assert.equal(after.status, 'active')
  assert.equal(after.failureCount, 0)
  assert.ok(after.lastRefreshAt)
  assert.ok(Date.parse(after.accessExpiresAt as string) > Date.now())
  assert.equal(refreshed, 1)

  const bundle = bundleOf(world, account)
  assert.equal(bundle.accessToken, 'new-access')
  assert.equal(bundle.refreshToken, 'new-refresh')
})

test('刷新响应没有新 RT：保留旧 RT', async (t) => {
  mockFetch(t, async () => ok({ access_token: 'new-access', expires_in: 3600 }))
  const world = await boot(t)
  const account = await dueOauth(world.identity)

  await world.identity.runRefreshPass()

  assert.equal(bundleOf(world, account).refreshToken, 'old-refresh')
})

test('OpenAI RT 刷新：form body 与默认 client_id', async (t) => {
  const calls = mockFetch(t, async () =>
    ok({ access_token: 'openai-access', refresh_token: 'openai-refresh', expires_in: 600 }),
  )
  const world = await boot(t)
  await dueOauth(world.identity, 'openai')

  await world.identity.runRefreshPass()

  assert.equal(calls[0].url, OPENAI_URL)
  const form = new URLSearchParams(String(calls[0].init?.body))
  assert.equal(form.get('grant_type'), 'refresh_token')
  assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann')
})

test('invalid_grant：转为 needs_reauth，之后不再被调度', async (t) => {
  const calls = mockFetch(t, async () =>
    new Response(JSON.stringify({ error: 'invalid_grant' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  )
  const world = await boot(t)
  const account = await dueOauth(world.identity)

  await world.identity.runRefreshPass()
  const after = world.identity.get(account.id)
  assert.equal(after.status, 'needs_reauth')
  assert.match(after.lastError ?? '', /400/)
  assert.match(after.lastError ?? '', /invalid_grant/)

  await world.identity.runRefreshPass()
  assert.equal(calls.length, 1, 'needs_reauth 的账号不该继续打上游')
})

test('5xx：退避期间不重试，退避过后恢复', async (t) => {
  let mode: 'fail' | 'ok' = 'fail'
  const calls = mockFetch(t, async () => {
    if (mode === 'fail') return new Response('upstream down', { status: 500 })
    return ok({ access_token: 'recovered', refresh_token: 'rotated', expires_in: 3600 })
  })
  const world = await boot(t)
  const account = await dueOauth(world.identity)

  await world.identity.runRefreshPass()
  const failed = world.identity.get(account.id)
  assert.equal(failed.status, 'active')
  assert.equal(failed.failureCount, 1)
  assert.ok(failed.backoffUntil)
  assert.ok(Date.parse(failed.backoffUntil as string) > Date.now())

  await world.identity.runRefreshPass()
  assert.equal(calls.length, 1, '退避期内不应重试')

  mode = 'ok'
  await world.identity.runRefreshPass(Date.now() + 60_000)
  const recovered = world.identity.get(account.id)
  assert.equal(recovered.failureCount, 0)
  assert.equal(recovered.lastError, null)
  assert.equal(bundleOf(world, account).accessToken, 'recovered')
})

test('手动刷新失败会 reject，并留下可读原因', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 }))
  const world = await boot(t)
  const account = await dueOauth(world.identity)

  await assert.rejects(world.identity.refreshNow(account.id), (error: unknown) => {
    assert.ok(isIdentityError(error))
    assert.equal(error.code, 'IDENTITY_ACCOUNT_NEEDS_REAUTH')
    return true
  })
  assert.equal(world.identity.get(account.id).status, 'needs_reauth')
})

test('并发刷新只打一次上游（单飞）', async (t) => {
  let release: (value: Response) => void = () => undefined
  const gate = new Promise<Response>((resolve) => {
    release = resolve
  })
  let calls = 0
  mockFetch(t, async () => {
    calls += 1
    return gate
  })
  const world = await boot(t)
  const account = await dueOauth(world.identity)

  const first = world.identity.refreshNow(account.id)
  const second = world.identity.refreshNow(account.id)
  release(ok({ access_token: 'fresh', refresh_token: 'fresh-rt', expires_in: 3600 }))

  await Promise.all([first, second])
  assert.equal(calls, 1)
})

test('importCredentials 能把 needs_reauth 恢复成 active', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }))
  const world = await boot(t)
  const account = await dueOauth(world.identity)
  await world.identity.runRefreshPass()
  assert.equal(world.identity.get(account.id).status, 'needs_reauth')

  const restored = await world.identity.importCredentials(account.id, {
    accessToken: 'manual-access',
    refreshToken: 'manual-refresh',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  })
  assert.equal(restored.status, 'active')
  assert.equal(restored.failureCount, 0)
  assert.equal(restored.lastError, null)
  assert.equal(bundleOf(world, account).accessToken, 'manual-access')
  assert.equal(bundleOf(world, account).refreshToken, 'manual-refresh')
})

test('删除账号会同时清掉凭据', async (t) => {
  const world = await boot(t)
  const account = await dueOauth(world.identity)
  const ref = account.credentialRef

  await world.identity.remove(account.id)

  assert.deepEqual(world.identity.list(), [])
  const credentials = world.ctx.get('credentials') as CredentialsService
  assert.equal(credentials.describe(ref).configured, false)
})

test('账号文件损坏：构造直接失败，不静默重建', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-identity-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'accounts.json'), '{ not json', 'utf8')

  const ctx = new Context()
  await assert.rejects(
    async () => {
      await ctx.plugin(IdentityService, { dataPath: join(dir, 'accounts.json') })
    },
    (error: unknown) => {
      assert.ok(isIdentityError(error))
      assert.equal(error.code, 'IDENTITY_STORE_CORRUPT')
      return true
    },
  )
})

test('持久化：换一个上下文仍然读得到账号与凭据', async (t) => {
  const first = await boot(t)
  const account = await dueOauth(first.identity)
  await first.fiber.dispose()

  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath: join(first.dir, 'credentials.json') })
  const fiber = await ctx.plugin(IdentityService, { dataPath: join(first.dir, 'accounts.json') })
  t.after(() => fiber.dispose())

  const identity = ctx.get('identity') as IdentityService
  const restored = identity.get(account.id)
  assert.equal(restored.label, account.label)
  assert.equal(identity.credentialStatus(account.id).configured, true)
})

test('lastTest*：旧快照缺字段读出 null，不拒绝整份文件', async (t) => {
  const first = await boot(t)
  const account = await first.identity.create({
    provider: 'openai',
    kind: 'api_key',
    label: '旧快照',
    secret: { apiKey: 'sk-old' },
  })
  assert.equal(account.lastTestAt, null)
  assert.equal(account.lastTestOk, null)
  assert.equal(account.lastTestError, null)
  assert.equal(account.lastTestLatencyMs, null)
  await first.fiber.dispose()

  const path = join(first.dir, 'accounts.json')
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as {
    accounts: Record<string, Record<string, unknown>>
  }
  delete snapshot.accounts[account.id]?.lastTestAt
  delete snapshot.accounts[account.id]?.lastTestOk
  delete snapshot.accounts[account.id]?.lastTestError
  delete snapshot.accounts[account.id]?.lastTestLatencyMs
  await writeFile(path, JSON.stringify(snapshot), 'utf8')

  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath: join(first.dir, 'credentials.json') })
  const fiber = await ctx.plugin(IdentityService, { dataPath: path })
  t.after(() => fiber.dispose())

  const identity = ctx.get('identity') as IdentityService
  const restored = identity.get(account.id)
  assert.equal(restored.lastTestAt, null)
  assert.equal(restored.lastTestOk, null)
  assert.equal(restored.lastTestError, null)
  assert.equal(restored.lastTestLatencyMs, null)
})

test('recordTestResult：落盘、读回、不发 account-updated', async (t) => {
  const world = await boot(t)
  const account = await world.identity.create({
    provider: 'openai',
    kind: 'api_key',
    label: '测试结果',
    secret: { apiKey: 'sk-test-result' },
  })

  let updated = 0
  world.ctx.on('identity/account-updated', () => {
    updated += 1
  })

  const testedAt = '2026-10-21T01:02:03.000Z'
  const recorded = await world.identity.recordTestResult(account.id, {
    ok: false,
    latencyMs: 321.6,
    error: 'HTTP 401：[REDACTED]',
    testedAt,
  })
  assert.equal(recorded.lastTestAt, testedAt)
  assert.equal(recorded.lastTestOk, false)
  assert.equal(recorded.lastTestError, 'HTTP 401：[REDACTED]')
  assert.equal(recorded.lastTestLatencyMs, 322)
  assert.equal(updated, 0, '测试结果不影响调度，不该推账号更新事件')

  await assert.rejects(
    world.identity.recordTestResult(account.id, { ok: true, latencyMs: -1, error: null }),
    (error: unknown) => isIdentityError(error) && error.code === 'IDENTITY_ACCOUNT_INVALID',
  )
  await assert.rejects(
    world.identity.recordTestResult(account.id, { ok: true, latencyMs: 1, error: null, testedAt: 'nope' }),
    (error: unknown) => isIdentityError(error) && error.code === 'IDENTITY_ACCOUNT_INVALID',
  )

  await world.fiber.dispose()
  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath: join(world.dir, 'credentials.json') })
  const fiber = await ctx.plugin(IdentityService, { dataPath: join(world.dir, 'accounts.json') })
  t.after(() => fiber.dispose())
  const identity = ctx.get('identity') as IdentityService
  const restored = identity.get(account.id)
  assert.equal(restored.lastTestAt, testedAt)
  assert.equal(restored.lastTestOk, false)
  assert.equal(restored.lastTestError, 'HTTP 401：[REDACTED]')
  assert.equal(restored.lastTestLatencyMs, 322)
})

test('卸载插件：服务与调度一起消失（D5）', async (t) => {
  const world = await boot(t)
  await world.fiber.dispose()
  assert.equal(world.ctx.get('identity'), undefined)
})
