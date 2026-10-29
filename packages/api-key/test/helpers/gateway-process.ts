/**
 * 真进程用例的**进程夹具**：起真 `bin/gatewayd` + 真控制桥 + 真 HTTP 入口。
 *
 * 这个文件只管「怎么把进程跑起来、怎么跟它说话」；每个用例断言什么在
 * `gateway-gates-*.test.ts` 里。
 *
 * 没有 `bin/gatewayd` 时整组跳过（`pnpm test` 不该要求先 `pnpm build:go`）。
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createServer as createNetServer, connect, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { TestContext } from 'node:test'

export const BINARY = process.platform === 'win32' ? resolve('bin/gatewayd.exe') : resolve('bin/gatewayd')
export const HAS_BINARY = existsSync(BINARY)
export const SKIP = HAS_BINARY ? false : '没有 bin/gatewayd：先跑 pnpm build:go 才有真进程用例'

/** 最小的控制桥客户端（4 字节大端长度 + UTF-8 JSON）。 */
export class MiniBridge {
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

export interface Reply {
  readonly status: number
  readonly text: string
  readonly json: any
}

export function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
  return new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise((server.address() as AddressInfo).port))
  })
}

export function freePort(): Promise<number> {
  const server = createNetServer()
  return listen(server).finally(() => {
    server.close()
  })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function request(
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

export function post(
  port: number,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return request(port, '/v1/chat/completions', 'POST', JSON.stringify(body), headers)
}

/** 假上游：回一条 OpenAI chat completion，并数被打了几次（可配延迟）。 */
export async function startUpstream(
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

export interface Gateway {
  readonly httpPort: number
  readonly bridge: MiniBridge
  status(method: string): Promise<any>
}

/** 起一个真 gatewayd：真二进制 + 真控制桥 + 真 HTTP 入口。 */
export async function startGateway(
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
