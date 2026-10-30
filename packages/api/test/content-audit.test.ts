/**
 * `/api/admin/content-audit` 的 HTTP 面测试。
 *
 * 盯住六件事：
 * 1. 管理员拿到规则列表 + 状态（含 Go 侧命中统计）；Go 读不到时是 `null`，不编造 0；
 * 2. 新增 / 修改 / 启停 / 删除都走通，非法输入与插件稳定码映射到正确状态码；
 * 3. 审计在**调用点**记，actor 是会话里的真人，元数据里**没有 pattern**；
 * 4. 审计插件抛错 / 缺席时业务写操作照常成功（审计是旁路）；
 * 5. 缺内容审核插件只让这条路由 503，入口与其它路由照常；
 * 6. 非管理员与缺少 `X-Requested-With` 的请求被挡。
 */
import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { test, type TestContext } from 'node:test'
import { ApiServer } from '../src/http.ts'
import { createFixture, type Fixture, type FixtureOptions } from './fixtures/index.ts'

interface Reply {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly text: string
  readonly json: any
}

interface CallOptions {
  readonly method?: string
  readonly headers?: Record<string, string | undefined>
  readonly body?: string
  readonly cookie?: string
}

function call(server: ApiServer, path: string, options: CallOptions = {}): Promise<Reply> {
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
    body = Buffer.from(options.body, 'utf8')
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

async function setup(t: TestContext, options: FixtureOptions = {}): Promise<Fixture & { server: ApiServer }> {
  const fixture = await createFixture(options)
  const server = new ApiServer(fixture.runtime)
  await server.start(0)
  t.after(async () => {
    await server.stop()
    await fixture.cleanup()
  })
  return { ...fixture, server }
}

async function login(server: ApiServer, email: string, password: string): Promise<string> {
  const reply = await call(server, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  assert.equal(reply.status, 200, reply.text)
  const raw = reply.headers['set-cookie']
  const value = Array.isArray(raw) ? raw[0] : raw
  assert.ok(typeof value === 'string' && value !== '')
  return value.split(';')[0] as string
}

async function adminCookie(server: ApiServer): Promise<string> {
  return login(server, 'owner@example.com', 'password1')
}

// ───────────────────────────────── 读 ─────────────────────────────────

test('管理员拿到 200：规则列表 + 状态 + Go 侧命中统计', async (t) => {
  const { server, contentAudit } = await setup(t)
  const cookie = await adminCookie(server)

  const reply = await call(server, '/api/admin/content-audit', { cookie })
  assert.equal(reply.status, 200, reply.text)

  assert.equal(reply.json.items.length, 1)
  assert.equal(reply.json.items[0].id, 'car_seed')
  assert.equal(reply.json.items[0].pattern, 'seed-word')
  assert.equal(reply.json.items[0].action, 'block')
  assert.equal(reply.json.items[0].enabled, true)

  const status = reply.json.status
  assert.equal(status.ruleCount, 1)
  assert.equal(status.enabled, true)
  assert.equal(status.pushIntervalMs, 5_000)
  assert.equal(status.goReady, true)
  assert.equal(status.ageMs, 1_200)
  assert.equal(status.ttlMs, 15_000)
  assert.equal(status.stale, false)
  assert.equal(status.heartbeatTooSlow, false)
  assert.equal(status.hits.blocked, 7)
  assert.equal(status.hits.byRule.car_seed, 10)

  // 读取用插件身份（白名单是插件名，不是人）
  assert.equal(contentAudit.calls[0]?.args[0], '@dizzyapi/plugin-api')
})

test('Go 侧读不到时状态字段是 null，不编造「新鲜、零命中」', async (t) => {
  const { server, contentAudit } = await setup(t)
  const cookie = await adminCookie(server)
  contentAudit.goOffline = true

  const reply = await call(server, '/api/admin/content-audit', { cookie })
  assert.equal(reply.status, 200, reply.text)
  for (const key of ['ageMs', 'ttlMs', 'stale', 'goReady', 'goTtlMs', 'hits']) {
    assert.equal(reply.json.status[key], null, `${key} 读不到 Go 时必须是 null`)
  }
  // 本地事实照常给
  assert.equal(reply.json.status.ruleCount, 1)
  assert.equal(reply.json.status.pushes, 11)
})

// ───────────────────────────────── 写 ─────────────────────────────────

test('新增 / 修改 / 启停 / 删除：形状正确，审计在调用点记真人 actor', async (t) => {
  const { server, contentAudit, audit } = await setup(t)
  const cookie = await adminCookie(server)

  const created = await call(server, '/api/admin/content-audit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ pattern: 'Bad-Word', action: 'log', category: 'abuse', note: '先只记日志' }),
  })
  assert.equal(created.status, 200, created.text)
  assert.equal(created.json.rule.pattern, 'Bad-Word')
  assert.equal(created.json.rule.action, 'log')
  assert.equal(created.json.rule.category, 'abuse')
  assert.equal(created.json.rule.note, '先只记日志')

  // 审计：动作码 / actor / 元数据（没有 pattern）
  const createEntry = audit.calls.at(-1) as Record<string, any>
  assert.equal(createEntry.action, 'content_audit.rule.create')
  assert.equal(createEntry.actor, 'user:1:admin')
  assert.equal(createEntry.actorPlugin, '@dizzyapi/plugin-api')
  assert.equal(createEntry.targetType, 'content-audit-rule')
  assert.equal(createEntry.result, 'ok')
  assert.equal(createEntry.metadata.action, 'log')
  assert.ok(!('pattern' in createEntry.metadata), '审计元数据不该复制关键词')
  assert.ok(!JSON.stringify(createEntry).includes('Bad-Word'), '审计里不该出现关键词本身')

  const id = created.json.rule.id as string
  const patched = await call(server, `/api/admin/content-audit/${id}`, {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(patched.status, 200, patched.text)
  assert.equal(patched.json.rule.enabled, false)
  const patchEntry = audit.calls.at(-1) as Record<string, any>
  assert.equal(patchEntry.action, 'content_audit.rule.update')
  assert.equal(patchEntry.targetId, id)
  assert.deepEqual(patchEntry.metadata.fields, ['enabled'])

  // null 清空 category
  const cleared = await call(server, `/api/admin/content-audit/${id}`, {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ category: null }),
  })
  assert.equal(cleared.status, 200, cleared.text)
  assert.equal(cleared.json.rule.category, null)

  const removed = await call(server, `/api/admin/content-audit/${id}`, { method: 'DELETE', cookie })
  assert.equal(removed.status, 200, removed.text)
  assert.equal(removed.json.removed, true)
  assert.equal((audit.calls.at(-1) as Record<string, any>).action, 'content_audit.rule.delete')

  // 再删一次：false 而不是报错；不存在的规则 GET 是 404
  const again = await call(server, `/api/admin/content-audit/${id}`, { method: 'DELETE', cookie })
  assert.equal(again.status, 200)
  assert.equal(again.json.removed, false)
  const missing = await call(server, `/api/admin/content-audit/${id}`, { cookie })
  assert.equal(missing.status, 404)
  assert.equal(missing.json.error.code, 'API_NOT_FOUND')

  assert.equal(contentAudit.calls.filter((item) => item.method === 'create').length, 1)
})

test('非法输入明确失败：未知键 / 空 patch / 坏 action / 缺 pattern', async (t) => {
  const { server } = await setup(t)
  const cookie = await adminCookie(server)

  const extra = await call(server, '/api/admin/content-audit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ pattern: 'x', surprise: 1 }),
  })
  assert.equal(extra.status, 400)
  assert.equal(extra.json.error.code, 'API_BAD_REQUEST')

  const noPattern = await call(server, '/api/admin/content-audit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ action: 'block' }),
  })
  assert.equal(noPattern.status, 400)

  const badAction = await call(server, '/api/admin/content-audit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ pattern: 'x', action: 'drop' }),
  })
  assert.equal(badAction.status, 400)

  const emptyPatch = await call(server, '/api/admin/content-audit/car_seed', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({}),
  })
  assert.equal(emptyPatch.status, 400)
  assert.equal(emptyPatch.json.error.code, 'API_BAD_REQUEST')
})

test('插件稳定码映射状态码：重复 pattern → 409，配置非法 → 500，白名单 → 403', async (t) => {
  const { server, contentAudit } = await setup(t)
  const cookie = await adminCookie(server)

  contentAudit.failCode = 'CONTENT_AUDIT_RULE_DUPLICATE'
  const duplicate = await call(server, '/api/admin/content-audit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ pattern: 'dup' }),
  })
  assert.equal(duplicate.status, 409)
  assert.equal(duplicate.json.error.code, 'CONTENT_AUDIT_RULE_DUPLICATE')

  contentAudit.failCode = 'CONTENT_AUDIT_CONFIG_INVALID'
  const invalid = await call(server, '/api/admin/content-audit/car_seed', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(invalid.status, 500, '本机配置问题不能伪装成用户输入错误')

  contentAudit.failCode = 'CONTENT_AUDIT_FORBIDDEN'
  const forbiddenReply = await call(server, '/api/admin/content-audit/car_seed', {
    method: 'PATCH',
    cookie,
    body: JSON.stringify({ enabled: true }),
  })
  assert.equal(forbiddenReply.status, 403)
})

test('立刻推送：POST /push 回 revision；失败按稳定码映射', async (t) => {
  const { server, contentAudit } = await setup(t)
  const cookie = await adminCookie(server)

  const reply = await call(server, '/api/admin/content-audit/push', { method: 'POST', cookie })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json.revision, 'rev-seed')

  contentAudit.failCode = 'CONTENT_AUDIT_GO_UNAVAILABLE'
  const failed = await call(server, '/api/admin/content-audit/push', { method: 'POST', cookie })
  assert.equal(failed.status, 503)

  // 只允许 POST
  const wrongMethod = await call(server, '/api/admin/content-audit/push', { cookie })
  assert.equal(wrongMethod.status, 405)
})

// ───────────────────────────────── 审计旁路 ─────────────────────────────────

test('审计挂了 / 缺席都不影响写操作（审计是旁路，不是前置依赖）', async (t) => {
  const { server, audit, contentAudit } = await setup(t)
  const cookie = await adminCookie(server)
  audit.failRecord = true

  const created = await call(server, '/api/admin/content-audit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ pattern: 'audit-down' }),
  })
  assert.equal(created.status, 200, '审计抛错不能让写操作变 500')
  assert.equal(created.json.rule.pattern, 'audit-down')
  assert.equal(contentAudit.list('@dizzyapi/plugin-api').length, 2)

  const without = await setup(t, { withoutAudit: true })
  const cookie2 = await adminCookie(without.server)
  const reply = await call(without.server, '/api/admin/content-audit', {
    method: 'POST',
    cookie: cookie2,
    body: JSON.stringify({ pattern: 'no-audit-plugin' }),
  })
  assert.equal(reply.status, 200, reply.text)
})

// ───────────────────────────────── 缺席 / 权限 ─────────────────────────────────

test('缺内容审核插件：只这条路由 503，入口与其它路由照常', async (t) => {
  const { server } = await setup(t, { withoutContentAudit: true })
  const cookie = await adminCookie(server)

  const reply = await call(server, '/api/admin/content-audit', { cookie })
  assert.equal(reply.status, 503)
  assert.equal(reply.json.error.code, 'CONTENT_AUDIT_UNAVAILABLE')
  assert.equal((await call(server, '/api/health')).status, 200)
  assert.equal((await call(server, '/api/admin/audit', { cookie })).status, 200)
})

test('非管理员 403；缺 X-Requested-With 403；未登录 401', async (t) => {
  const { server } = await setup(t)
  const user = await login(server, 'alice@example.com', 'password2')

  const denied = await call(server, '/api/admin/content-audit', { cookie: user })
  assert.equal(denied.status, 403)
  assert.equal(denied.json.error.code, 'API_FORBIDDEN')

  const missingHeader = await call(server, '/api/admin/content-audit', {
    headers: { 'x-requested-with': undefined },
  })
  assert.equal(missingHeader.status, 403)

  const anonymous = await call(server, '/api/admin/content-audit')
  assert.equal(anonymous.status, 401)
})

test('读接口不接受写方法（GET 路由不被 POST 顶掉）', async (t) => {
  const { server } = await setup(t)
  const cookie = await adminCookie(server)

  const reply = await call(server, '/api/admin/content-audit/car_seed', {
    method: 'PUT',
    cookie,
    body: JSON.stringify({ enabled: false }),
  })
  assert.equal(reply.status, 405)
  assert.deepEqual(reply.headers.allow, 'GET, HEAD, PATCH, DELETE')
})
