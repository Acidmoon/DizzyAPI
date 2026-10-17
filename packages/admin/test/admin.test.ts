/**
 * 面板的集成用例：真 Loader、真插件树、真 HTTP 服务（`port: 0` 让系统分配端口）。
 *
 * 三个必须用真的理由：
 *
 * 1. 依赖图的数据源是 `ctx.loader.entries()` 与根服务表，`ctx.plugin()` 造不出 entry；
 * 2. 重启走的是 `fiber.update(config, true)`，要验证它不对 `app.yml` 动手，只能用真树；
 * 3. 停机、SSE、D5 回收都跟真实 socket 与 fiber 生命周期有关，假不了。
 *
 * 退出那条用例刻意 mock 了 `process.exit`：路由的默认行为就是退出进程，
 * 真让它跑，后面的用例就没了。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader'
import AdminService, { ADMIN_ACTOR } from '../src/index.ts'
import type { AdminGraph, AdminPluginNode, AdminServiceNode } from '../src/introspect.ts'

/** 与 settings 测试同样的类型缺口补丁：`create` 的声明漏了 `id`，实现却原样采用它。 */
function createEntry(ctx: Context, options: Omit<EntryOptions, 'id'> & { id?: string }): Promise<string> {
  return ctx.loader.create(options as Omit<EntryOptions, 'id'>)
}

/** 拿原始服务实例。`ctx.get()` 返回的是 traced proxy，一 inspect 就炸（AGENTS.md §10）。 */
function raw<T>(ctx: Context, name: string): T {
  const impl = ctx.root.reflect._getImpl(name, false)
  assert.ok(impl !== undefined, `服务 ${name} 不存在`)
  return impl.value as T
}

interface World {
  readonly ctx: Context
  readonly admin: AdminService
}

async function boot(
  options: { admin?: Record<string, unknown>; settingsAdmin?: string[]; withSettings?: boolean } = {},
): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await createEntry(ctx, { id: 'user', name: '@dizzyapi/plugin-user', config: {} })
  await createEntry(ctx, { id: 'mailer', name: '@dizzyapi/plugin-mailer', config: { transport: 'log' } })
  await createEntry(ctx, { id: 'auth', name: '@dizzyapi/plugin-auth', config: {} })
  if (options.withSettings !== false) {
    await createEntry(ctx, {
      id: 'settings',
      name: '@dizzyapi/plugin-settings',
      config: { adminPlugins: options.settingsAdmin ?? [ADMIN_ACTOR] },
    })
  }
  // 一个被禁用的入口：重启必须报 ADMIN_PLUGIN_DISABLED，而不是「找不到」。
  await createEntry(ctx, { id: 'off', name: '@dizzyapi/plugin-settings', disabled: true })
  // 一个分组：它不是插件，没有「重启」这回事。
  await createEntry(ctx, { id: 'grp', name: '@cordisjs/plugin-group', config: [] })
  await createEntry(ctx, {
    id: 'admin',
    name: '@dizzyapi/plugin-admin',
    config: { port: 0, ...options.admin },
  })
  await ctx.loader.await()
  return { ctx, admin: raw<AdminService>(ctx, 'admin') }
}

async function dispose(world: World): Promise<void> {
  await world.ctx.root.fiber.dispose()
}

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
}

function call(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

/** 用一次性 token 换 cookie。返回值直接当 Cookie 头用。 */
async function exchange(admin: AdminService): Promise<string> {
  const url = admin.bootstrapUrl
  assert.ok(url !== undefined, 'bootstrapUrl 应该存在')
  const reply = await call(url)
  assert.equal(reply.status, 303, '兑换成功应该 303 回 /')
  const setCookie = reply.headers['set-cookie']
  assert.ok(setCookie !== undefined && setCookie.length > 0, '应该下发 cookie')
  return setCookie[0].split(';')[0]
}

function withCookie(cookie: string, extra: Record<string, string> = {}): Record<string, string> {
  return { cookie, 'x-panel-request': '1', ...extra }
}

/** 面板 API 的简写：带 cookie 与自定义头。 */
function api(
  world: World,
  cookie: string,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const base = world.admin.url
  assert.ok(base !== undefined)
  return call(`${base}${path}`, {
    method: init.method,
    body: init.body,
    headers: withCookie(cookie, {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    }),
  })
}

function json<T>(reply: Reply): T {
  assert.ok(reply.text.length > 0, '响应应该有 body')
  return JSON.parse(reply.text) as T
}

function errorCode(reply: Reply): string {
  return json<{ error: { code: string } }>(reply).error.code
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(predicate(), '等待超时')
}

/** 最小的 SSE 客户端：攒帧、等事件、可主动关闭。 */
class SseClient {
  readonly frames: string[] = []
  private buffer = ''
  private readonly req: ClientRequest
  private ended = false

  constructor(url: string, headers: Record<string, string>) {
    this.req = httpRequest(url, { headers }, (res) => {
      assert.equal(res.statusCode, 200, 'SSE 应该 200')
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        this.buffer += chunk
        let index: number
        while ((index = this.buffer.indexOf('\n\n')) >= 0) {
          const frame = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + 2)
          this.frames.push(frame)
        }
      })
      res.on('end', () => {
        this.ended = true
      })
      res.on('error', () => {
        this.ended = true
      })
    })
    this.req.on('error', () => {
      this.ended = true
    })
    this.req.end()
  }

  async waitForEvent(event: string, timeoutMs = 3000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      for (const frame of this.frames) {
        const lines = frame.split('\n')
        if (!lines.includes(`event: ${event}`)) continue
        const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim())
        if (data.length > 0) return JSON.parse(data.join('\n')) as unknown
      }
      if (Date.now() > deadline) assert.fail(`没等到 SSE 事件 ${event}，已收到：${this.frames.join(' | ')}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  close(): void {
    this.req.destroy()
  }

  get isEnded(): boolean {
    return this.ended
  }
}

function sse(world: World, cookie: string, extra: Record<string, string> = {}): SseClient {
  const base = world.admin.url
  assert.ok(base !== undefined)
  return new SseClient(`${base}/api/events`, withCookie(cookie, extra))
}

function pluginNode(graph: AdminGraph, id: string): AdminPluginNode {
  const node = graph.plugins.find((plugin) => plugin.id === id)
  assert.ok(node !== undefined, `图里没有插件 ${id}`)
  return node
}

function serviceNode(graph: AdminGraph, name: string): AdminServiceNode {
  const node = graph.services.find((service) => service.name === name)
  assert.ok(node !== undefined, `图里没有服务 ${name}`)
  return node
}

// ────────────────────────────────────────────────────────────────────────────

test('配置：port 0 起在回环上，bootstrapUrl 自带一次性 token', async () => {
  const world = await boot()
  try {
    const address = world.admin.address
    assert.ok(address !== undefined, '应该已经监听')
    assert.equal(address.host, '127.0.0.1')
    assert.ok(address.port > 0, 'port 0 应该换成真实端口')
    assert.equal(world.admin.listening, true)

    const url = world.admin.bootstrapUrl
    assert.ok(url !== undefined)
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{48}$/)
  } finally {
    await dispose(world)
  }
})

test('鉴权：token 只能换一次，cookie + 自定义头 + Host 三道闸', async () => {
  const world = await boot()
  try {
    const tokenUrl = world.admin.bootstrapUrl
    assert.ok(tokenUrl !== undefined)
    const cookie = await exchange(world.admin)
    assert.equal(world.admin.bootstrapUrl, undefined, '换过之后 token 应该失效')

    // 同一个 token 再来一次，没有 cookie：拒绝。
    const replay = await call(tokenUrl)
    assert.equal(replay.status, 401)
    assert.equal(errorCode(replay), 'ADMIN_BOOTSTRAP_TOKEN_INVALID')

    // 有 cookie 再点一次：放行（刷新页面的场景）。
    const again = await call(tokenUrl, { headers: { cookie } })
    assert.equal(again.status, 303)

    const base = world.admin.url as string

    const noCookie = await call(`${base}/api/overview`, { headers: { 'x-panel-request': '1' } })
    assert.equal(noCookie.status, 401)
    assert.equal(errorCode(noCookie), 'ADMIN_UNAUTHORIZED')

    const noHeader = await call(`${base}/api/overview`, { headers: { cookie } })
    assert.equal(noHeader.status, 403)
    assert.equal(errorCode(noHeader), 'ADMIN_REQUEST_HEADER_REQUIRED')

    const badHost = await call(`${base}/api/overview`, { headers: withCookie(cookie, { host: 'evil.test' }) })
    assert.equal(badHost.status, 403)
    assert.equal(errorCode(badHost), 'ADMIN_HOST_INVALID')

    // localhost 也是回环名字：手敲地址、浏览器预览都靠它。
    const port = world.admin.address?.port
    const viaLocalhost = await call(`http://127.0.0.1:${port}/api/overview`, {
      headers: withCookie(cookie, { host: `localhost:${port}` }),
    })
    assert.equal(viaLocalhost.status, 200)

    const crossOrigin = await call(`${base}/api/settings/reset`, {
      method: 'POST',
      body: JSON.stringify({ ns: 'mailer' }),
      headers: withCookie(cookie, { origin: 'http://evil.test', 'content-type': 'application/json' }),
    })
    assert.equal(crossOrigin.status, 403)
    assert.equal(errorCode(crossOrigin), 'ADMIN_ORIGIN_INVALID')

    const crossSite = await call(`${base}/api/overview`, {
      headers: withCookie(cookie, { 'sec-fetch-site': 'cross-site' }),
    })
    assert.equal(crossSite.status, 403)

    // 正路仍然通。
    const ok = await api(world, cookie, '/api/overview')
    assert.equal(ok.status, 200)
  } finally {
    await dispose(world)
  }
})

test('图：插件、服务、方法枚举与消费者', async () => {
  const world = await boot()
  try {
    const cookie = await exchange(world.admin)
    const graph = json<AdminGraph>(await api(world, cookie, '/api/graph'))

    const settings = pluginNode(graph, 'settings')
    assert.equal(settings.state, 'active')
    assert.ok(settings.provides.includes('settings'))
    assert.ok(settings.resolvedInject.includes('loader'), 'loader 依赖应该解析成功')

    const adminNode = pluginNode(graph, 'admin')
    assert.equal(adminNode.state, 'active')
    assert.equal(adminNode.restartable, false, '面板不能重启自己')
    assert.equal(adminNode.restartBlockedCode, 'self')

    const off = pluginNode(graph, 'off')
    assert.equal(off.state, 'disabled')
    assert.equal(off.restartBlockedCode, 'disabled')

    const group = pluginNode(graph, 'grp')
    assert.equal(group.kind, 'group')
    assert.equal(group.restartBlockedCode, 'group', '分组不是可重启的插件')

    const settingsService = serviceNode(graph, 'settings')
    const methodNames = settingsService.methods.map((method) => method.name)
    for (const expected of ['describe', 'update', 'reset']) assert.ok(methodNames.includes(expected), expected)
    assert.ok(!methodNames.some((name) => name.startsWith('_')), '私有方法不该出现')

    // mailer 的消费者里应该有 auth（它 static inject = ['user', 'mailer']）。
    const mailer = serviceNode(graph, 'mailer')
    assert.ok(
      mailer.consumers.some((consumer) => consumer.pluginId === 'auth'),
      `auth 应该消费 mailer，实际：${JSON.stringify(mailer.consumers)}`,
    )
    assert.equal(mailer.provider.pluginId, 'mailer')
  } finally {
    await dispose(world)
  }
})

test('设置：读、改、恢复基线', async () => {
  const world = await boot()
  try {
    const cookie = await exchange(world.admin)

    const view = json<{
      actor: string
      namespaces: {
        ns: string
        writable: boolean
        overridden: boolean
        revision: string | null
        fields: { path: string; writable: boolean; value?: unknown }[]
      }[]
    }>(await api(world, cookie, '/api/settings'))
    assert.equal(view.actor, ADMIN_ACTOR)

    const mailer = view.namespaces.find((ns) => ns.ns === 'mailer')
    assert.ok(mailer !== undefined, '应该能看到 mailer 的命名空间')
    assert.equal(mailer.writable, true)
    const writable = mailer.fields.filter((field) => field.writable)
    assert.ok(writable.length > 0, 'mailer 应该有可写字段')

    const update = await api(world, cookie, '/api/settings/update', {
      method: 'POST',
      body: JSON.stringify({ ns: 'mailer', patch: { heloDomain: 'panel.example' } }),
    })
    assert.equal(update.status, 200, update.text)
    const updated = json<{ revision: string | null; overridden: boolean }>(update)
    assert.equal(updated.overridden, true)
    assert.ok(updated.revision !== null)

    const reset = await api(world, cookie, '/api/settings/reset', {
      method: 'POST',
      body: JSON.stringify({ ns: 'mailer' }),
    })
    assert.equal(reset.status, 200, reset.text)
    assert.equal(json<{ revision: string | null }>(reset).revision, null)
  } finally {
    await dispose(world)
  }
})

test('设置：白名单里没有面板 → 403；没有设置插件 → 503', async () => {
  const denied = await boot({ settingsAdmin: [] })
  try {
    const cookie = await exchange(denied.admin)
    const reply = await api(denied, cookie, '/api/settings/update', {
      method: 'POST',
      body: JSON.stringify({ ns: 'mailer', patch: { heloDomain: 'x' } }),
    })
    assert.equal(reply.status, 403)
    assert.equal(errorCode(reply), 'SETTINGS_ACTOR_FORBIDDEN')
  } finally {
    await dispose(denied)
  }

  const bare = await boot({ withSettings: false })
  try {
    const cookie = await exchange(bare.admin)
    const reply = await api(bare, cookie, '/api/settings')
    assert.equal(reply.status, 503)
    assert.equal(errorCode(reply), 'ADMIN_SETTINGS_UNAVAILABLE')
  } finally {
    await dispose(bare)
  }
})

test('重启：实例换了、级联到 auth、沿途各类拒绝', async (t: TestContext) => {
  const world = await boot()
  try {
    const cookie = await exchange(world.admin)

    const before = raw<unknown>(world.ctx, 'mailer')
    const touched = new Set<string>()
    const off = world.ctx.root.on('internal/service', (name: string) => touched.add(name), { global: true })
    try {
      const reply = await api(world, cookie, '/api/plugins/restart', {
        method: 'POST',
        body: JSON.stringify({ id: 'mailer' }),
      })
      assert.equal(reply.status, 200, reply.text)
      const result = json<{ id: string; state: string; cascaded: { id: string }[] }>(reply)
      assert.equal(result.id, 'mailer')
      assert.equal(result.state, 'active')
      assert.ok(
        result.cascaded.some((item) => item.id === 'auth'),
        `auth 应该被列为级联目标：${JSON.stringify(result.cascaded)}`,
      )
    } finally {
      off()
    }

    assert.notEqual(raw<unknown>(world.ctx, 'mailer'), before, '重启后应该是新实例')
    assert.ok(touched.has('mailer'), 'mailer 应该被重新提供')
    assert.ok(touched.has('auth'), 'auth 应该跟着重启（它注入了 mailer）')

    const self = await api(world, cookie, '/api/plugins/restart', {
      method: 'POST',
      body: JSON.stringify({ id: 'admin' }),
    })
    assert.equal(self.status, 409)
    assert.equal(errorCode(self), 'ADMIN_PLUGIN_SELF_RESTART')

    const off404 = await api(world, cookie, '/api/plugins/restart', {
      method: 'POST',
      body: JSON.stringify({ id: 'nope' }),
    })
    assert.equal(off404.status, 404)
    assert.equal(errorCode(off404), 'ADMIN_PLUGIN_NOT_FOUND')

    const disabled = await api(world, cookie, '/api/plugins/restart', {
      method: 'POST',
      body: JSON.stringify({ id: 'off' }),
    })
    assert.equal(disabled.status, 409)
    assert.equal(errorCode(disabled), 'ADMIN_PLUGIN_DISABLED')

    const group = await api(world, cookie, '/api/plugins/restart', {
      method: 'POST',
      body: JSON.stringify({ id: 'grp' }),
    })
    assert.equal(group.status, 409)
    assert.equal(errorCode(group), 'ADMIN_PLUGIN_NOT_RESTARTABLE')

    t.diagnostic(`重启期间被重新提供的服务：${[...touched].join(', ')}`)
  } finally {
    await dispose(world)
  }
})

test('重启失败的插件：会用 update 重试一次并把真实错误报出来', async () => {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await createEntry(ctx, { id: 'admin', name: '@dizzyapi/plugin-admin', config: { port: 0 } })
  // transport: smtp 缺 from / smtp → 启动时校验失败，fiber 停在 FAILED。
  await createEntry(ctx, { id: 'broken', name: '@dizzyapi/plugin-mailer', config: { transport: 'smtp' } })
  await ctx.loader.await()
  const admin = raw<AdminService>(ctx, 'admin')
  const world: World = { ctx, admin }

  try {
    const cookie = await exchange(admin)
    const graph = json<AdminGraph>(await api(world, cookie, '/api/graph'))
    const broken = pluginNode(graph, 'broken')
    assert.equal(broken.state, 'failed')
    assert.equal(broken.restartable, true, 'FAILED 的 fiber 仍然可以「重试」')

    const reply = await api(world, cookie, '/api/plugins/restart', {
      method: 'POST',
      body: JSON.stringify({ id: 'broken' }),
    })
    assert.equal(reply.status, 500)
    assert.equal(errorCode(reply), 'ADMIN_RESTART_FAILED')
    // 关键是报的是真实原因，而不是「什么都没发生」
    assert.match(json<{ error: { message: string } }>(reply).error.message, /transport 为 smtp 时必须配置 from/)
  } finally {
    await dispose(world)
  }
})

test('概览：进程、内存、CPU、事件循环都是有限数值', async () => {
  const world = await boot()
  try {
    const cookie = await exchange(world.admin)
    const overview = json<{
      process: { pid: number; node: string; uptimeSec: number }
      memory: { rss: number; heapUsed: number }
      cpu: { percent: number; cores: number; load1: number }
      eventLoop: { meanMs: number; maxMs: number; p50Ms: number; p99Ms: number }
      server: { host: string; port: number; sseClients: number }
      plugins: Record<string, number>
    }>(await api(world, cookie, '/api/overview'))

    assert.equal(overview.process.pid, process.pid)
    assert.ok(overview.process.node.startsWith('v'))
    assert.ok(overview.memory.rss > 0)
    assert.ok(overview.memory.heapUsed > 0)
    assert.ok(Number.isFinite(overview.cpu.percent))
    assert.ok(overview.cpu.cores >= 1)
    assert.ok(Number.isFinite(overview.cpu.load1))
    for (const value of Object.values(overview.eventLoop)) assert.ok(Number.isFinite(value), String(value))
    assert.equal(overview.server.host, '127.0.0.1')
    assert.equal(overview.server.port, world.admin.address?.port)
    assert.ok((overview.plugins.active ?? 0) >= 4)
  } finally {
    await dispose(world)
  }
})

test('SSE：hello、概览推送、心跳、断开后归零、超过上限 503', async () => {
  const world = await boot({ admin: { overviewIntervalMs: 500, sseHeartbeatMs: 1000 } })
  try {
    const cookie = await exchange(world.admin)
    const client = sse(world, cookie)
    try {
      const hello = (await client.waitForEvent('hello')) as { ok: boolean }
      assert.equal(hello.ok, true)

      const overview = (await client.waitForEvent('overview', 4000)) as { server: { sseClients: number } }
      assert.equal(overview.server.sseClients, 1)
      await waitFor(() => world.admin.sseClientCount === 1)

      // 心跳是注释行，浏览器忽略它，但连接因此不会静默超时。
      await waitFor(() => client.frames.some((frame) => frame.trim() === ': ping'), 4000)
    } finally {
      client.close()
    }
    await waitFor(() => world.admin.sseClientCount === 0, 3000)
  } finally {
    await dispose(world)
  }

  const capped = await boot({ admin: { maxSseClients: 1 } })
  try {
    const cookie = await exchange(capped.admin)
    const first = sse(capped, cookie)
    try {
      await first.waitForEvent('hello')
      await waitFor(() => capped.admin.sseClientCount === 1)
      const reply = await api(capped, cookie, '/api/events')
      assert.equal(reply.status, 503)
      assert.equal(errorCode(reply), 'ADMIN_TOO_MANY_SSE_CLIENTS')
    } finally {
      first.close()
    }
  } finally {
    await dispose(capped)
  }
})

test('退出：shutdown 幂等、端口关闭、发出 exit 事件，但不动 process.exit', async () => {
  const world = await boot()
  const signals: string[] = []
  const off = world.ctx.on('exit', async (signal) => {
    signals.push(signal)
  })
  try {
    const base = world.admin.url as string
    await world.admin.shutdown()
    await world.admin.shutdown()

    assert.deepEqual(signals, ['SIGTERM'], 'exit 事件应该恰好发一次')
    assert.equal(world.admin.listening, false)

    await assert.rejects(call(`${base}/api/overview`), /ECONNREFUSED/)
  } finally {
    off()
    await dispose(world)
  }
})

test('退出路由：202 之后调 onExit(0)', async (t: TestContext) => {
  const exit = t.mock.method(process, 'exit', () => undefined as never)
  const world = await boot()
  try {
    const cookie = await exchange(world.admin)
    const reply = await api(world, cookie, '/api/shutdown', { method: 'POST', body: '{}' })
    assert.equal(reply.status, 202)

    await waitFor(() => exit.mock.callCount() === 1, 3000)
    assert.deepEqual(exit.mock.calls[0].arguments, [0])
  } finally {
    await dispose(world)
  }
})

test('D5：面板被卸载后端口关闭、SSE 断开、不留定时器', async () => {
  const world = await boot({ admin: { overviewIntervalMs: 500 } })
  try {
    const cookie = await exchange(world.admin)
    const base = world.admin.url as string
    const client = sse(world, cookie)
    await client.waitForEvent('hello')
    await waitFor(() => world.admin.sseClientCount === 1)

    await world.ctx.root.fiber.dispose()

    await waitFor(() => client.isEnded, 3000)
    assert.equal(world.admin.sseClientCount, 0)
    await assert.rejects(call(`${base}/api/overview`), /ECONNREFUSED/)
  } finally {
    // dispose 也是幂等的；能走到这里说明事件循环没被吊住。
  }
})

test('请求体与路由：坏 JSON 400、超限 413、方法 405、未知路径 404', async () => {
  const world = await boot({ admin: { bodyLimitBytes: 1024 } })
  try {
    const cookie = await exchange(world.admin)
    const base = world.admin.url as string

    const bad = await api(world, cookie, '/api/settings/reset', { method: 'POST', body: '{oops' })
    assert.equal(bad.status, 400)
    assert.equal(errorCode(bad), 'ADMIN_BODY_INVALID')

    const huge = await api(world, cookie, '/api/settings/reset', {
      method: 'POST',
      body: JSON.stringify({ ns: 'x'.repeat(2048) }),
    })
    assert.equal(huge.status, 413)
    assert.equal(errorCode(huge), 'ADMIN_BODY_TOO_LARGE')

    const wrongMethod = await call(`${base}/api/overview`, { method: 'POST', headers: withCookie(cookie), body: '{}' })
    assert.equal(wrongMethod.status, 405)
    assert.equal(errorCode(wrongMethod), 'ADMIN_METHOD_NOT_ALLOWED')

    const nowhere = await api(world, cookie, '/api/nope')
    assert.equal(nowhere.status, 404)
    assert.equal(errorCode(nowhere), 'ADMIN_ROUTE_NOT_FOUND')

    const page = await call(`${base}/`)
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-type']), /text\/html/)
  } finally {
    await dispose(world)
  }
})

test('页面：不需要 cookie 也能拿到单页，且不含任何数据', async () => {
  const world = await boot()
  try {
    const base = world.admin.url as string
    const page = await call(`${base}/`)
    assert.equal(page.status, 200)
    assert.ok(page.text.includes('DizzyAPI · 控制面板'))
    assert.ok(!page.text.includes('dizzyapi_admin='), '页面里不该出现 cookie')
    assert.ok(!page.text.includes('?t='), '页面里不该出现 token')
  } finally {
    await dispose(world)
  }
})
