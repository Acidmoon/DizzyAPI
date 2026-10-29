/**
 * 内容审核插件的测试。
 *
 * 用假的 `accountPriority`（桥的持有者）与假的 `audit` 验证：
 * - 规则 CRUD 与白名单、非法输入 / 重复 pattern 明确失败；
 * - 心跳推送（内容不变也推、generation 递增）与禁用时的空规则快照；
 * - status 合并 Go 侧健康度与命中统计（读不到就是 null，不编造 0）；
 * - 审计是旁路：审计抛错不影响业务写操作；审计缺席也不影响；
 * - 真重开 store 能读回规则（写侧 / 读侧校验同口径）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import TimerService from '@cordisjs/plugin-timer'
import ContentAuditService, {
  heartbeatTooSlow,
  isContentAuditError,
  type ContentAuditConfig,
  type ContentAuditRule,
  type ContentAuditSnapshotPayload,
  type ResolvedContentAuditConfig,
} from '../src/index.ts'

const ACTOR = '@dizzyapi/plugin-api'

class FakeGateway extends Service {
  pushed: ContentAuditSnapshotPayload[] = []
  failures = 0
  status: Record<string, unknown> | null = null
  statusError = false

  constructor(ctx: Context) {
    super(ctx, 'accountPriority')
  }

  async replaceContentAudit(snapshot: ContentAuditSnapshotPayload) {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('桥断线')
    }
    this.pushed.push(snapshot)
    return {
      ready: true,
      revision: snapshot.revision,
      generation: snapshot.generation,
      rules: snapshot.rules.length,
      enabled: snapshot.enabled,
      updatedAt: new Date().toISOString(),
    }
  }

  async contentAuditStatus() {
    if (this.statusError) throw new Error('桥断线')
    return this.status ?? { ready: false, size: 0, enabled: false, ageMs: 0, ttlMs: 0 }
  }
}

class FakeAudit extends Service {
  records: Record<string, unknown>[] = []
  throwOnRecord = false

  constructor(ctx: Context) {
    super(ctx, 'audit')
  }

  record(entry: Record<string, unknown>) {
    if (this.throwOnRecord) throw new Error('审计库坏了')
    this.records.push(entry)
    return entry
  }
}

interface World {
  readonly ctx: Context
  readonly audit: ContentAuditService
  readonly gateway: FakeGateway
  readonly fakeAudit: FakeAudit
  readonly fiber: { dispose(): Promise<void> | void }
}

async function boot(
  t: TestContext,
  config: ContentAuditConfig = {},
  options: { readonly withoutAudit?: boolean; readonly dataPath?: string } = {},
): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeGateway)
  if (options.withoutAudit !== true) await ctx.plugin(FakeAudit)
  const gateway = ctx.get('accountPriority') as unknown as FakeGateway
  const fakeAudit = ctx.get('audit', false) as unknown as FakeAudit
  const fiber = await ctx.plugin(ContentAuditService, {
    enabled: true,
    // 默认把心跳间隔设得很长：用例靠 pushNow 精确控制推送次数。
    pushIntervalMs: 60_000,
    adminPlugins: [ACTOR],
    dataPath: options.dataPath ?? '',
    ...config,
  } as ResolvedContentAuditConfig)
  const audit = ctx.get('contentAudit') as ContentAuditService
  await sleep(20)
  t.after(async () => {
    try {
      await fiber.dispose()
    } catch {
      // 卸载里的清理错误不该让用例失败。
    }
  })
  return { ctx, audit, gateway, fakeAudit, fiber }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function temporaryDirectory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'dizzy-content-audit-'))
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function ruleIds(rules: readonly ContentAuditRule[]): string[] {
  return rules.map((rule) => rule.pattern)
}

test('CRUD：新增 / 列表 / 修改 / 删除，并且每次写都推一次快照', async (t) => {
  const world = await boot(t)
  const base = world.gateway.pushed.length

  const created = await world.audit.create(ACTOR, { pattern: 'BadWord', action: 'block', category: 'abuse' })
  assert.equal(created.pattern, 'BadWord')
  assert.equal(created.action, 'block')
  assert.equal(created.enabled, true)
  assert.ok(created.id.startsWith('car_'))
  assert.equal(world.gateway.pushed.length, base + 1, '写规则后应立刻推一次')

  const snapshot = world.gateway.pushed.at(-1) as ContentAuditSnapshotPayload
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.enabled, true)
  assert.deepEqual(snapshot.rules, [{ id: created.id, pattern: 'BadWord', action: 'block', category: 'abuse' }])

  const listed = world.audit.list(ACTOR)
  assert.deepEqual(ruleIds(listed), ['BadWord'])

  const updated = await world.audit.update(ACTOR, created.id, { pattern: 'badword-2', action: 'log' })
  assert.equal(updated.pattern, 'badword-2')
  assert.equal(updated.action, 'log')
  assert.deepEqual(ruleIds(world.audit.list(ACTOR)), ['badword-2'])

  assert.equal(await world.audit.remove(ACTOR, created.id), true)
  assert.deepEqual(world.audit.list(ACTOR), [])
  assert.equal(await world.audit.remove(ACTOR, created.id), false, '删不存在的规则返回 false')
})

test('白名单：不在名单里的 actor 读写都被拒绝', async (t) => {
  const world = await boot(t)
  assert.throws(() => world.audit.list('@dizzyapi/plugin-web'), (error: unknown) => {
    return isContentAuditError(error) && error.code === 'CONTENT_AUDIT_FORBIDDEN'
  })
  await assert.rejects(world.audit.create('@dizzyapi/plugin-web', { pattern: 'x' }), (error: unknown) => {
    return isContentAuditError(error) && error.code === 'CONTENT_AUDIT_FORBIDDEN'
  })
})

test('非法输入与重复 pattern 明确失败', async (t) => {
  const world = await boot(t)
  await world.audit.create(ACTOR, { pattern: 'duplicate' })

  await assert.rejects(world.audit.create(ACTOR, { pattern: 'DUPLICATE' }), (error: unknown) => {
    return isContentAuditError(error) && error.code === 'CONTENT_AUDIT_RULE_DUPLICATE'
  })
  for (const pattern of ['', '   ', 'x'.repeat(201)]) {
    await assert.rejects(world.audit.create(ACTOR, { pattern }), (error: unknown) => {
      return isContentAuditError(error) && error.code === 'CONTENT_AUDIT_INPUT_INVALID'
    })
  }
  await assert.rejects(
    world.audit.create(ACTOR, { pattern: 'ok', action: 'drop' as unknown as 'block' }),
    (error: unknown) => isContentAuditError(error) && error.code === 'CONTENT_AUDIT_INPUT_INVALID',
  )
})

test('心跳：内容没变也推，revision 相同、generation 递增', async (t) => {
  const world = await boot(t)
  await world.audit.create(ACTOR, { pattern: 'badword' })
  const base = world.gateway.pushed.length

  await world.audit.pushNow()
  await world.audit.pushNow()
  assert.equal(world.gateway.pushed.length, base + 2, '内容没变也必须再推（Go 按 TTL 判新鲜度）')

  const [first, second] = world.gateway.pushed.slice(-2) as [
    ContentAuditSnapshotPayload,
    ContentAuditSnapshotPayload,
  ]
  assert.equal(second.revision, first.revision)
  assert.ok(second.generation > first.generation)

  const status = await world.audit.status()
  assert.ok(status.heartbeats >= 2, `心跳次数应 >= 2，实际 ${String(status.heartbeats)}`)
})

test('禁用规则不推；审核整体关闭时推 enabled=false + 空规则', async (t) => {
  const world = await boot(t)
  const rule = await world.audit.create(ACTOR, { pattern: 'badword' })
  await world.audit.update(ACTOR, rule.id, { enabled: false })

  const disabled = world.gateway.pushed.at(-1) as ContentAuditSnapshotPayload
  assert.deepEqual(disabled.rules, [], '停用的规则不该推给 Go')

  await world.audit.update(ACTOR, rule.id, { enabled: true })
  assert.equal((world.gateway.pushed.at(-1) as ContentAuditSnapshotPayload).rules.length, 1)

  // 整体关闭：新起一个 enabled=false 的实例，启动推送必须是「关闭 + 空规则」。
  const off = await boot(t, { enabled: false })
  const first = off.gateway.pushed[0] as ContentAuditSnapshotPayload
  assert.equal(first.enabled, false)
  assert.deepEqual(first.rules, [])
})

test('status 合并 Go 侧健康度与命中统计；读不到时是 null，不编造 0', async (t) => {
  const world = await boot(t)
  await world.audit.create(ACTOR, { pattern: 'badword' })
  world.gateway.status = {
    ready: true,
    size: 1,
    enabled: true,
    ageMs: 120,
    ttlMs: 15_000,
    stale: false,
    gate: { blocked: 3, logged: 1, ruleHitTotal: 4, ruleHits: { car_x: 4 }, staleStreak: 0 },
  }
  const status = await world.audit.status()
  assert.equal(status.ageMs, 120)
  assert.equal(status.ttlMs, 15_000)
  assert.equal(status.goReady, true)
  assert.equal(status.stale, false)
  assert.equal(status.hits?.blocked, 3)
  assert.equal(status.hits?.byRule.car_x, 4)
  // 用例默认把推送间隔设成 60s，而 Go 的 TTL 是 15s：这确实是「跟不上」，护栏要报出来。
  assert.equal(status.heartbeatTooSlow, true)
  assert.equal(status.goTtlMs, 15_000)

  // TTL 足够大时护栏安静。
  world.gateway.status = { ...world.gateway.status, ttlMs: 200_000 }
  assert.equal((await world.audit.status()).heartbeatTooSlow, false)

  world.gateway.statusError = true
  const offline = await world.audit.status()
  assert.equal(offline.ageMs, null, '读不到 Go 状态时不许编造 0')
  assert.equal(offline.hits, null)
  assert.equal(offline.goReady, null)
})

test('审计不在这层写：服务对 audit 零依赖，留痕由入口层（api / web）在调用点记', async (t) => {
  const world = await boot(t)
  const rule = await world.audit.create(ACTOR, { pattern: 'audited' })
  await world.audit.update(ACTOR, rule.id, { enabled: false })
  await world.audit.remove(ACTOR, rule.id)
  assert.deepEqual(
    world.fakeAudit.records,
    [],
    '服务层不该写审计：actor 身份只有入口层知道，这里写会丢掉真实操作者',
  )

  // 审计插件抛错 / 缺席都不影响本插件的写操作（零依赖的直接证据）。
  world.fakeAudit.throwOnRecord = true
  const stillWorks = await world.audit.create(ACTOR, { pattern: 'audit-broken' })
  assert.equal(stillWorks.pattern, 'audit-broken', '审计坏了也必须写成功')

  const withoutAudit = await boot(t, {}, { withoutAudit: true })
  const created = await withoutAudit.audit.create(ACTOR, { pattern: 'no-audit' })
  assert.equal(created.pattern, 'no-audit')
})

test('真重开 store：写下的规则能被新实例读回来（写侧 / 读侧校验同口径）', async (t) => {
  const dir = temporaryDirectory(t)
  const dataPath = join(dir, 'content-audit.json')
  const first = await boot(t, {}, { dataPath })
  await first.audit.create(ACTOR, { pattern: 'persisted', category: 'abuse', note: '备注' })
  await first.fiber.dispose()

  const second = await boot(t, {}, { dataPath })
  const rules = second.audit.list(ACTOR)
  assert.equal(rules.length, 1)
  assert.equal(rules[0]?.pattern, 'persisted')
  assert.equal(rules[0]?.category, 'abuse')
  assert.equal(rules[0]?.note, '备注')
})

test('配置文件损坏时明确失败（不静默丢规则）', async (t) => {
  const dir = temporaryDirectory(t)
  const dataPath = join(dir, 'broken.json')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(dataPath, JSON.stringify({ version: 1, rules: [{ id: 'r1', pattern: '', action: 'block' }] }))

  const ctx = new Context()
  await ctx.plugin(TimerService)
  await ctx.plugin(FakeGateway)
  await assert.rejects(async () => {
    await ctx.plugin(ContentAuditService, {
      enabled: true,
      pushIntervalMs: 60_000,
      adminPlugins: [ACTOR],
      dataPath,
    } as ResolvedContentAuditConfig)
  })
})

test('TTL 护栏：TTL < 2 × 推送间隔即判「跟不上」', () => {
  assert.equal(heartbeatTooSlow(15_000, 5_000), false)
  assert.equal(heartbeatTooSlow(9_000, 5_000), true)
  assert.equal(heartbeatTooSlow(0, 5_000), false)
  assert.equal(heartbeatTooSlow(null, 5_000), false)
})
