/**
 * `server.test.ts` 系列的共用 harness（从 `server.test.ts` 抽出，§5.6）。
 *
 * 起一个真 `ApiServer`（端口 0）+ 假端口夹具，走**真 HTTP 请求**；只做请求封装、
 * cookie 提取、登录与 setup/cleanup，不含断言。断言都在各 `server-*.test.ts` 里。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { TestContext } from 'node:test'
import { ApiServer } from '../../src/http.ts'
import { createFixture, type Fixture, type FixtureOptions } from '../fixtures/index.ts'

export interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly json: any
}

export interface CallOptions {
  readonly method?: string
  readonly headers?: Record<string, string | undefined>
  readonly body?: string | Uint8Array
  readonly cookie?: string
}

export function call(server: ApiServer, path: string, options: CallOptions = {}): Promise<Reply> {
  const port = server.address?.port
  assert.ok(port !== undefined, '服务器必须已启动')
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    'x-requested-with': 'dizzyapi',
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name]
    else headers[name] = value
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie

  let body: Buffer | undefined
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? Buffer.from(options.body, 'utf8') : Buffer.from(options.body)
    headers['content-length'] = String(body.length)
    headers['content-type'] ??= 'application/json'
  }

  return new Promise<Reply>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers },
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
        })
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

export function cookieOf(reply: Reply): string {
  const raw = reply.headers['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  assert.ok(typeof value === 'string' && value !== '', '响应必须设置 cookie')
  return value.split(';')[0] as string
}

export async function setup(t: TestContext, options: FixtureOptions = {}): Promise<Fixture & { server: ApiServer }> {
  const fixture = await createFixture(options)
  const server = new ApiServer(fixture.runtime)
  await server.start(0)
  t.after(async () => {
    await server.stop()
    await fixture.cleanup()
  })
  return { ...fixture, server }
}

export async function login(
  server: ApiServer,
  email = 'owner@example.com',
  password = 'password1',
  headers: Record<string, string> = {},
): Promise<{ reply: Reply; cookie: string }> {
  const reply = await call(server, '/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password }),
  })
  assert.equal(reply.status, 200, reply.text)
  return { reply, cookie: cookieOf(reply) }
}
