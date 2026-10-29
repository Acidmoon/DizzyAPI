/**
 * **真进程**用例：真 `bin/gatewayd` + 真控制桥 + 真 HTTP 入口。
 *
 * 覆盖本批新增的两条 pre 相位闸门（owner 要的是「真拦截」，内存假 Go 抓不到这些）：
 *
 *  1. key-gate：`401 API_KEY_EXPIRED` / `402 API_KEY_SPENDING_LIMIT` /
 *     `429 API_KEY_CONCURRENCY_LIMIT` / `429 USER_CONCURRENCY_LIMIT`；
 *  2. pricing-gate（`-pricing-gate` 打开）：`403 MODEL_NOT_PRICED` /
 *     `503 PRICING_SNAPSHOT_UNAVAILABLE`（fail-closed），以及 `*` 兜底价放行全部模型；
 *  3. 价格快照**超过 TTL 不再推** → 闸门 fail-closed（503），这是心跳式推送的存在理由。
 *
 * 没有 `bin/gatewayd` 时整组跳过（`pnpm test` 不该要求先 `pnpm build:go`）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer as createNetServer, connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { test, type TestContext } from 'node:test'

const BINARY = process.platform === 'win32' ? resolve('bin/gatewayd.exe') : resolve('bin/gatewayd')
const HAS_BINARY = existsSync(BINARY)
const SKIP = HAS_BINARY ? false : '没有 bin/gatewayd：先跑 pnpm build:go 才有真进程用例'

/** 最小的控制桥客户端（4 字节大端长度 + UTF-8 JSON）。 */
class MiniBridge {
  private socket: Socket | undefined
  private buffer: Buffer = Buffer.alloc(0)
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private nextId = 1
  private onHello: (() => void) | undefined

  async connect(port: number): Promise<void> {
    const socket = connect({ host: '127.0.0.1', port })
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.handle(chunk))
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('连接控制桥超时')), 3_000)
      timer.unref?.()
      this.onHello = () => {
        clearTimeout(timer)
        resolvePromise()
      }
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = String(this.nextId)
    this.nextId += 1
    const payload = Buffer.from(
      JSON.stringify({ id, type: 'request', method, ...(params === undefined ? {} : { params }) }),
      'utf8',
    )
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    return new Promise<T>((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise as (value: any) => void, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`控制桥请求超时：${method}`))
      }, 3_000).unref?.()
      this.socket?.write(frame)
    })
  }

  close(): void {
    this.socket?.destroy()
    this.socket = undefined
  }

  private handle(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length === 0 || length > (16 << 20)) return
      if (this.buffer.length < 4 + length) return
      const payload = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      let message: any
      try {
        message = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }
      if (message?.type === 'event') {
        if (message.event === 'hello') {
          const hello = this.onHello
          this.onHello = undefined
          hello?.()
        }
        continue
      }
      if (message?.type !== 'response' || typeof message.id !== 'string') continue
      const pending = this.pending.get(message.id)
      if (pending === undefined) continue
      this.pending.delete(message.id)
      if (message.ok === true) pending.resolve(message.result)
      else {
        pending.reject(
          new Error(
            `${String(message.error?.code ?? 'BRIDGE_INTERNAL')}: ${String(message.error?.message ?? '')}`,
          ),
        )
      }
    }
  }
}

interface Reply {
  readonly status: number
  readonly text: string
  readonly json: any
}

function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise((server.address() as AddressInfo).port))
  })
}

function freePort(): Promise<number> {
  const server = createNetServer()
  return listen(server).finally(() => {
    server.close()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function request(
  port: number,
  path: string,
  method: string,
  body: string | undefined,
  headers: Record<string, string>,
): Promise<Reply> {
  return new Promise<Reply>((resolvePromise, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body, 'utf8')
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json', 'content-length': String(payload.length) }),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: any
          try {
            json = text === '' ? undefined : JSON.parse(text)
          } catch {
            json = undefined
          }
          resolvePromise({ status: res.statusCode ?? 0, text, json })
        })
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(port, '/v1/chat/completions', 'POST', JSON.stringify(body), headers)
}

/** 假上游：回一条 OpenAI chat completion，并数被打了几次（可配延迟）。 */
async function startUpstream(
  t: TestContext,
  options: { readonly delayMs?: number } = {},
): Promise<{ port: number; hits: () => number }> {
  let hits = 0
  const server = createHttpServer((req, res) => {
    hits += 1
    req.resume()
    req.on('end', () => {
      const reply = (): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: 'test-model',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
          }),
        )
      }
      if (options.delayMs === undefined) reply()
      else setTimeout(reply, options.delayMs).unref?.()
    })
  })
  const port = await listen(server)
  t.after(async () => {
    await new Promise<void>((resolvePromise) => {
      server.close(() => resolvePromise())
      server.closeAllConnections?.()
    })
  })
  return { port, hits: () => hits }
}

interface Gateway {
  readonly httpPort: number
  readonly bridge: MiniBridge
  status(method: string): Promise<any>
}

async function startGateway(
  t: TestContext,
  options: {
    readonly pricingGate?: boolean
    readonly pricingTtlMs?: number
    readonly keyspendTtlMs?: number
  } = {},
): Promise<Gateway> {
  const bridgePort = await freePort()
  const httpPort = await freePort()
  const args = [
    '-transport',
    'tcp',
    '-listen',
    `127.0.0.1:${bridgePort}`,
    '-http-listen',
    `127.0.0.1:${httpPort}`,
    '-log-format',
    'text',
    ...(options.pricingGate === true ? ['-pricing-gate'] : []),
    ...(options.pricingTtlMs === undefined
      ? []
      : ['-pricing-snapshot-ttl-ms', String(options.pricingTtlMs)]),
    ...(options.keyspendTtlMs === undefined
      ? []
      : ['-keyspend-snapshot-ttl-ms', String(options.keyspendTtlMs)]),
  ]
  const child: ChildProcessWithoutNullStreams = spawn(BINARY, args, { stdio: 'pipe' })
  let logs = ''
  child.stdout.on('data', (chunk: Buffer) => {
    logs += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    logs += chunk.toString('utf8')
  })

  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill()
    for (let index = 0; index < 100; index += 1) {
      if (child.exitCode !== null) return
      await sleep(20)
    }
  })

  let ready = false
  for (let index = 0; index < 200; index += 1) {
    if (child.exitCode !== null) break
    try {
      const reply = await request(httpPort, '/healthz', 'GET', undefined, {})
      if (reply.status === 200) {
        ready = true
        break
      }
    } catch {
      // 还没起来
    }
    await sleep(25)
  }
  assert.ok(ready, `gatewayd 没起来：\n${logs}`)

  const bridge = new MiniBridge()
  await bridge.connect(bridgePort)
  t.after(() => {
    bridge.close()
  })

  return { httpPort, bridge, status: (method: string) => bridge.request(method) }
}

const CLIENT_KEY = 'sk-dz-smoketestkey012345678901234567890'
const KEY_HASH = createHash('sha256').update(CLIENT_KEY, 'utf8').digest('hex')
const AUTH = { authorization: `Bearer ${CLIENT_KEY}` }
const MODEL = 'test-model'

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

let generation = 1
function nextGeneration(): number {
  generation += 1
  return generation
}

async function pushAccounts(gateway: Gateway, upstreamPort: number): Promise<void> {
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

async function pushKeys(
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

async function pushSpend(gateway: Gateway, spentMicros: string): Promise<void> {
  const entries = [{ keyId: 'key-smoke', spentMicros }]
  await gateway.bridge.request('keyspend.replace', {
    version: 1,
    generation: nextGeneration(),
    revision: hashOf(entries),
    entries,
  })
}

async function pushPrices(gateway: Gateway, models: readonly string[] = [MODEL]): Promise<void> {
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

async function pushQuota(gateway: Gateway, concurrencyLimit: number | null): Promise<void> {
  const entries = [{ userId: '1', balanceMicros: '1000000', concurrencyLimit }]
  await gateway.bridge.request('quota.replace', {
    version: 1,
    generation: nextGeneration(),
    revision: hashOf(entries),
    entries,
  })
}

function chat(): unknown {
  return { model: MODEL, messages: [{ role: 'user', content: 'hello' }] }
}

/**
 * 等 Go 侧**真的**有一个并发槽位被占住（`keys.status` 的 `gate` 计数）。
 *
 * 用轮询代替 sleep 魔法值：并发闸门用例要「第一个请求占住槽位后再发第二个」，
 * 机器负载高时（多个 worktree 同时 spawn 真 gatewayd）sleep 会让第二个请求赶在
 * 第一个占位之前发出 → 假失败。轮询是确定性的。
 */
async function waitForActive(
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

test('真进程：过期 key → 401 API_KEY_EXPIRED，上游 0 次', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway, { expiresAt: new Date(Date.now() - 60_000).toISOString() })

  const reply = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(reply.status, 401, reply.text)
  assert.equal(reply.json.error.code, 'API_KEY_EXPIRED')
  assert.equal(upstream.hits(), 0, '被拒的请求绝不能打到上游')

  // 换成没过期的 key：同一把 key 立刻可用（证明拒绝来自过期而不是鉴权失败）。
  await pushKeys(gateway, { expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  const ok = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(ok.status, 200, ok.text)
  assert.equal(upstream.hits(), 1)
})

test('真进程：累计消费达到金额上限 → 402 API_KEY_SPENDING_LIMIT', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway, { spendingLimitMicros: '1000' })

  // 先给一个「还没到顶」的消费快照：必须放行。
  await pushSpend(gateway, '999')
  const allowed = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(allowed.status, 200, allowed.text)
  assert.equal(upstream.hits(), 1)

  await pushSpend(gateway, '1000')
  const blocked = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(blocked.status, 402, blocked.text)
  assert.equal(blocked.json.error.code, 'API_KEY_SPENDING_LIMIT')
  assert.equal(upstream.hits(), 1, '被拒的请求绝不能打到上游')
})

test('真进程：key 并发满 → 429 API_KEY_CONCURRENCY_LIMIT，请求结束后槽位归零', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t, { delayMs: 400 })
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway, { concurrencyLimit: 1 })

  // 第一个请求占住唯一槽位（上游 400ms 才回）。等它**真的**占住再发第二个：
  // 用 keys.status 的 activeKeys 轮询，而不是 sleep 一个魔法值——机器负载高时
  // sleep 会假失败（多个 worktree 同时在跑真进程用例）。
  const first = post(gateway.httpPort, chat(), AUTH)
  await waitForActive(gateway, 'activeKeys')
  const second = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(second.status, 429, second.text)
  assert.equal(second.json.error.code, 'API_KEY_CONCURRENCY_LIMIT')

  const firstReply = await first
  assert.equal(firstReply.status, 200, firstReply.text)
  assert.equal(upstream.hits(), 1, '被并发闸门拒掉的请求绝不能打到上游')

  // 槽位必须真的还回来了（release 漏了这里会一直 429）。
  const third = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(third.status, 200, third.text)
  assert.equal(upstream.hits(), 2)

  const status = await gateway.status('keys.status')
  assert.equal(status.gate?.activeKeys ?? 0, 0, '请求结束后不能有残留槽位')
})

test('真进程：用户并发满 → 429 USER_CONCURRENCY_LIMIT（与 key 级共用一套预留）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t, { delayMs: 400 })
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  // 两把 key 都属于用户 #1；用户级上限 1，key 级不限。
  await pushKeys(gateway, { concurrencyLimit: null })
  await gateway.bridge.request('keys.replace', {
    version: 1,
    generation: nextGeneration(),
    keys: [
      { keyId: 'key-a', userId: 1, keyHash: KEY_HASH, profile: 'billed', name: 'a' },
      {
        keyId: 'key-b',
        userId: 1,
        keyHash: createHash('sha256').update('sk-dz-second', 'utf8').digest('hex'),
        profile: 'billed',
        name: 'b',
      },
    ],
  })
  await pushQuota(gateway, 1)

  const first = post(gateway.httpPort, chat(), AUTH)
  await waitForActive(gateway, 'activeUsers')
  const second = await post(
    gateway.httpPort,
    chat(),
    { authorization: 'Bearer sk-dz-second' },
  )
  assert.equal(second.status, 429, second.text)
  assert.equal(second.json.error.code, 'USER_CONCURRENCY_LIMIT')

  const firstReply = await first
  assert.equal(firstReply.status, 200, firstReply.text)
})

test('真进程：定价闸门关 → 未定价模型照常放行（默认关）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)

  const reply = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(reply.status, 200, `闸门默认关时必须放行：${reply.text}`)
  assert.equal(upstream.hits(), 1)
})

test('真进程：定价闸门开 + 模型没价 → 403 MODEL_NOT_PRICED，上游 0 次', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { pricingGate: true })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)
  await pushPrices(gateway, ['some-other-model'])

  const blocked = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(blocked.status, 403, blocked.text)
  assert.equal(blocked.json.error.code, 'MODEL_NOT_PRICED')
  assert.equal(upstream.hits(), 0)

  // 补上价目表 → 立刻放行（快照是新的，不用等 TTL）。
  await pushPrices(gateway, [MODEL])
  const ok = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(ok.status, 200, ok.text)
  assert.equal(upstream.hits(), 1)
})

test('真进程：定价闸门开 + 没有价格快照 → 503（fail-closed）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { pricingGate: true })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)

  const strict = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(strict.status, 503, strict.text)
  assert.equal(strict.json.error.code, 'PRICING_SNAPSHOT_UNAVAILABLE')
  assert.equal(upstream.hits(), 0)
})

test('真进程：价格快照超过 TTL 不再推 → 503（心跳失败的后果）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  // TTL 用 2s：机器负载高时（多个 worktree 同时跑真进程用例）1s 窗口会把
  // 「刚推完就要被判过期」变成假失败；断言本身不变（过期必须 503）。
  const gateway = await startGateway(t, { pricingGate: true, pricingTtlMs: 2_000 })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)
  await pushPrices(gateway, [MODEL])

  const fresh = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(fresh.status, 200, fresh.text)

  // 不再推任何快照，等过 TTL：闸门必须 fail-closed 而不是静默放行。
  await sleep(2_600)
  const stale = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(stale.status, 503, `超时后必须 503：${stale.text}`)
  assert.equal(stale.json.error.code, 'PRICING_SNAPSHOT_UNAVAILABLE')

  const status = await gateway.status('pricing.status')
  assert.equal(status.ready, true)
  assert.ok((status.gate?.strictBlocked ?? 0) >= 1)
})

test('真进程：有 * 兜底价 → 任何模型都放行（与 billing.hasPrice 同口径）', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { pricingGate: true })
  await pushAccounts(gateway, upstream.port)
  await pushKeys(gateway)
  await pushPrices(gateway, ['*'])

  const reply = await post(gateway.httpPort, chat(), AUTH)
  assert.equal(reply.status, 200, `有 * 时不该拒绝任何模型：${reply.text}`)
  assert.equal(upstream.hits(), 1)

  const status = await gateway.status('pricing.status')
  assert.equal(status.wildcard, true)
})
