/**
 * 审计插件的测试。
 *
 * 覆盖：写入与读回（字段 / 时间 / actor）、分页与筛选（actor / action / target / 时间范围）、
 * 汇总口径、动作码与错误码校验、读权限白名单、**脱敏**（键名 + 值形状双闸）、
 * 保留期清理只删过期、配置非法明确失败。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context } from 'cordis'
import AuditService, {
  AuditError,
  redactText,
  sanitizeMetadata,
  validateAuditConfig,
  type AuditConfig,
} from '../src/index.ts'

const READER = '@dizzyapi/plugin-api'

interface World {
  readonly service: AuditService
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, config: AuditConfig = {}): Promise<World> {
  const ctx = new Context()
  // 默认 `:memory:`：用例之间不共享库，也绝不碰仓库里的 data/。
  const fiber = await ctx.plugin(AuditService, { dataPath: ':memory:', adminPlugins: [READER], ...config })
  const service = ctx.get('audit') as AuditService
  const dispose = async (): Promise<void> => {
    await fiber.dispose()
  }
  t.after(async () => {
    try {
      await dispose()
    } catch {
      // fiber.dispose() 返回 void；测试清理忽略异常。
    }
  })
  return { service, dispose }
}

/** 写一条最简记录（摘要 + 动作），时间可控。 */
function write(
  service: AuditService,
  patch: Partial<Parameters<AuditService['record']>[0]> = {},
): ReturnType<AuditService['record']> {
  return service.record({
    actor: 'user:2:admin',
    actorPlugin: '@dizzyapi/plugin-api',
    action: 'user.balance.adjust',
    targetType: 'user',
    targetId: '7',
    summary: '管理员调整用户 #7 余额',
    atMs: Date.UTC(2026, 9, 19, 12, 0, 0),
    ...patch,
  })
}

// ───────────────────────────────── 写入与读回 ─────────────────────────────────

test('写一条记录后能查出来：字段完整、时间与 actor 正确', async (t) => {
  const { service } = await boot(t)
  const written = write(service, {
    metadata: { deltaMicros: '1500000', balanceAfterMicros: '9000000' },
  })
  assert.ok(written.id > 0)
  assert.equal(written.at, '2026-10-19T12:00:00.000Z')

  const page = service.list(READER)
  assert.equal(page.total, 1)
  const row = page.items[0]
  assert.ok(row !== undefined)
  assert.equal(row.actor, 'user:2:admin')
  assert.equal(row.actorPlugin, '@dizzyapi/plugin-api')
  assert.equal(row.action, 'user.balance.adjust')
  assert.equal(row.targetType, 'user')
  assert.equal(row.targetId, '7')
  assert.equal(row.summary, '管理员调整用户 #7 余额')
  assert.deepEqual(row.metadata, { deltaMicros: '1500000', balanceAfterMicros: '9000000' })
  assert.equal(row.result, 'ok')
  assert.equal(row.errorCode, null)
  assert.equal(row.atMs, Date.UTC(2026, 9, 19, 12, 0, 0))
})

test('失败也记：result=failed 必须带稳定码，成功带码被明确拒绝', async (t) => {
  const { service } = await boot(t)
  write(service, {
    action: 'topup.order.confirm',
    result: 'failed',
    errorCode: 'TOPUP_BALANCE_FAILED',
    summary: '确认到账失败：加余额被拒绝',
  })
  const row = service.list(READER).items[0]
  assert.equal(row?.result, 'failed')
  assert.equal(row?.errorCode, 'TOPUP_BALANCE_FAILED')

  assert.throws(
    () => write(service, { result: 'ok', errorCode: 'TOPUP_BALANCE_FAILED' }),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ENTRY_INVALID',
  )
})

test('动作码必须是稳定英文点分码：自然语言 / 带变量的动作码明确拒绝', async (t) => {
  const { service } = await boot(t)
  for (const action of ['管理员改余额', 'user.balance.adjust #7', 'User.Balance', 'user', 'user..x']) {
    assert.throws(
      () => write(service, { action }),
      (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ENTRY_INVALID',
      `应当拒绝：${action}`,
    )
  }
  assert.equal(service.count(), 0)
})

test('必填字段：actor / actorPlugin / summary 为空或含控制字符都拒绝', async (t) => {
  const { service } = await boot(t)
  for (const patch of [
    { actor: '  ' },
    { actorPlugin: '' },
    { summary: '' },
    { summary: '带\n换行' },
  ]) {
    assert.throws(
      () => write(service, patch),
      (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ENTRY_INVALID',
    )
  }
})

// ───────────────────────────────── 分页与筛选 ─────────────────────────────────

test('分页：按时间倒序，limit / offset 生效，total 是未分页的总数', async (t) => {
  const { service } = await boot(t)
  for (let index = 0; index < 25; index += 1) {
    write(service, {
      targetId: String(index),
      atMs: Date.UTC(2026, 9, 19, 12, 0, index),
      summary: `第 ${index} 次调整`,
    })
  }
  const first = service.list(READER, { limit: 10 })
  assert.equal(first.total, 25)
  assert.equal(first.items.length, 10)
  assert.equal(first.items[0]?.targetId, '24')
  assert.equal(first.items[9]?.targetId, '15')

  const second = service.list(READER, { limit: 10, offset: 10 })
  assert.equal(second.items[0]?.targetId, '14')

  const last = service.list(READER, { limit: 10, offset: 20 })
  assert.equal(last.items.length, 5)
  assert.equal(last.items[4]?.targetId, '0')
})

test('筛选：actor / action / target / 时间范围都能组合', async (t) => {
  const { service } = await boot(t)
  const base = Date.UTC(2026, 9, 19, 12, 0, 0)
  write(service, { action: 'user.balance.adjust', actor: 'user:2:admin', targetId: '7', atMs: base })
  write(service, {
    action: 'pricing.write',
    actor: 'user:2:admin',
    targetType: 'pricing',
    targetId: 'deepseek-chat',
    actorPlugin: '@dizzyapi/plugin-web',
    atMs: base + 1000,
  })
  write(service, {
    action: 'user.balance.adjust',
    actor: 'user:3:admin',
    targetId: '9',
    atMs: base + 2000,
  })

  assert.equal(service.list(READER, { actor: 'user:3:admin' }).total, 1)
  assert.equal(service.list(READER, { action: 'user.balance.adjust' }).total, 2)
  assert.equal(service.list(READER, { targetType: 'pricing' }).items[0]?.targetId, 'deepseek-chat')
  assert.equal(service.list(READER, { actorPlugin: '@dizzyapi/plugin-web' }).total, 1)
  assert.equal(service.list(READER, { targetId: '9' }).total, 1)
  assert.equal(service.list(READER, { fromMs: base, toMs: base + 1500 }).total, 2)
  assert.equal(service.list(READER, { fromMs: base + 1500 }).total, 1)
  assert.throws(
    () => service.list(READER, { fromMs: base + 2000, toMs: base }),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_QUERY_INVALID',
  )
  assert.throws(
    () => service.list(READER, { limit: 0 }),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_QUERY_INVALID',
  )
})

test('汇总：总量、今天、24 小时、失败数与 Top 动作 / 操作者', async (t) => {
  const { service } = await boot(t)
  const now = Date.UTC(2026, 9, 19, 12, 0, 0)
  write(service, { action: 'user.balance.adjust', actor: 'user:2:admin', atMs: now - 3_600_000 })
  write(service, { action: 'user.balance.adjust', actor: 'user:2:admin', atMs: now - 60_000 })
  write(service, {
    action: 'settings.write',
    actor: 'user:3:admin',
    atMs: now - 30 * 86_400_000,
    result: 'failed',
    errorCode: 'SETTINGS_CONFLICT',
  })

  const stats = service.stats(READER, now)
  assert.equal(stats.total, 3)
  assert.equal(stats.today, 2)
  assert.equal(stats.last24h, 2)
  assert.equal(stats.failed, 1)
  assert.equal(stats.lastAt, new Date(now - 60_000).toISOString())
  assert.deepEqual(stats.byAction, [
    { action: 'user.balance.adjust', count: 2 },
    { action: 'settings.write', count: 1 },
  ])
  assert.deepEqual(stats.byActor, [
    { actor: 'user:2:admin', count: 2 },
    { actor: 'user:3:admin', count: 1 },
  ])
})

// ───────────────────────────────── 读权限 ─────────────────────────────────

test('读权限：不在 adminPlugins 的插件一律 AUDIT_ACTOR_FORBIDDEN；空名是 ACTOR_REQUIRED', async (t) => {
  const { service } = await boot(t)
  write(service)
  assert.throws(
    () => service.list('@dizzyapi/plugin-evil'),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ACTOR_FORBIDDEN',
  )
  assert.throws(
    () => service.list(''),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ACTOR_REQUIRED',
  )
  assert.throws(
    () => service.stats('@dizzyapi/plugin-evil'),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ACTOR_FORBIDDEN',
  )
  // 空白名单 = 谁都不许读（默认拒绝）。
  const locked = await boot(t, { adminPlugins: [] })
  assert.throws(
    () => locked.service.list(READER),
    (error: unknown) => error instanceof AuditError && error.code === 'AUDIT_ACTOR_FORBIDDEN',
  )
})

// ───────────────────────────────── 脱敏 ─────────────────────────────────

test('脱敏：键名命中的字段整棵替换，值形状命中的替换那一段', async (t) => {
  const { service } = await boot(t)
  write(service, {
    action: 'account.import_credentials',
    targetType: 'account',
    targetId: 'acc-1',
    summary: '导入凭据：收到 sk-live-abcdef123456',
    metadata: {
      password: 'hunter2',
      token: 'tok_abcdefgh',
      secret: 's3cr3t',
      credential: { value: 'sk-inside-object' },
      nested: { accessToken: 'eyJhbGciOi', note: 'Bearer abcdefghijklmnop' },
      safe: { model: 'deepseek-chat', count: 2, flag: true, maybe: null },
      apiKeyId: 'key-7',
    },
  })
  const page = service.list(READER)
  const serialized = JSON.stringify(page.items)
  for (const secret of [
    'hunter2',
    'tok_abcdefgh',
    's3cr3t',
    'sk-inside-object',
    'sk-live-abcdef123456',
    'eyJhbGciOi',
    'abcdefghijklmnop',
  ]) {
    assert.ok(!serialized.includes(secret), `落库内容不得包含 ${secret}`)
  }
  // 非秘密字段照常保留（脱敏不能把审计抹成空白）。
  const row = page.items[0]
  assert.deepEqual(row?.metadata?.safe, { model: 'deepseek-chat', count: 2, flag: true, maybe: null })
  assert.equal(row?.metadata?.apiKeyId, 'key-7')
  assert.match(row?.summary ?? '', /导入凭据/)
})

test('脱敏纯函数：嵌套对象不被就地改动，超长摘要截断', () => {
  const input = { password: 'p', list: [{ token: 't', ok: 1 }] }
  const sanitized = sanitizeMetadata(input) as Record<string, unknown>
  assert.equal(input.password, 'p', '调用方对象不能被改')
  assert.deepEqual(sanitized.list, [{ token: '[已脱敏]', ok: 1 }])
  const long = redactText('x'.repeat(600))
  assert.ok(long.length <= 520)
  assert.match(long, /已截断/)
  assert.equal(redactText('普通文字'), '普通文字')
})

// ───────────────────────────────── 保留期 ─────────────────────────────────

test('保留期清理：只删过期记录，保留期内的一条不动', async (t) => {
  const { service } = await boot(t, { retentionDays: 30 })
  const now = Date.UTC(2026, 9, 19, 12, 0, 0)
  write(service, { action: 'user.balance.adjust', targetId: 'old-1', atMs: now - 40 * 86_400_000 })
  write(service, { action: 'user.balance.adjust', targetId: 'old-2', atMs: now - 31 * 86_400_000 })
  write(service, { action: 'user.balance.adjust', targetId: 'fresh', atMs: now - 29 * 86_400_000 })

  const removed = service.pruneExpired(now)
  assert.equal(removed, 2)
  const page = service.list(READER)
  assert.equal(page.total, 1)
  assert.equal(page.items[0]?.targetId, 'fresh')
})

test('配置：非法 retentionDays 让校验失败（装载明确失败，不静默回落）', () => {
  assert.ok(Array.isArray(validateAuditConfig({ retentionDays: 0 })))
  assert.ok(Array.isArray(validateAuditConfig({ retentionDays: 3651 })))
  assert.ok(Array.isArray(validateAuditConfig({ retentionDays: 1.5 })))
  assert.ok(Array.isArray(validateAuditConfig({ retentionDays: '180' })))
  assert.ok(Array.isArray(validateAuditConfig({ unknownKey: 1 })))
  assert.ok(!Array.isArray(validateAuditConfig({ retentionDays: 90 })))
})

test('非法配置装载失败：插件不注册服务、错误带稳定码', async () => {
  const ctx = new Context()
  let failure: unknown
  try {
    await ctx.plugin(AuditService, { retentionDays: 0 })
  } catch (error) {
    failure = error
  }
  assert.ok(failure instanceof Error, '非法配置必须让插件装载失败')
  assert.match(failure.message, /retentionDays/)
  assert.equal(ctx.get('audit', false), undefined)
})

// ───────────────────────────────── 持久化 / 生命周期 ─────────────────────────────────

test('真落盘：重开 store 后记录还在；禁用后连接与定时器回收', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dizzyapi-audit-'))
  const path = join(dir, 'audit.db')
  const first = await boot(t, { dataPath: path })
  const second = await boot(t, { dataPath: path })
  // 先关掉两个连接再删目录：Windows 上打开着的 SQLite 文件删不掉（EPERM）。
  t.after(() => {
    void second.dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })

  write(first.service, { targetId: 'persisted' })
  assert.equal(first.service.count(), 1)
  await first.dispose()

  const page = second.service.list(READER)
  assert.equal(page.total, 1)
  assert.equal(page.items[0]?.targetId, 'persisted')
})
