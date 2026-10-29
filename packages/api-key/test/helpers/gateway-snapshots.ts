/**
 * 真进程用例的**快照推送夹具**：把账号 / key / 消费 / 价格 / 余额推给 Go 的桥。
 *
 * 只放「怎么推」，不放断言；断言在各 `gateway-gates-*.test.ts` 里。
 */
import { createHash } from 'node:crypto'
import { sleep, type Gateway } from './gateway-process.ts'

export const CLIENT_KEY = 'sk-dz-smoketestkey012345678901234567890'
export const KEY_HASH = createHash('sha256').update(CLIENT_KEY, 'utf8').digest('hex')
export const AUTH = { authorization: `Bearer ${CLIENT_KEY}` }
export const MODEL = 'test-model'

export function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

let generation = 1
export function nextGeneration(): number {
  generation += 1
  return generation
}

export async function pushAccounts(gateway: Gateway, upstreamPort: number): Promise<void> {
  await gateway.bridge.request('accounts.replace', {
    version: 1,
    generation: String(Date.now()),
    accounts: [
      {
        accountId: 'acct-smoke',
        provider: 'openai',
        kind: 'api_key',
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        protocol: 'openai-chat',
        models: [MODEL],
        token: 'upstream-token-not-a-secret',
        priority: 1,
      },
    ],
  })
}

export async function pushKeys(
  gateway: Gateway,
  key: {
    readonly expiresAt?: string | null
    readonly spendingLimitMicros?: string | null
    readonly concurrencyLimit?: number | null
  } = {},
): Promise<void> {
  const record = {
    keyId: 'key-smoke',
    userId: 1,
    keyHash: KEY_HASH,
    profile: 'billed',
    name: 'smoke key',
    ...(key.expiresAt === undefined ? {} : { expiresAt: key.expiresAt }),
    ...(key.spendingLimitMicros === undefined
      ? {}
      : { spendingLimitMicros: key.spendingLimitMicros }),
    ...(key.concurrencyLimit === undefined ? {} : { concurrencyLimit: key.concurrencyLimit }),
  }
  await gateway.bridge.request('keys.replace', {
    version: 1,
    generation: nextGeneration(),
    keys: [record],
  })
}

export async function pushSpend(gateway: Gateway, spentMicros: string): Promise<void> {
  const entries = [{ keyId: 'key-smoke', spentMicros }]
  await gateway.bridge.request('keyspend.replace', {
    version: 1,
    generation: nextGeneration(),
    revision: hashOf(entries),
    entries,
  })
}

export async function pushPrices(
  gateway: Gateway,
  models: readonly string[] = [MODEL],
): Promise<void> {
  const prices = models.map((model) => ({
    model,
    inputPerMillion: '1',
    outputPerMillion: '2',
    cacheReadPerMillion: '0',
    cacheWritePerMillion: '0',
  }))
  await gateway.bridge.request('pricing.replace', {
    version: 1,
    generation: nextGeneration(),
    revision: hashOf(prices),
    prices,
  })
}

export async function pushQuota(
  gateway: Gateway,
  concurrencyLimit: number | null,
): Promise<void> {
  const entries = [{ userId: '1', balanceMicros: '1000000', concurrencyLimit }]
  await gateway.bridge.request('quota.replace', {
    version: 1,
    generation: nextGeneration(),
    revision: hashOf(entries),
    entries,
  })
}

export function chat(): unknown {
  return { model: MODEL, messages: [{ role: 'user', content: 'hello' }] }
}

/**
 * 等 Go 侧**真的**有一个并发槽位被占住（`keys.status` 的 `gate` 计数）。
 *
 * 用轮询代替 sleep 魔法值：并发闸门用例要「第一个请求占住槽位后再发第二个」，
 * 机器负载高时（多个 worktree 同时 spawn 真 gatewayd）sleep 会让第二个请求赶在
 * 第一个占位之前发出 → 假失败。轮询是确定性的。
 */
export async function waitForActive(
  gateway: Gateway,
  field: 'activeKeys' | 'activeUsers',
): Promise<void> {
  for (let index = 0; index < 150; index += 1) {
    const status = await gateway.status('keys.status')
    if ((status.gate?.[field] ?? 0) > 0) return
    await sleep(20)
  }
  throw new Error(`等待 ${field} 占位超时：keys.status 始终没有活跃槽位`)
}
