/**
 * 连通性测试用例的公共夹具（world 启动 / fetch 注入 / 响应构造）。
 *
 * 抽出来的原因：`account-test.test.ts` 已经 457 行（§5.6 测试文件上限 500），
 * 详情块（request / response 片段、截断、打码）需要另开一个测试文件，
 * 而两份用例**必须共用同一套启动与注入逻辑** —— 复制一份夹具，早晚两边漂移。
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext } from 'node:test'
import { Context } from 'cordis'
import CredentialsService from '../../../credentials/src/index.ts'
import IdentityService, { type IdentityAccount } from '../../../identity/src/index.ts'
import AccountAdminService, {
  type AccountAdminService as AccountAdminServiceType,
  type CreateAccountInput,
} from '../../src/index.ts'

/** 写操作要求 actor 在 `adminPlugins` 白名单里。 */
export const ACTOR = '@dizzyapi/plugin-admin'

export interface World {
  readonly admin: AccountAdminServiceType
  readonly identity: IdentityService
}

export interface FetchCall {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** 起一套真插件（credentials + identity + account-admin），数据落在临时目录。 */
export async function boot(t: TestContext): Promise<World> {
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
export function injectFetch(
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

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

export function headersOf(init: RequestInit | undefined): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>
}

export function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
  assert.ok(init !== undefined, '请求必须带 init')
  assert.equal(typeof init.body, 'string')
  return JSON.parse(init.body as string) as Record<string, unknown>
}

/** 建一个带秘密的上游账号。 */
export async function createAccount(
  world: World,
  input: Partial<CreateAccountInput> & Pick<CreateAccountInput, 'provider' | 'kind' | 'label'>,
  secret: { apiKey?: string; accessToken?: string } | null = { apiKey: 'sk-test' },
): Promise<IdentityAccount> {
  return world.identity.create({
    ...input,
    ...(secret === null ? {} : { secret }),
  })
}
