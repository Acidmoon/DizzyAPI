import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import CredentialsService from '../../credentials/src/index.ts'
import IdentityService, { type IdentityAccount } from '../../identity/src/index.ts'
import AccountAdminService, {
  type AccountAdminService as AccountAdminServiceType,
  type CreateAccountInput,
} from '../src/index.ts'

const ACTOR = '@dizzyapi/plugin-admin'

interface World {
  readonly admin: AccountAdminServiceType
  readonly identity: IdentityService
}

interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

async function boot(t: TestContext): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-account-test-'))
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
  }
}

/** 直接替换服务里的 fetch（生产用全局 fetch）；返回记录到的请求。 */
function injectFetch(
  world: World,
  handler: (url: string, init: RequestInit | undefined) => Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []
  const mutable = world.admin as unknown as { fetchImpl: typeof fetch }
  mutable.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  assert.ok(init !== undefined, '请求必须带 init')
  assert.equal(typeof init.body, 'string')
  return JSON.parse(init.body as string) as Record<string, unknown>
}

async function createAccount(
  world: World,
  input: Partial<CreateAccountInput> & Pick<CreateAccountInput, 'provider' | 'kind' | 'label'>,
  secret: { apiKey?: string; accessToken?: string } | null = { apiKey: 'sk-test' },
): Promise<IdentityAccount> {
  return world.identity.create({
    ...input,
    ...(secret === null ? {} : { secret }),
  })
}

// ───────────────────────────────── 三个协议的最小请求 ─────────────────────────────────

test('连通性测试：openai-chat 的 URL / 头 / 最小体正确，结果落 lastTest*', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'chat',
    baseUrl: 'https://up.example/v1/',
    protocol: 'openai-chat',
    models: ['gpt-5'],
  }, { apiKey: 'sk-openai-test' })
  const calls = injectFetch(world, async () => jsonResponse({ id: 'chatcmpl-1' }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)
  assert.equal(result.status, 200)
  assert.equal(result.model, 'gpt-5')
  assert.equal(result.protocol, 'openai-chat')
  assert.equal(result.error, null)
  assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0)
  assert.ok(Number.isFinite(Date.parse(result.testedAt)))

  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url, 'https://up.example/v1/chat/completions')
  assert.equal(calls[0]!.init?.method, 'POST')
  assert.equal(calls[0]!.init?.redirect, 'manual')
  assert.ok(calls[0]!.init?.signal instanceof AbortSignal)
  assert.deepEqual(headersOf(calls[0]!.init), {
    accept: 'application/json',
    authorization: 'Bearer sk-openai-test',
    'content-type': 'application/json',
  })
  assert.deepEqual(bodyOf(calls[0]!.init), {
    model: 'gpt-5',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    stream: false,
  })

  const after = world.identity.get(account.id)
  assert.equal(after.lastTestAt, result.testedAt)
  assert.equal(after.lastTestOk, true)
  assert.equal(after.lastTestError, null)
  assert.equal(after.lastTestLatencyMs, result.latencyMs)
})

test('连通性测试：openai-responses 发 input / max_output_tokens', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'responses',
    baseUrl: 'https://up.example/v1',
    protocol: 'openai-responses',
    models: ['gpt-5'],
  }, { apiKey: 'sk-responses' })
  const calls = injectFetch(world, async () => jsonResponse({ id: 'resp-1' }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)
  assert.equal(result.protocol, 'openai-responses')
  assert.equal(calls[0]!.url, 'https://up.example/v1/responses')
  assert.deepEqual(bodyOf(calls[0]!.init), {
    model: 'gpt-5',
    input: [{ role: 'user', content: 'hi' }],
    max_output_tokens: 16,
    stream: false,
  })
  assert.equal(headersOf(calls[0]!.init).authorization, 'Bearer sk-responses')
})

test('连通性测试：anthropic 用 x-api-key + anthropic-version，不发送 Bearer', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'claude',
    kind: 'api_key',
    label: 'claude',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    models: ['claude-sonnet-4-5'],
  }, { apiKey: 'sk-ant-test' })
  const calls = injectFetch(world, async () => jsonResponse({ id: 'msg-1' }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)
  assert.equal(result.protocol, 'anthropic')
  assert.equal(calls[0]!.url, 'https://api.anthropic.com/v1/messages')
  const headers = headersOf(calls[0]!.init)
  assert.equal(headers['x-api-key'], 'sk-ant-test')
  assert.equal(headers['anthropic-version'], '2023-06-01')
  assert.equal(headers.authorization, undefined, 'Anthropic 不该带 Authorization')
  assert.deepEqual(bodyOf(calls[0]!.init), {
    model: 'claude-sonnet-4-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  })
})

test('连通性测试：gemini 用 x-goog-api-key，模型名进路径，不发送 Bearer', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'custom',
    kind: 'api_key',
    label: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'gemini',
    models: ['gemini-2.5-flash'],
  }, { apiKey: 'AIza-test' })
  const calls = injectFetch(world, async () => jsonResponse({ candidates: [] }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)
  assert.equal(result.protocol, 'gemini')
  assert.equal(
    calls[0]!.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
  )
  const headers = headersOf(calls[0]!.init)
  assert.equal(headers['x-goog-api-key'], 'AIza-test')
  assert.equal(headers.authorization, undefined, 'Gemini 不该带 Authorization')
  assert.deepEqual(bodyOf(calls[0]!.init), {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 16 },
  })
})

test('连通性测试：无声明协议时按 provider 推断（openai → chat，claude → anthropic）', async (t) => {
  const world = await boot(t)
  const openai = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'openai-inferred',
    baseUrl: 'https://oa.example/v1',
    models: ['gpt-5'],
  })
  const claude = await createAccount(world, {
    provider: 'claude',
    kind: 'api_key',
    label: 'claude-inferred',
    baseUrl: 'https://claude.example/v1',
    models: ['claude-sonnet-4-5'],
  }, { apiKey: 'sk-claude' })
  const calls = injectFetch(world, async () => jsonResponse({ ok: true }))

  const first = await world.admin.testConnection(openai.id)
  const second = await world.admin.testConnection(claude.id)
  assert.equal(first.protocol, 'openai-chat')
  assert.equal(second.protocol, 'anthropic')
  assert.equal(calls[0]!.url, 'https://oa.example/v1/chat/completions')
  assert.equal(calls[1]!.url, 'https://claude.example/v1/messages')
})

test('连通性测试：参数可以覆盖 model / protocol', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'override',
    baseUrl: 'https://up.example/v1',
    protocol: 'openai-chat',
    models: ['gpt-5'],
  })
  const calls = injectFetch(world, async () => jsonResponse({ ok: true }))

  const result = await world.admin.testConnection(account.id, { model: 'o3', protocol: 'openai-responses' })
  assert.equal(result.model, 'o3')
  assert.equal(result.protocol, 'openai-responses')
  assert.equal(calls[0]!.url, 'https://up.example/v1/responses')
  assert.equal(bodyOf(calls[0]!.init).model, 'o3')
})

// ───────────────────────────────── 无模型 / 默认 baseUrl ─────────────────────────────────

test('连通性测试：没有模型时 GET /models，成功且 model 为 null', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'no-model',
    baseUrl: 'https://up.example/v1',
    protocol: 'openai-chat',
  })
  const calls = injectFetch(world, async () => jsonResponse({ data: [] }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, true)
  assert.equal(result.model, null)
  assert.equal(result.status, 200)
  assert.equal(calls[0]!.url, 'https://up.example/v1/models')
  assert.equal(calls[0]!.init?.method, 'GET')
  assert.equal(calls[0]!.init?.body, undefined)
  assert.equal(headersOf(calls[0]!.init).authorization, 'Bearer sk-test')
})

test('连通性测试：baseUrl 为空时用 provider 默认；custom 明确失败', async (t) => {
  const world = await boot(t)
  const openai = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'openai-default',
    models: ['gpt-5'],
  })
  const claude = await createAccount(world, {
    provider: 'claude',
    kind: 'api_key',
    label: 'claude-default',
    models: ['claude-sonnet-4-5'],
  }, { apiKey: 'sk-claude' })
  const custom = await createAccount(world, {
    provider: 'custom',
    kind: 'api_key',
    label: 'custom-no-url',
    models: ['m'],
  })
  const calls = injectFetch(world, async () => jsonResponse({ ok: true }))

  await world.admin.testConnection(openai.id)
  await world.admin.testConnection(claude.id)
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(calls[1]!.url, 'https://api.anthropic.com/v1/messages')

  await assert.rejects(
    world.admin.testConnection(custom.id),
    (error: unknown) => (error as { code?: string }).code === 'ACCOUNT_TEST_BASE_URL_MISSING',
  )
})

// ───────────────────────────────── 失败与脱敏 ─────────────────────────────────

test('连通性测试：401 响应里的 key / Bearer / URL-encoded key 全部脱敏，且结果落库', async (t) => {
  const world = await boot(t)
  const secret = 'sk-super-secret-token'
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'redact',
    baseUrl: 'https://up.example/v1',
    models: ['gpt-5'],
  }, { apiKey: secret })

  injectFetch(world, async () =>
    jsonResponse(
      {
        error: {
          message: `invalid key ${secret}; header Bearer ${secret}; encoded ${encodeURIComponent(secret)}`,
        },
      },
      401,
    ),
  )

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, false)
  assert.equal(result.status, 401)
  assert.ok(result.error?.includes('[REDACTED]'))
  assert.ok(!result.error?.includes(secret), '错误文本不能包含原 key')
  assert.ok(!result.error?.includes(encodeURIComponent(secret)), '错误文本不能包含 URL-encoded key')

  const after = world.identity.get(account.id)
  assert.equal(after.lastTestOk, false)
  assert.equal(after.lastTestError, result.error)
  assert.equal(after.lastTestLatencyMs, result.latencyMs)
})

test('连通性测试：超时是结果对象（status null），不抛错', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'timeout',
    baseUrl: 'https://up.example/v1',
    models: ['gpt-5'],
  })
  injectFetch(world, async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  })

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, false)
  assert.equal(result.status, null)
  assert.match(result.error ?? '', /请求超时/)
  assert.ok(!result.error?.includes('https://up.example/v1'))
})

test('连通性测试：redirect: manual 且 3xx 视为失败', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'redirect',
    baseUrl: 'https://up.example/v1',
    models: ['gpt-5'],
  })
  const calls = injectFetch(world, async () =>
    new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/v1/chat/completions' } }),
  )

  const result = await world.admin.testConnection(account.id)
  assert.equal(calls[0]!.init?.redirect, 'manual')
  assert.equal(result.ok, false)
  assert.equal(result.status, 302)
  assert.match(result.error ?? '', /HTTP 302/)
})

test('连通性测试：fetch 抛 TypeError 时只留 cause.code，不拼 URL / query', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'network',
    baseUrl: 'https://up.example/v1?api_key=should-not-leak',
    models: ['gpt-5'],
  })
  injectFetch(world, async () => {
    throw Object.assign(new TypeError('fetch failed https://up.example/v1?api_key=should-not-leak'), {
      cause: { code: 'ENOTFOUND' },
    })
  })

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, false)
  assert.equal(result.status, null)
  assert.match(result.error ?? '', /网络请求失败：ENOTFOUND/)
  assert.ok(!result.error?.includes('https://'))
  assert.ok(!result.error?.includes('should-not-leak'))
})

test('连通性测试：401 之外的 2xx 但带 error 载荷也算失败', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'payload-error',
    baseUrl: 'https://up.example/v1',
    models: ['gpt-5'],
  })
  injectFetch(world, async () => jsonResponse({ error: { message: 'quota exhausted' } }))

  const result = await world.admin.testConnection(account.id)
  assert.equal(result.ok, false)
  assert.equal(result.status, 200)
  assert.match(result.error ?? '', /quota exhausted/)
})

test('连通性测试：没有凭据时返回失败结果并落库，而不是抛错', async (t) => {
  const world = await boot(t)
  const account = await createAccount(world, {
    provider: 'openai',
    kind: 'api_key',
    label: 'no-credential',
    baseUrl: 'https://up.example/v1',
    models: ['gpt-5'],
  }, null)
  let called = 0
  injectFetch(world, async () => {
    called += 1
    return jsonResponse({ ok: true })
  })

  const result = await world.admin.testConnection(account.id)
  assert.equal(called, 0, '没有凭据就不该打上游')
  assert.equal(result.ok, false)
  assert.equal(result.status, null)
  assert.match(result.error ?? '', /IDENTITY_CREDENTIAL_MISSING/)
  assert.equal(world.identity.get(account.id).lastTestOk, false)
})
