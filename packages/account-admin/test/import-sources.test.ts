import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import CredentialsService from '../../credentials/src/index.ts'
import IdentityService from '../../identity/src/index.ts'
import AccountAdminService, {
  parseImportSource,
  type AccountAdminService as AccountAdminServiceType,
} from '../src/index.ts'

const ACTOR = '@dizzyapi/plugin-admin'

interface World {
  readonly admin: AccountAdminServiceType
  readonly identity: IdentityService
  readonly credentials: CredentialsService
}

async function boot(t: TestContext): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-import-sources-'))
  const ctx = new Context()
  const credentialsFiber = await ctx.plugin(CredentialsService, { dataPath: join(dir, 'credentials.json') })
  const identityFiber = await ctx.plugin(IdentityService, {
    dataPath: join(dir, 'accounts.json'),
    pollIntervalMs: 3_600_000,
    requestTimeoutMs: 5_000,
  })
  const adminFiber = await ctx.plugin(AccountAdminService, { adminPlugins: [ACTOR], maxBatchSize: 100 })
  t.after(async () => {
    await adminFiber.dispose()
    await identityFiber.dispose()
    await credentialsFiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return {
    admin: ctx.get('accountAdmin') as AccountAdminServiceType,
    identity: ctx.get('identity') as IdentityService,
    credentials: ctx.get('credentials') as CredentialsService,
  }
}

function newApiChannel(overrides: Record<string, unknown>): Record<string, unknown> {
  return { type: 1, key: 'sk-channel', name: 'primary', ...overrides }
}

// ───────────────────────────────── new-api ─────────────────────────────────

test('new-api：单渠道多 key 拆成多条账号，models / model_mapping / status / priority 一起归一化', () => {
  const parsed = parseImportSource({
    source: 'new-api',
    payload: JSON.stringify(
      newApiChannel({
        key: 'sk-a\nsk-b',
        name: 'primary',
        base_url: 'https://up.example/v1/',
        models: 'gpt-5, gpt-5-codex, gpt-5',
        model_mapping: '{"gpt-5-codex":"up-codex"}',
        status: 1,
        priority: 42,
      }),
    ),
  })

  assert.equal(parsed.source, 'new-api')
  assert.equal(parsed.issues.length, 0)
  assert.equal(parsed.items.length, 2)

  const first = parsed.items[0]!
  assert.equal(first.label, 'primary #1')
  assert.equal(first.provider, 'openai')
  assert.equal(first.kind, 'api_key')
  assert.equal(first.protocol, 'openai-chat')
  // 导入时统一去掉结尾斜杠：transport / 连通性测试都按「无尾斜杠」拼接路径。
  assert.equal(first.baseUrl, 'https://up.example/v1')
  assert.deepEqual(first.models, ['gpt-5', 'gpt-5-codex'])
  assert.deepEqual(first.modelMap, { 'gpt-5-codex': 'up-codex' })
  assert.equal(first.priority, 42)
  assert.equal(first.enabled, true)
  assert.equal(first.payload, 'sk-a')
  assert.equal(parsed.items[1]!.label, 'primary #2')
  assert.equal(parsed.items[1]!.payload, 'sk-b')
})

test('new-api：type 1 / 8 / 14 / 57 的 provider / kind / protocol；57 的 key 是 JSON', () => {
  const payload = JSON.stringify({
    channels: [
      newApiChannel({ type: 1, key: 'sk-one', name: 'one' }),
      newApiChannel({ type: 8, key: 'sk-eight', name: 'eight' }),
      newApiChannel({ type: 14, key: 'sk-fourteen', name: 'fourteen' }),
      {
        type: 57,
        key: JSON.stringify({ access_token: 'codex-access', account_id: 'acct-1' }),
        name: 'codex',
      },
    ],
  })
  const parsed = parseImportSource({ source: 'new-api', payload })
  assert.equal(parsed.items.length, 4)
  assert.deepEqual(
    parsed.items.map((item) => [item.provider, item.kind, item.protocol]),
    [
      ['openai', 'api_key', 'openai-chat'],
      ['custom', 'api_key', 'openai-chat'],
      ['claude', 'api_key', 'anthropic'],
      ['openai', 'oauth', 'openai-responses'],
    ],
  )
  const codex = parsed.items[3]!
  assert.equal(codex.label, 'codex')
  assert.deepEqual(JSON.parse(codex.payload), { access_token: 'codex-access', account_id: 'acct-1' })
})

test('new-api：不支持的 type 明确失败、不回显 key；type 57 的坏 key JSON 只影响自己', () => {
  const secret = 'sk-never-print-me'
  const parsed = parseImportSource({
    source: 'new-api',
    payload: JSON.stringify([
      newApiChannel({ type: 3, key: secret, name: 'weird' }),
      { type: 57, key: `not-json-${secret}`, name: 'bad-codex' },
      newApiChannel({ type: 1, key: 'sk-ok', name: 'ok' }),
    ]),
  })

  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0]!.payload, 'sk-ok')
  assert.equal(parsed.issues.length, 2)
  assert.equal(parsed.issues[0]!.code, 'ACCOUNT_IMPORT_UNSUPPORTED_TYPE')
  assert.match(parsed.issues[0]!.message, /type 3/)
  assert.match(parsed.issues[1]!.message, /key 不是含 access_token 的 JSON 对象/)
  assert.ok(!JSON.stringify(parsed.issues).includes(secret), '错误信息不能回显 key')
})

test('new-api：status 2 / 3 / 0 停用，priority 越界 clamp', () => {
  const parsed = parseImportSource({
    source: 'new-api',
    payload: JSON.stringify([
      newApiChannel({ key: 'sk-1', status: 2, priority: 5000 }),
      newApiChannel({ key: 'sk-2', status: 0, priority: -5 }),
      newApiChannel({ key: 'sk-3', status: 3 }),
    ]),
  })
  assert.deepEqual(
    parsed.items.map((item) => item.enabled),
    [false, false, false],
  )
  assert.equal(parsed.items[0]!.priority, 1000)
  assert.equal(parsed.items[1]!.priority, 0)
})

// ───────────────────────────────── sub2api ─────────────────────────────────

test('sub2api：anthropic / openai 的 oauth 与 apikey；忽略字段记 warning', () => {
  const parsed = parseImportSource({
    source: 'sub2api',
    payload: JSON.stringify({
      type: 'sub2api-data',
      version: 1,
      proxies: [],
      accounts: [
        {
          name: 'claude main',
          platform: 'anthropic',
          type: 'oauth',
          credentials: { access_token: 'claude-at', refresh_token: 'claude-rt', expires_at: '2030-01-01T00:00:00.000Z' },
          priority: 3,
          rate_multiplier: 1.2,
        },
        {
          name: 'codex',
          platform: 'openai',
          type: 'oauth',
          credentials: { access_token: 'openai-at' },
        },
        {
          name: 'openai key',
          platform: 'openai',
          type: 'apikey',
          credentials: { api_key: 'sk-openai' },
          concurrency: 4,
          proxy_id: 'proxy-1',
        },
      ],
    }),
  })

  assert.equal(parsed.source, 'sub2api')
  assert.equal(parsed.issues.length, 0)
  assert.equal(parsed.items.length, 3)
  const [claude, codex, apiKey] = parsed.items
  assert.equal(claude!.provider, 'claude')
  assert.equal(claude!.kind, 'oauth')
  assert.equal(claude!.protocol, 'anthropic')
  assert.equal(claude!.priority, 3)
  assert.deepEqual(JSON.parse(claude!.payload), {
    access_token: 'claude-at',
    refresh_token: 'claude-rt',
    expires_at: '2030-01-01T00:00:00.000Z',
  })
  assert.ok(claude!.warnings.some((warning) => warning.includes('rate_multiplier')))

  assert.equal(codex!.provider, 'openai')
  assert.equal(codex!.kind, 'oauth')
  assert.equal(codex!.protocol, 'openai-responses')

  assert.equal(apiKey!.provider, 'openai')
  assert.equal(apiKey!.kind, 'api_key')
  assert.equal(apiKey!.protocol, 'openai-chat')
  assert.equal(apiKey!.payload, 'sk-openai')
  assert.ok(apiKey!.warnings.some((warning) => warning.includes('concurrency')))
  assert.ok(apiKey!.warnings.some((warning) => warning.includes('proxy_id')))
})

test('sub2api：未知 platform / type、缺 credentials 都明确失败且不回显秘密', () => {
  const secret = 'sk-sub2api-secret'
  const parsed = parseImportSource({
    source: 'sub2api',
    payload: JSON.stringify({
      type: 'sub2api-data',
      accounts: [
        { name: 'gemini', platform: 'gemini', type: 'apikey', credentials: { api_key: secret } },
        { name: 'cookie', platform: 'openai', type: 'cookie', credentials: { api_key: secret } },
        { name: 'no-cred', platform: 'openai', type: 'apikey', credentials: {} },
      ],
    }),
  })
  assert.equal(parsed.items.length, 0)
  assert.equal(parsed.issues.length, 3)
  assert.equal(parsed.issues[0]!.code, 'ACCOUNT_IMPORT_UNSUPPORTED_PLATFORM')
  assert.equal(parsed.issues[1]!.code, 'ACCOUNT_IMPORT_UNSUPPORTED_TYPE')
  assert.match(parsed.issues[2]!.message, /api_key/)
  assert.ok(!JSON.stringify(parsed.issues).includes(secret))
})

test('sub2api：结构不对（type / accounts）直接抛稳定错误', () => {
  assert.throws(
    () => parseImportSource({ source: 'sub2api', payload: JSON.stringify({ type: 'other', accounts: [] }) }),
    (error: unknown) => (error as { code?: string }).code === 'ACCOUNT_IMPORT_SOURCE_INVALID',
  )
  assert.throws(
    () => parseImportSource({ source: 'sub2api', payload: JSON.stringify({ type: 'sub2api-data' }) }),
    (error: unknown) => (error as { code?: string }).code === 'ACCOUNT_IMPORT_SOURCE_INVALID',
  )
})

// ───────────────────────────────── plain-keys / auto ─────────────────────────────────

test('plain-keys：一行一个 key，defaults 决定 provider / kind / baseUrl / protocol / enabled / 标签', () => {
  const parsed = parseImportSource({
    source: 'plain-keys',
    payload: 'sk-1\n\n  sk-2  \n',
    defaults: {
      provider: 'claude',
      kind: 'api_key',
      baseUrl: 'https://up.example/v1/',
      protocol: 'anthropic',
      enabled: false,
      labelPrefix: 'Key',
    },
  })
  assert.equal(parsed.items.length, 2)
  assert.deepEqual(
    parsed.items.map((item) => item.payload),
    ['sk-1', 'sk-2'],
  )
  const first = parsed.items[0]!
  assert.equal(first.label, 'Key #1')
  assert.equal(first.provider, 'claude')
  assert.equal(first.kind, 'api_key')
  assert.equal(first.protocol, 'anthropic')
  assert.equal(first.baseUrl, 'https://up.example/v1')
  assert.equal(first.enabled, false)
})

test('plain-keys：缺省 provider / kind / protocol 是 openai / api_key / openai-chat', () => {
  const parsed = parseImportSource({ source: 'plain-keys', payload: 'sk-only' })
  const item = parsed.items[0]!
  assert.equal(item.provider, 'openai')
  assert.equal(item.kind, 'api_key')
  assert.equal(item.protocol, 'openai-chat')
  assert.equal(item.baseUrl, undefined)
})

test('auto：按形状识别 sub2api / new-api / plain-keys', () => {
  const sub2api = parseImportSource({
    source: 'auto',
    payload: JSON.stringify({ type: 'sub2api-data', accounts: [{ platform: 'openai', type: 'apikey', credentials: { api_key: 'sk-a' } }] }),
  })
  assert.equal(sub2api.source, 'sub2api')

  const newApi = parseImportSource({
    source: 'auto',
    payload: JSON.stringify({ type: 1, key: 'sk-b', name: 'x' }),
  })
  assert.equal(newApi.source, 'new-api')

  const plain = parseImportSource({ source: 'auto', payload: 'sk-c\nsk-d' })
  assert.equal(plain.source, 'plain-keys')
  assert.equal(plain.items.length, 2)
})

// ───────────────────────────────── 服务层：预览 / 导入 ─────────────────────────────────

test('previewImportSource 与 importSource：逐条部分成功，返回值不含任何 key', async (t) => {
  const world = await boot(t)
  const secretA = 'sk-secret-preview-a'
  const secretB = 'sk-secret-preview-b'
  const codexSecret = 'codex-access-preview'
  const payload = JSON.stringify([
    newApiChannel({
      key: secretA,
      name: 'oa',
      base_url: 'https://oa.example/v1',
      models: 'gpt-5',
      model_mapping: '{"gpt-5":"gpt-5-up"}',
      priority: 7,
    }),
    { type: 57, key: JSON.stringify({ access_token: codexSecret, account_id: 'acct-9' }), name: 'codex' },
    newApiChannel({ type: 99, key: secretB, name: 'bad' }),
  ])

  const preview = world.admin.previewImportSource({ source: 'new-api', payload })
  assert.equal(preview.source, 'new-api')
  assert.equal(preview.total, 3)
  assert.deepEqual(
    preview.items.map((item) => item.ok),
    [true, true, false],
  )
  assert.equal(preview.items[2]!.error?.includes('type 99'), true)
  assert.ok(!JSON.stringify(preview).includes(secretA))
  assert.ok(!JSON.stringify(preview).includes(secretB))
  assert.ok(!JSON.stringify(preview).includes(codexSecret))

  const result = await world.admin.importSource(ACTOR, { source: 'new-api', payload })
  assert.equal(result.total, 3)
  assert.equal(result.created, 2)
  assert.equal(result.failed, 1)
  assert.deepEqual(
    result.items.map((item) => item.index),
    [0, 1, 2],
  )
  assert.equal(result.items[2]!.ok, false)
  assert.equal(result.items[2]!.error?.code, 'ACCOUNT_IMPORT_UNSUPPORTED_TYPE')
  assert.ok(!JSON.stringify(result).includes(secretA))
  assert.ok(!JSON.stringify(result).includes(codexSecret))

  const accounts = world.identity.list()
  assert.equal(accounts.length, 2)
  const oa = accounts.find((account) => account.label === 'oa')
  const codex = accounts.find((account) => account.label === 'codex')
  assert.ok(oa !== undefined && codex !== undefined)
  assert.equal(oa.provider, 'openai')
  assert.equal(oa.kind, 'api_key')
  assert.equal(oa.baseUrl, 'https://oa.example/v1')
  assert.equal(oa.protocol, 'openai-chat')
  assert.deepEqual(oa.models, ['gpt-5'])
  assert.deepEqual(oa.modelMap, { 'gpt-5': 'gpt-5-up' })
  assert.equal(oa.priority, 7)
  assert.ok(!JSON.stringify(oa).includes(secretA), '账号记录里不能有 key')

  assert.equal(codex.provider, 'openai')
  assert.equal(codex.kind, 'oauth')
  assert.equal(codex.protocol, 'openai-responses')
  assert.equal(codex.subject, 'acct-9')
  assert.ok(!JSON.stringify(codex).includes(codexSecret), '账号记录里不能有 access token')

  const bundle = JSON.parse(world.credentials.resolve(codex.credentialRef) ?? '{}') as Record<string, unknown>
  assert.equal(bundle.accessToken, codexSecret)
})

test('importSource：sub2api 的 claude / openai 账号都落到 identity，baseUrl 与协议正确', async (t) => {
  const world = await boot(t)
  const payload = JSON.stringify({
    type: 'sub2api-data',
    accounts: [
      {
        name: 'claude',
        platform: 'anthropic',
        type: 'oauth',
        credentials: { access_token: 'claude-token', refresh_token: 'claude-refresh' },
      },
      {
        name: 'openai-key',
        platform: 'openai',
        type: 'apikey',
        credentials: { api_key: 'sk-openai-key' },
      },
    ],
  })
  const result = await world.admin.importSource(ACTOR, { source: 'sub2api', payload })
  assert.equal(result.created, 2)
  assert.equal(result.failed, 0)

  const accounts = world.identity.list()
  const claude = accounts.find((account) => account.label === 'claude')
  const openai = accounts.find((account) => account.label === 'openai-key')
  assert.ok(claude !== undefined && openai !== undefined)
  assert.equal(claude.provider, 'claude')
  assert.equal(claude.kind, 'oauth')
  assert.equal(claude.protocol, 'anthropic')
  assert.equal(openai.provider, 'openai')
  assert.equal(openai.kind, 'api_key')
  assert.equal(openai.protocol, 'openai-chat')
  assert.ok(!JSON.stringify(result).includes('claude-token'))
  assert.ok(!JSON.stringify(result).includes('sk-openai-key'))
})

test('new-api：裸源站 base_url 补 /v1，已有路径原样保留', () => {
  const parsed = parseImportSource({
    source: 'new-api',
    payload: JSON.stringify([
      newApiChannel({ key: 'a', base_url: 'https://api.openai.com' }),
      newApiChannel({ key: 'b', base_url: 'https://gw.example/openai/' }),
      newApiChannel({ key: 'c' }),
    ]),
  })
  assert.deepEqual(
    parsed.items.map((item) => item.baseUrl),
    ['https://api.openai.com/v1', 'https://gw.example/openai', undefined],
  )
})
