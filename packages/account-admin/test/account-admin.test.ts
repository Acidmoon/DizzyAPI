import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context, ValidationError } from 'cordis'
import CredentialsService from '../../credentials/src/index.ts'
import IdentityService, { type IdentityConfig } from '../../identity/src/index.ts'
import AccountAdminService, {
  ACCOUNT_ADMIN_CONFIG_SCHEMA,
  type AccountAdminConfig,
  type AccountAdminService as AccountAdminServiceType,
} from '../src/index.ts'

const ACTOR = '@dizzyapi/plugin-admin'

interface World {
  readonly ctx: Context
  readonly admin: AccountAdminServiceType
  readonly identity: IdentityService
  readonly credentials: CredentialsService
  readonly dir: string
  readonly disposeAdmin: () => Promise<void>
  readonly dispose: () => Promise<void>
}

interface BootOptions {
  readonly dir?: string
  readonly admin?: AccountAdminConfig
  readonly identity?: IdentityConfig
}

async function boot(t: TestContext, options: BootOptions = {}): Promise<World> {
  const dir =
    options.dir ??
    (await mkdtemp(join(tmpdir(), 'dizzyapi-account-admin-')))

  const ctx = new Context()
  const credentialsFiber = await ctx.plugin(CredentialsService, {
    dataPath: join(dir, 'credentials.json'),
  })
  const identityFiber = await ctx.plugin(IdentityService, {
    dataPath: join(dir, 'accounts.json'),
    pollIntervalMs: 3_600_000,
    refreshLeadMs: 30 * 60_000,
    refreshConcurrency: 1,
    retryBaseMs: 1_000,
    retryMaxMs: 10_000,
    requestTimeoutMs: 5_000,
    ...options.identity,
  })
  const adminFiber = await ctx.plugin(AccountAdminService, {
    adminPlugins: [ACTOR],
    maxBatchSize: 100,
    ...options.admin,
  })

  let adminDisposed = false
  let disposed = false
  const disposeAdmin = async (): Promise<void> => {
    if (adminDisposed) return
    adminDisposed = true
    await adminFiber.dispose()
  }
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await disposeAdmin()
    await identityFiber.dispose()
    await credentialsFiber.dispose()
  }
  t.after(dispose)
  if (options.dir === undefined) {
    t.after(() => rm(dir, { recursive: true, force: true }))
  }

  return {
    ctx,
    admin: ctx.get('accountAdmin') as AccountAdminServiceType,
    identity: ctx.get('identity') as IdentityService,
    credentials: ctx.get('credentials') as CredentialsService,
    dir,
    disposeAdmin,
    dispose,
  }
}

function hasCode(expected: string) {
  return (error: unknown): boolean => {
    assert.equal((error as { code?: unknown } | null)?.code, expected)
    return true
  }
}

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.signature`
}

function storedBundle(world: World, id: string): Record<string, unknown> {
  const account = world.identity.get(id)
  const raw = world.credentials.resolve(account.credentialRef)
  assert.ok(raw, '凭据应当存在')
  return JSON.parse(raw) as Record<string, unknown>
}

function assertNoSecrets(value: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(value)
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `返回值不能包含秘密：${secret}`)
  }
}

const CLAUDE_CREDENTIALS = (): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'claude-access-token',
      refreshToken: 'claude-refresh-token',
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  })

test('创建 API-key 账号：返回元数据，凭据尚未配置', async (t) => {
  const world = await boot(t)
  const view = await world.admin.create(ACTOR, {
    provider: 'custom',
    kind: 'api_key',
    label: '外部 API',
    baseUrl: 'https://upstream.example.com/v1/',
    priority: 8,
  })

  assert.equal(view.kind, 'api_key')
  assert.equal(view.enabled, true)
  assert.equal(view.status, 'active')
  assert.equal(view.credentialConfigured, false)
  assert.equal(view.baseUrl, 'https://upstream.example.com/v1')
  assert.equal(view.priority, 8)
  assert.equal(world.identity.list().length, 1)
  assertNoSecrets(view, ['accessToken', 'refreshToken', 'apiKey'])

  const updated = await world.admin.update(ACTOR, view.id, { baseUrl: null, priority: 2 })
  assert.equal(updated.baseUrl, null)
  assert.equal(updated.priority, 2)
})

test('protocol：create 透传、UPDATE_KEYS 接受、toView 与 catalog shapes 都含它', async (t) => {
  const world = await boot(t)
  const view = await world.admin.create(ACTOR, {
    provider: 'openai',
    kind: 'api_key',
    label: '协议账号',
    protocol: 'openai-responses',
  })
  assert.equal(view.protocol, 'openai-responses')
  assert.equal(world.identity.get(view.id).protocol, 'openai-responses')

  const updated = await world.admin.update(ACTOR, view.id, { protocol: 'anthropic' })
  assert.equal(updated.protocol, 'anthropic')
  const gemini = await world.admin.update(ACTOR, view.id, { protocol: 'gemini' })
  assert.equal(gemini.protocol, 'gemini', 'gemini 能通过门面写进 identity')
  assert.equal(world.identity.get(view.id).protocol, 'gemini')
  const cleared = await world.admin.update(ACTOR, view.id, { protocol: null })
  assert.equal(cleared.protocol, null)

  // 未声明时 toView 给 null。
  const plain = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '无协议' })
  assert.equal(plain.protocol, null)

  // 非法值明确失败，不静默降级。
  await assert.rejects(
    world.admin.create(ACTOR, {
      provider: 'custom',
      kind: 'api_key',
      label: 'z',
      protocol: 'bogus' as never,
    }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )

  assert.ok('protocol' in AccountAdminService.catalog.shapes.AccountView.fields)
})

test('models / modelMap：create 透传、UPDATE_KEYS 接受、toView 与 catalog shapes 都含它们', async (t) => {
  const world = await boot(t)
  const view = await world.admin.create(ACTOR, {
    provider: 'openai',
    kind: 'api_key',
    label: '模型账号',
    models: ['gpt-5', 'gpt-5-codex'],
    modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
  })
  assert.deepEqual(view.models, ['gpt-5', 'gpt-5-codex'])
  assert.deepEqual(view.modelMap, { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' })
  assert.deepEqual(world.identity.get(view.id).models, ['gpt-5', 'gpt-5-codex'], 'identity 是唯一写者')

  const updated = await world.admin.update(ACTOR, view.id, { models: ['o3'], modelMap: { o3: 'o3-mini' } })
  assert.deepEqual(updated.models, ['o3'])
  assert.deepEqual(updated.modelMap, { o3: 'o3-mini' })
  const cleared = await world.admin.update(ACTOR, view.id, { models: null, modelMap: null })
  assert.equal(cleared.models, null)
  assert.equal(cleared.modelMap, null)

  // 未声明时 toView 给 null。
  const plain = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '无模型' })
  assert.equal(plain.models, null)
  assert.equal(plain.modelMap, null)

  // 非法值明确失败，不静默降级。
  await assert.rejects(
    world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: 'z', models: [1] as never }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
  await assert.rejects(
    world.admin.update(ACTOR, view.id, { modelMap: { key: 1 } as never }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )

  assert.ok('models' in AccountAdminService.catalog.shapes.AccountView.fields)
  assert.ok('modelMap' in AccountAdminService.catalog.shapes.AccountView.fields)
})

test('Claude .credentials.json：嵌套 claudeAiOauth、毫秒 expiresAt、scopes 拼成 scope', async (t) => {
  const world = await boot(t)
  const expiresAt = Date.now() + 3_600_000
  const payload = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'claude-access-token',
      refreshToken: 'claude-refresh-token',
      expiresAt,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
    },
  })

  const view = await world.admin.create(ACTOR, {
    provider: 'claude',
    kind: 'oauth',
    label: 'Claude 订阅',
    credential: { payload },
  })

  assert.equal(view.credentialConfigured, true)
  assert.equal(view.accessExpiresAt, new Date(expiresAt).toISOString())
  assertNoSecrets(view, ['claude-access-token', 'claude-refresh-token'])

  const bundle = storedBundle(world, view.id)
  assert.equal(bundle.accessToken, 'claude-access-token')
  assert.equal(bundle.refreshToken, 'claude-refresh-token')
  assert.equal(bundle.scope, 'user:inference user:profile')
})

test('OpenAI auth.json：id_token 只解出 email / subject，不保存 id_token 本体', async (t) => {
  const world = await boot(t)
  const account = await world.admin.create(ACTOR, {
    provider: 'openai',
    kind: 'oauth',
    label: 'OpenAI 订阅',
  })
  const idToken = jwt({
    email: 'dev@example.com',
    sub: 'user-1',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
  })
  const payload = JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: 'openai-access-token',
      refresh_token: 'openai-refresh-token',
      account_id: 'acct-1',
    },
    last_refresh: new Date().toISOString(),
  })

  const view = await world.admin.importCredentials(ACTOR, account.id, { payload })

  assert.equal(view.email, 'dev@example.com')
  assert.equal(view.subject, 'acct-1')
  assert.equal(view.credentialConfigured, true)
  assertNoSecrets(view, ['openai-access-token', 'openai-refresh-token', idToken])

  const bundle = storedBundle(world, account.id)
  assert.equal(bundle.accessToken, 'openai-access-token')
  assert.equal(bundle.refreshToken, 'openai-refresh-token')
  assert.equal(bundle.idToken, undefined)
})

test('OpenAI auth.json 的 API-key 模式', async (t) => {
  const world = await boot(t)
  const view = await world.admin.create(ACTOR, {
    provider: 'openai',
    kind: 'api_key',
    label: 'OpenAI key',
    credential: { payload: JSON.stringify({ OPENAI_API_KEY: 'sk-openai-key' }) },
  })

  assert.equal(view.credentialConfigured, true)
  assert.equal(storedBundle(world, view.id).apiKey, 'sk-openai-key')
  assertNoSecrets(view, ['sk-openai-key'])
})

test('纯文本 API key：自动识别为 custom / api_key，预检不回显值', async (t) => {
  const world = await boot(t)
  const preview = world.admin.previewImport({ payload: 'sk-plain-text-key' })

  assert.deepEqual(preview, {
    format: 'api-key',
    provider: 'custom',
    kind: 'api_key',
    email: null,
    subject: null,
    expiresAt: null,
    hasAccessToken: false,
    hasRefreshToken: false,
    hasApiKey: true,
  })
  assertNoSecrets(preview, ['sk-plain-text-key'])

  const view = await world.admin.create(ACTOR, {
    provider: 'custom',
    kind: 'api_key',
    label: '纯文本 key',
    credential: { payload: 'sk-plain-text-key' },
  })
  assert.equal(storedBundle(world, view.id).apiKey, 'sk-plain-text-key')
})

test('update / enable / disable / remove；秘密随账号删除一起清理', async (t) => {
  const world = await boot(t)
  const created = await world.admin.create(ACTOR, {
    provider: 'custom',
    kind: 'api_key',
    label: '改名前',
    credential: { payload: 'sk-lifecycle-key' },
  })

  const updated = await world.admin.update(ACTOR, created.id, {
    label: '改名后',
    email: 'ops@example.com',
  })
  assert.equal(updated.label, '改名后')
  assert.equal(updated.email, 'ops@example.com')
  assert.notEqual(updated.updatedAt, created.updatedAt)
  assertNoSecrets(updated, ['sk-lifecycle-key'])

  // 空 patch 是幂等的读，不制造一次写盘。
  const unchanged = await world.admin.update(ACTOR, created.id, {})
  assert.equal(unchanged.updatedAt, updated.updatedAt)

  assert.equal((await world.admin.disable(ACTOR, created.id)).enabled, false)
  assert.equal((await world.admin.enable(ACTOR, created.id)).enabled, true)
  assert.equal(world.admin.credentialStatus(created.id).configured, true)

  await world.admin.remove(ACTOR, created.id)
  assert.equal(world.identity.list().length, 0)
  assert.equal(world.credentials.describe(created.credentialRef).configured, false)
  assert.throws(() => world.admin.get(created.id), hasCode('IDENTITY_ACCOUNT_NOT_FOUND'))
})

test('授权：写操作要求白名单 actor，读操作不限权', async (t) => {
  const world = await boot(t)
  const input = { provider: 'custom', kind: 'api_key', label: 'x' } as const

  await assert.rejects(world.admin.create('@dizzyapi/plugin-intruder', input), hasCode('ACCOUNT_ADMIN_ACTOR_FORBIDDEN'))
  await assert.rejects(world.admin.create('   ', input), hasCode('ACCOUNT_ADMIN_ACTOR_REQUIRED'))
  await assert.rejects(
    world.admin.importAccounts('@dizzyapi/plugin-intruder', { items: [{ payload: 'sk-x' }] }),
    hasCode('ACCOUNT_ADMIN_ACTOR_FORBIDDEN'),
  )

  assert.deepEqual(world.admin.list(), [])
})

test('非法格式：JSON、字段、provider 冲突、kind 冲突都有可读错误', async (t) => {
  const world = await boot(t)

  await assert.rejects(
    world.admin.create(ACTOR, {
      provider: 'claude',
      kind: 'oauth',
      label: '坏 JSON',
      credential: { payload: '{ nope' },
    }),
    hasCode('ACCOUNT_ADMIN_IMPORT_JSON_INVALID'),
  )

  assert.throws(
    () => world.admin.previewImport({ payload: JSON.stringify({ foo: 'bar' }) }),
    hasCode('ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID'),
  )

  await assert.rejects(
    world.admin.create(ACTOR, {
      provider: 'openai',
      kind: 'oauth',
      label: 'provider 冲突',
      credential: { payload: CLAUDE_CREDENTIALS() },
    }),
    hasCode('ACCOUNT_ADMIN_IMPORT_CONFLICT'),
  )

  // credential 自己声明的 provider 与账号不一致，同样拒绝。
  await assert.rejects(
    world.admin.create(ACTOR, {
      provider: 'claude',
      kind: 'oauth',
      label: 'credential provider 冲突',
      credential: { payload: CLAUDE_CREDENTIALS(), provider: 'openai' },
    }),
    hasCode('ACCOUNT_ADMIN_IMPORT_CONFLICT'),
  )

  await assert.rejects(
    world.admin.create(ACTOR, {
      provider: 'custom',
      kind: 'oauth',
      label: 'custom oauth',
    }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )

  await assert.rejects(
    world.admin.create(ACTOR, {
      provider: 'custom',
      kind: 'api_key',
      label: '带空白的 key',
      credential: { payload: 'sk-line1\nsk-line2' },
    }),
    hasCode('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID'),
  )

  assert.throws(
    () => world.admin.previewImport({ payload: JSON.stringify({ access_token: 'token-only' }) }),
    hasCode('ACCOUNT_ADMIN_IMPORT_PROVIDER_REQUIRED'),
  )

  // 纯文本不能硬塞进 claude-oauth。
  assert.throws(
    () => world.admin.previewImport({ format: 'claude-oauth', payload: 'sk-plain' }),
    hasCode('ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID'),
  )
})

test('导入凭据时 kind 必须与账号一致：API key 导入 OAuth 账号被拒绝', async (t) => {
  const world = await boot(t)
  const account = await world.admin.create(ACTOR, {
    provider: 'claude',
    kind: 'oauth',
    label: 'Claude 订阅',
  })

  await assert.rejects(
    world.admin.importCredentials(ACTOR, account.id, { payload: 'sk-api-key' }),
    hasCode('ACCOUNT_ADMIN_IMPORT_CONFLICT'),
  )
  assert.equal(world.admin.credentialStatus(account.id).configured, false)
})

test('bulkImport：逐项结果，坏条目不影响好条目；结果与错误都不夹带秘密', async (t) => {
  const world = await boot(t)
  const result = await world.admin.importAccounts(ACTOR, {
    defaults: { provider: 'custom', kind: 'api_key', labelPrefix: '批量' },
    items: [
      { payload: 'sk-bulk-1' },
      { payload: 'sk-bulk-2', label: '显式名字' },
      { payload: '{ nope' },
      { payload: JSON.stringify({ access_token: 'not-an-api-key' }) },
    ],
  })

  assert.equal(result.total, 4)
  assert.equal(result.created, 2)
  assert.equal(result.failed, 2)
  assert.deepEqual(
    result.items.map((item) => item.ok),
    [true, true, false, false],
  )
  assert.equal(result.items[0]?.account?.label, '批量 #1')
  assert.equal(result.items[1]?.account?.label, '显式名字')
  assert.equal(result.items[2]?.error?.code, 'ACCOUNT_ADMIN_IMPORT_JSON_INVALID')
  assert.equal(result.items[3]?.error?.code, 'ACCOUNT_ADMIN_IMPORT_CONFLICT')
  assert.equal(world.identity.list().length, 2)
  assertNoSecrets(result, ['sk-bulk-1', 'sk-bulk-2', 'not-an-api-key'])
})

test('bulkImport：超过 maxBatchSize、空数组、未知 defaults 字段都拒绝', async (t) => {
  const world = await boot(t, { admin: { maxBatchSize: 2 } })

  await assert.rejects(
    world.admin.importAccounts(ACTOR, {
      items: [{ payload: 'sk-1' }, { payload: 'sk-2' }, { payload: 'sk-3' }],
    }),
    hasCode('ACCOUNT_ADMIN_IMPORT_TOO_LARGE'),
  )
  await assert.rejects(
    world.admin.importAccounts(ACTOR, { items: [] }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
  await assert.rejects(
    world.admin.importAccounts(ACTOR, {
      defaults: { nope: true } as never,
      items: [{ payload: 'sk-1' }],
    }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
})

test('list 过滤：provider / kind / enabled / status / search', async (t) => {
  const world = await boot(t)
  await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '外部 key' })
  const claude = await world.admin.create(ACTOR, {
    provider: 'claude',
    kind: 'oauth',
    label: 'Claude 订阅',
    subject: 'claude-subject',
  })
  await world.admin.create(ACTOR, { provider: 'openai', kind: 'oauth', label: 'OpenAI 订阅' })
  await world.admin.disable(ACTOR, claude.id)

  assert.equal(world.admin.list({ provider: 'claude' }).length, 1)
  assert.equal(world.admin.list({ kind: 'oauth' }).length, 2)
  assert.equal(world.admin.list({ enabled: false }).length, 1)
  assert.equal(world.admin.list({ status: 'active' }).length, 3)
  assert.equal(world.admin.list({ search: 'claude-subject' }).length, 1)
  assert.equal(world.admin.list({ search: '订阅' }).length, 2)

  assert.throws(() => world.admin.list({ nope: true } as never), hasCode('ACCOUNT_ADMIN_INPUT_INVALID'))
})

test('持久化：换一个上下文后账号元数据与凭据都还在', async (t) => {
  const first = await boot(t)
  const view = await first.admin.create(ACTOR, {
    provider: 'custom',
    kind: 'api_key',
    label: '持久化账号',
    credential: { payload: 'sk-persisted-key' },
  })
  await first.dispose()

  const second = await boot(t, { dir: first.dir })
  const restored = second.admin.get(view.id)
  assert.equal(restored.label, '持久化账号')
  assert.equal(restored.credentialConfigured, true)
  assert.equal(storedBundle(second, view.id).apiKey, 'sk-persisted-key')
})

test('D5：禁用 / 卸载后服务消失，identity 与调度不受影响', async (t) => {
  const world = await boot(t)
  assert.ok(world.ctx.get('accountAdmin'))
  assert.ok(world.ctx.get('identity'))

  await world.disposeAdmin()
  assert.equal(world.ctx.get('accountAdmin'), undefined)
  assert.ok(world.ctx.get('identity'), 'identity 不该被账号管理插件带走')

  await world.dispose()
})

test('依赖未满足时停在 PENDING：没有 identity 就不构造服务', async (t) => {
  const ctx = new Context()
  const fiber = ctx.plugin(AccountAdminService, { adminPlugins: [ACTOR] })
  t.after(() => fiber.dispose())

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ctx.get('accountAdmin'), undefined)
})

// ───────────────────────── 运营字段：标签 / 权重 / 并发 / 健康 ─────────────────────────

test('标签 / 权重 / 并发：UPDATE_KEYS 接受、AccountView 带出、health 走独立方法', async (t) => {
  const world = await boot(t)
  const view = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '运营字段' })

  // 新账号的默认值：标签空、权重 / 并发未声明、健康未知。
  assert.deepEqual(view.labels, [])
  assert.equal(view.weight, null)
  assert.equal(view.concurrency, null)
  assert.equal(view.health, 'unknown')
  assert.equal(view.autoDisabledAt, null)
  assert.equal(view.autoDisabledReason, null)
  assert.equal(view.lastUsedAt, null)

  const updated = await world.admin.update(ACTOR, view.id, {
    labels: ['tier:pro', 'team:ops'],
    weight: 2,
    concurrency: 5,
  })
  assert.deepEqual(updated.labels, ['tier:pro', 'team:ops'])
  assert.equal(updated.weight, 2)
  assert.equal(updated.concurrency, 5)

  // identity 仍是唯一写者：门面只转发。
  const record = world.identity.get(view.id)
  assert.deepEqual(record.labels, ['tier:pro', 'team:ops'])
  assert.equal(record.weight, 2)
  assert.equal(record.concurrency, 5)

  // health 不在 UPDATE_KEYS：语义不同，必须走 setHealth。
  await assert.rejects(
    world.admin.update(ACTOR, view.id, { health: 'healthy' } as never),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
  assert.equal((await world.admin.setHealth(ACTOR, view.id, 'degraded')).health, 'degraded')
  await assert.rejects(
    world.admin.setHealth(ACTOR, view.id, 'sick' as never),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )

  // 非法值明确失败，不静默降级。
  await assert.rejects(world.admin.update(ACTOR, view.id, { weight: 0 }), hasCode('ACCOUNT_ADMIN_INPUT_INVALID'))
  await assert.rejects(
    world.admin.update(ACTOR, view.id, { concurrency: 0 }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
  await assert.rejects(
    world.admin.update(ACTOR, view.id, { labels: [1] as never }),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )

  // null = 清空。
  const cleared = await world.admin.update(ACTOR, view.id, { labels: null, weight: null, concurrency: null })
  assert.deepEqual(cleared.labels, [])
  assert.equal(cleared.weight, null)
  assert.equal(cleared.concurrency, null)

  assert.ok('labels' in AccountAdminService.catalog.shapes.AccountView.fields)
  assert.ok('weight' in AccountAdminService.catalog.shapes.AccountView.fields)
  assert.ok('concurrency' in AccountAdminService.catalog.shapes.AccountView.fields)
  assert.ok('health' in AccountAdminService.catalog.shapes.AccountView.fields)
})

test('list 过滤：多标签 AND、health、auto_disabled', async (t) => {
  const world = await boot(t)
  const pro = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: 'pro' })
  const ops = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: 'ops' })
  await world.admin.update(ACTOR, pro.id, { labels: ['tier:pro', 'team:core'], weight: 3 })
  await world.admin.update(ACTOR, ops.id, { labels: ['team:ops'] })
  await world.admin.setHealth(ACTOR, ops.id, 'unhealthy')
  await world.admin.autoDisable(ACTOR, ops.id, '连续失败 3 次：HTTP 502')

  assert.equal(world.admin.list({ labels: ['tier:pro'] }).length, 1)
  assert.equal(world.admin.list({ labels: ['team:core', 'tier:pro'] }).length, 1)
  assert.equal(world.admin.list({ labels: ['tier:pro', 'team:ops'] }).length, 0, '多标签是 AND 语义')
  assert.equal(world.admin.list({ labels: [] }).length, 2, '空标签数组不过滤')
  assert.equal(world.admin.list({ health: 'unhealthy' }).length, 1)
  assert.equal(world.admin.list({ health: 'unknown' }).length, 1)
  assert.equal(world.admin.list({ status: 'auto_disabled' }).length, 1)

  const autoDisabled = world.admin.get(ops.id)
  assert.equal(autoDisabled.status, 'auto_disabled')
  assert.equal(autoDisabled.enabled, true, '自动停用不得改人的开关')
  assert.equal(autoDisabled.autoDisabledReason, '连续失败 3 次：HTTP 502')

  assert.throws(() => world.admin.list({ health: 'sick' } as never), hasCode('ACCOUNT_ADMIN_INPUT_INVALID'))
})

test('批量：逐项结果、只提交声明字段、actor 白名单、空 patch 与非法字段', async (t) => {
  const world = await boot(t)
  const first = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '批量 1' })
  const second = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '批量 2' })
  await world.admin.update(ACTOR, first.id, { concurrency: 3 })

  const bulk = await world.admin.bulkUpdate(ACTOR, [first.id, second.id, 'acc-missing'], {
    weight: 2,
    labels: ['batch'],
  })
  assert.equal(bulk.total, 3)
  assert.equal(bulk.succeeded, 2)
  assert.equal(bulk.failed, 1)
  assert.equal(bulk.items[2]?.error?.code, 'IDENTITY_ACCOUNT_NOT_FOUND')
  assert.equal(world.identity.get(first.id).weight, 2)
  assert.deepEqual(world.identity.get(second.id).labels, ['batch'])
  assert.equal(world.identity.get(first.id).concurrency, 3, '没声明的字段不该被改动')

  // 批量启停是人的开关。
  const disabled = await world.admin.bulkDisable(ACTOR, [first.id, second.id, first.id])
  assert.equal(disabled.total, 2, '重复 id 去重')
  assert.equal(disabled.succeeded, 2)
  assert.equal(world.identity.get(first.id).enabled, false)
  const enabled = await world.admin.bulkEnable(ACTOR, [first.id, second.id])
  assert.equal(enabled.succeeded, 2)
  assert.equal(world.identity.get(second.id).enabled, true)

  await assert.rejects(
    world.admin.bulkEnable('@dizzyapi/plugin-intruder', [first.id]),
    hasCode('ACCOUNT_ADMIN_ACTOR_FORBIDDEN'),
  )
  await assert.rejects(world.admin.bulkUpdate(ACTOR, [first.id], {}), hasCode('ACCOUNT_ADMIN_INPUT_INVALID'))
  await assert.rejects(world.admin.bulkUpdate(ACTOR, [], { weight: 1 }), hasCode('ACCOUNT_ADMIN_INPUT_INVALID'))
  await assert.rejects(
    world.admin.bulkUpdate(ACTOR, [first.id], { enabled: false } as never),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
  await assert.rejects(
    world.admin.bulkUpdate(ACTOR, [first.id], { health: 'healthy' } as never),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
})

test('批量上限：超过 maxBatchSize 整批拒绝，不部分执行', async (t) => {
  const world = await boot(t, { admin: { maxBatchSize: 2 } })
  const first = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '上限 1' })
  const second = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '上限 2' })
  const third = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '上限 3' })

  await assert.rejects(
    world.admin.bulkDisable(ACTOR, [first.id, second.id, third.id]),
    hasCode('ACCOUNT_ADMIN_BATCH_TOO_LARGE'),
  )
  assert.equal(world.identity.get(first.id).enabled, true, '被拒的批量不该部分执行')
})

test('lite 视图：只给列表字段，不夹带详情与凭据引用；默认仍是 full', async (t) => {
  const world = await boot(t)
  const view = await world.admin.create(ACTOR, {
    provider: 'custom',
    kind: 'api_key',
    label: '精简视图',
    baseUrl: 'https://upstream.example.com/v1',
    models: ['gpt-5'],
  })
  await world.admin.update(ACTOR, view.id, { labels: ['tier:pro'], weight: 1.5, concurrency: 2 })

  const [lite] = world.admin.list({}, { view: 'lite' })
  assert.ok(lite !== undefined)
  assert.equal(lite.id, view.id)
  assert.equal(lite.label, '精简视图')
  assert.equal(lite.weight, 1.5)
  assert.equal(lite.concurrency, 2)
  assert.deepEqual(lite.labels, ['tier:pro'])
  assert.ok(!('baseUrl' in lite), '精简视图不该带 baseUrl')
  assert.ok(!('models' in lite), '精简视图不该带 models')
  assert.ok(!('credentialRef' in lite), '精简视图不该带凭据引用')

  const [full] = world.admin.list({}, { view: 'full' })
  assert.ok(full !== undefined && 'baseUrl' in full)
  const [byDefault] = world.admin.list()
  assert.ok(byDefault !== undefined && 'baseUrl' in byDefault, '默认是 full，不破坏既有页面与测试')
  assert.throws(
    () => world.admin.list({}, { view: 'tiny' } as never),
    hasCode('ACCOUNT_ADMIN_INPUT_INVALID'),
  )
})

test('配置 schema：未知键拒绝，默认 adminPlugins 为空', async (t) => {
  const bad = ACCOUNT_ADMIN_CONFIG_SCHEMA['~standard'].validate({ nope: true })
  assert.ok('issues' in bad)

  const good = ACCOUNT_ADMIN_CONFIG_SCHEMA['~standard'].validate({
    adminPlugins: [ACTOR],
    maxBatchSize: 5,
  })
  assert.ok('value' in good)
  assert.equal(good.value.maxBatchSize, 5)

  const ctx = new Context()
  const credentials = await ctx.plugin(CredentialsService, {})
  const identity = await ctx.plugin(IdentityService, {})
  t.after(async () => {
    await identity.dispose()
    await credentials.dispose()
  })
  await assert.rejects(async () => {
    await ctx.plugin(AccountAdminService, { nope: true } as never)
  }, ValidationError)
})

// ───────────────────────────── 最近使用回报（usage/account-used） ─────────────────────────────

/** `usage/account-used` 的类型声明在 usage 插件里；这里不 import 它，走结构化 emit。 */
function emitUsage(ctx: Context, accountIds: readonly string[], at: string): void {
  ;(ctx as unknown as { emit(name: string, payload: unknown): void }).emit('usage/account-used', {
    accountIds,
    at,
  })
}

test('用量事件 → 节流汇报 lastUsedAt：窗口内不写盘，flush 后写回', async (t) => {
  const world = await boot(t)
  const account = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '用量回报' })

  emitUsage(world.ctx, [account.id], '2026-10-27T10:00:00.000Z')
  assert.equal(world.identity.get(account.id).lastUsedAt, null, '节流窗口内不该为一条用量写一次盘')

  assert.equal(await world.admin.flushUsage(), 1)
  assert.equal(world.identity.get(account.id).lastUsedAt, '2026-10-27T10:00:00.000Z')

  // 同一个账号多轮事件：取最近的时间，早到的不倒退。
  emitUsage(world.ctx, [account.id], '2026-10-27T12:00:00.000Z')
  emitUsage(world.ctx, [account.id], '2026-10-27T11:00:00.000Z')
  await world.admin.flushUsage()
  assert.equal(world.identity.get(account.id).lastUsedAt, '2026-10-27T12:00:00.000Z')

  // 未知账号是 no-op（identity 的 reportUsed 不抛），不影响其它账号。
  emitUsage(world.ctx, ['acc-ghost'], '2026-10-27T12:00:00.000Z')
  assert.equal(await world.admin.flushUsage(), 1)

  // 非法载荷被静默忽略（事件可能来自较早版本的插件）。
  ;(world.ctx as unknown as { emit(name: string, payload: unknown): void }).emit('usage/account-used', {
    accountIds: 'nope',
    at: 'x',
  })
  assert.equal(await world.admin.flushUsage(), 0)
})

test('D5：account-admin 卸载后不再接收用量事件，也不留定时器', async (t) => {
  const world = await boot(t)
  const account = await world.admin.create(ACTOR, { provider: 'custom', kind: 'api_key', label: '卸载后' })
  await world.disposeAdmin()

  emitUsage(world.ctx, [account.id], '2026-10-27T10:00:00.000Z')
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(world.identity.get(account.id).lastUsedAt, null, '卸载后不该再写 lastUsedAt')
})
