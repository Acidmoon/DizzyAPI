/**
 * **真进程**用例：真 `bin/gatewayd` + 真控制桥 + 真 HTTP 入口。
 *
 * 为什么必须有这一层：内存里的假 Go 永远抓不到「Go 侧到底有没有照做」这类问题——
 * 额度闸门就吃过亏（快照不再推、TTL 一到闸门静默失效，内存用例全绿）。
 * 这里用真进程钉住四件事：
 *
 * 1. 命中 `block` 规则 → **403 `CONTENT_BLOCKED`，上游一次都没被打到**；
 * 2. 不含关键词 → 200 且上游真的被打到一次；
 * 3. **停止推送超过 TTL** → 默认策略放行（不是拦截，也不是 503），`contentaudit.status`
 *    里能读到 `stale` 与 `allowedStale` 计数；
 * 4. 严格模式（`-content-audit-require-snapshot`）+ 从没收到快照 → 503
 *    `CONTENT_AUDIT_SNAPSHOT_UNAVAILABLE`；收到「审核关闭」的快照后 → 全放行。
 *
 * 没有 `bin/gatewayd` 时整组跳过（`pnpm test` 不该要求先 `pnpm build:go`）。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer as createNetServer } from 'node:net'
import { resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { connect, type Socket } from 'node:net'
import { test, type TestContext } from 'node:test'

const BINARY = process.platform === 'win32' ? resolve('bin/gatewayd.exe') : resolve('bin/gatewayd')
const HAS_BINARY = existsSync(BINARY)
const SKIP = HAS_BINARY ? false : '没有 bin/gatewayd：先跑 pnpm build:go 才有真进程用例'

/**
 * 最小的控制桥客户端（4 字节大端长度 + UTF-8 JSON）。
 *
 * 测试里**不 import 别的插件实现包**：插件之间不互相 import，而且
 * `@dizzyapi/plugin-account-priority` 也没有导出 `src/bridge.ts` 这个子路径。
 * 这里只复刻帧格式，够用即可。
 */
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
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolvePromise(address.port)
    })
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

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(port, path, 'POST', JSON.stringify(body), headers)
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

/** 假上游：只回一条 OpenAI chat completion，并数被打了几次。 */
async function startUpstream(t: TestContext): Promise<{ port: number; hits: () => number }> {
  let hits = 0
  const server = createHttpServer((req, res) => {
    hits += 1
    // 读掉请求体，否则 keep-alive 连接会挂住。
    req.resume()
    req.on('end', () => {
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
    })
  })
  const port = await new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise((server.address() as AddressInfo).port))
  })
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
  readonly status: (method: string) => Promise<any>
  stop(): Promise<void>
}

async function startGateway(
  t: TestContext,
  options: { readonly strict?: boolean; readonly ttlMs?: number } = {},
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
    '-content-audit-snapshot-ttl-ms',
    String(options.ttlMs ?? 1_000),
    '-log-format',
    'text',
    ...(options.strict === true ? ['-content-audit-require-snapshot'] : []),
  ]
  const child: ChildProcessWithoutNullStreams = spawn(BINARY, args, { stdio: 'pipe' })
  let logs = ''
  child.stdout.on('data', (chunk: Buffer) => {
    logs += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk: Buffer) => {
    logs += chunk.toString('utf8')
  })

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null) return
    child.kill()
    for (let index = 0; index < 100; index += 1) {
      if (child.exitCode !== null) return
      await sleep(20)
    }
  }
  t.after(stop)

  // 等 HTTP 入口就绪（/healthz 200）。
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

  return {
    httpPort,
    bridge,
    status: (method: string) => bridge.request(method),
    stop,
  }
}

function snapshotWith(rules: readonly { id: string; pattern: string; action: string }[], enabled = true): unknown {
  return {
    version: 1,
    generation: Date.now(),
    revision: createHash('sha256').update(JSON.stringify({ enabled, rules })).digest('hex').slice(0, 32),
    enabled,
    rules,
  }
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
        models: ['test-model'],
        token: 'sk-smoke-token',
        priority: 1,
      },
    ],
  })
}

function chatBody(text: string): unknown {
  return { model: 'test-model', messages: [{ role: 'user', content: text }] }
}

const AUTH = { authorization: 'Bearer smoke-client-key' }

test('真进程：命中 block 规则 403 且上游一次都没被打到；未命中 200', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t)
  await pushAccounts(gateway, upstream.port)
  await gateway.bridge.request(
    'contentaudit.replace',
    snapshotWith([{ id: 'car_block', pattern: 'Forbidden-Word', action: 'block' }]),
  )

  const blocked = await post(
    gateway.httpPort,
    '/v1/chat/completions',
    chatBody('please say forbidden-word out loud'),
    AUTH,
  )
  assert.equal(blocked.status, 403, blocked.text)
  assert.equal(blocked.json.error.code, 'CONTENT_BLOCKED')
  assert.equal(upstream.hits(), 0, '被拒的请求绝不能打到上游')

  const allowed = await post(gateway.httpPort, '/v1/chat/completions', chatBody('a harmless question'), AUTH)
  assert.equal(allowed.status, 200, allowed.text)
  assert.equal(upstream.hits(), 1)

  // 大小写不敏感（规则里是大写，请求里是全小写）
  const again = await post(gateway.httpPort, '/v1/chat/completions', chatBody('FORBIDDEN-WORD'), AUTH)
  assert.equal(again.status, 403, again.text)

  const status = await gateway.status('contentaudit.status')
  assert.equal(status.enabled, true)
  // `gate.*` 的计数是 `omitempty`：0 不出现，所以按 `?? 0` 读。
  assert.equal(status.gate.blocked ?? 0, 2)
  assert.equal(status.gate.allowedStale ?? 0, 0)
  assert.equal(status.gate.ruleHits.car_block, 2)
  assert.equal(status.gate.staleStreak ?? 0, 0)
  assert.equal(upstream.hits(), 1, '两条被拒、一条放行')
})

test('真进程：停止推送超过 TTL 后默认放行，并计 allowedStale', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { ttlMs: 1_000 })
  await pushAccounts(gateway, upstream.port)
  await gateway.bridge.request(
    'contentaudit.replace',
    snapshotWith([{ id: 'car_block', pattern: 'forbidden-word', action: 'block' }]),
  )
  const fresh = await gateway.status('contentaudit.status')
  // `stale` 也是 `omitempty`：false 时键不出现，读作 `!== true`。
  assert.notEqual(fresh.stale, true)
  assert.equal(fresh.ready, true)

  // 等过 TTL：不再推任何快照。
  await sleep(1_400)
  const blockedBefore = upstream.hits()
  const reply = await post(gateway.httpPort, '/v1/chat/completions', chatBody('forbidden-word'), AUTH)
  assert.equal(reply.status, 200, `默认策略是放行，实际 ${String(reply.status)}：${reply.text}`)
  assert.equal(upstream.hits(), blockedBefore + 1, '放行之后真的去打上游了')

  const stale = await gateway.status('contentaudit.status')
  assert.equal(stale.stale, true, '快照必须被判定过期')
  assert.ok(stale.gate.allowedStale >= 1)
})

test('真进程：严格模式没有快照 503；收到「审核关闭」快照后全放行', { skip: SKIP }, async (t) => {
  const upstream = await startUpstream(t)
  const gateway = await startGateway(t, { strict: true })
  await pushAccounts(gateway, upstream.port)

  const strict = await post(gateway.httpPort, '/v1/chat/completions', chatBody('hello'), AUTH)
  assert.equal(strict.status, 503, strict.text)
  assert.equal(strict.json.error.code, 'CONTENT_AUDIT_SNAPSHOT_UNAVAILABLE')
  assert.equal(upstream.hits(), 0)

  // 推一份「审核关闭」的快照：快照可用，但规则不生效 → 全放行。
  await gateway.bridge.request('contentaudit.replace', snapshotWith([], false))
  const open = await post(gateway.httpPort, '/v1/chat/completions', chatBody('forbidden-word'), AUTH)
  assert.equal(open.status, 200, open.text)
  assert.equal(upstream.hits(), 1)
})
