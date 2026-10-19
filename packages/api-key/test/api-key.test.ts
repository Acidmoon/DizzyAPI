import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context, Service, ValidationError } from 'cordis'
import ApiKeyService, {
  ApiKeyError,
  hashApiKey,
  isApiKeyError,
  type ApiKeyChangedEvent,
  type ApiKeyConfig,
  type ApiKeyErrorCode,
} from '../src/index.ts'

interface FakeUserRecord {
  readonly id: number
  readonly name: string
  readonly status: 'enabled' | 'banned'
}

/** 只声明 api-key 插件用到的 user 面：get(id)。 */
class FakeUser extends Service {
  private users = new Map<number, FakeUserRecord>()
  private gate: Promise<void> | undefined

  constructor(ctx: Context) {
    super(ctx, 'user')
  }

  /** 让下一次 get() 挂起，用于稳定复现「异步查询期间发生写入」的时序。 */
  holdNextGet(): () => void {
    let release!: () => void
    this.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    return release
  }

  async get(id: number): Promise<FakeUserRecord | undefined> {
    const gate = this.gate
    if (gate !== undefined) {
      this.gate = undefined
      await gate
    }
    const user = this.users.get(id)
    return user === undefined ? undefined : { ...user }
  }

  add(id: number, status: 'enabled' | 'banned' = 'enabled'): FakeUserRecord {
    const user: FakeUserRecord = { id, name: `user-${id}`, status }
    this.users.set(id, user)
    return { ...user }
  }

  setStatus(id: number, status: 'enabled' | 'banned'): void {
    const user = this.users.get(id)
    if (user === undefined) throw new Error(`fake user ${id} 不存在`)
    this.users.set(id, { ...user, status })
  }

  remove(id: number): void {
    this.users.delete(id)
  }
}

interface World {
  readonly ctx: Context
  readonly service: ApiKeyService
  readonly user: FakeUser
  readonly dispose: () => Promise<void>
}

async function boot(t: TestContext, config: ApiKeyConfig = {}): Promise<World> {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  const user = ctx.get('user') as unknown as FakeUser
  const fiber = await ctx.plugin(ApiKeyService, config)
  const service = ctx.get('apiKey') as ApiKeyService
  const dispose = async (): Promise<void> => {
    try {
      await fiber.dispose()
    } catch {
      // 用例可能已经卸载过。
    }
  }
  t.after(dispose)
  return { ctx, service, user, dispose }
}

async function rejectsCode(operation: Promise<unknown>, code: ApiKeyErrorCode): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(isApiKeyError(error), `期望 ApiKeyError，收到 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('创建：完整 key 只返回一次，列表只给掩码', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)

  const created = await service.create(1, { name: '  default  ' })
  assert.match(created.secret, /^sk-dz-[0-9A-HJKMNP-TV-Z]{12}_[A-Za-z0-9_-]{43}$/)
  assert.equal(created.key.name, 'default')
  assert.equal(created.key.userId, 1)
  assert.equal(created.key.enabled, true)
  assert.equal(created.key.appManaged, false)
  assert.equal(created.key.lastUsedAt, null)
  assert.equal(created.key.rotatedAt, null)
  assert.equal(
    created.key.maskedKey,
    `sk-dz-${created.key.trackingId}_…${created.secret.slice(-4)}`,
  )
  assert.equal(created.key.trackingId, created.secret.slice(6, 18))

  const views = await service.list(1)
  assert.equal(views.length, 1)
  const payload = JSON.stringify(views)
  assert.ok(!payload.includes(created.secret), '列表不得包含完整 key')
  assert.ok(!payload.includes(created.secret.slice(6)), '列表不得包含 secret 本体')
  assert.ok(!('secret' in views[0]!))
  assert.ok(!('secretHash' in views[0]!))
})

test('名称：同一用户内唯一；不同用户可重名', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  user.add(2)

  await service.create(1, { name: 'alpha' })
  await rejectsCode(service.create(1, { name: ' alpha ' }), 'API_KEY_NAME_TAKEN')
  await service.create(2, { name: 'alpha' })

  const second = await service.create(1, { name: 'beta' })
  await rejectsCode(service.update(1, second.key.id, { name: 'alpha' }), 'API_KEY_NAME_TAKEN')
  assert.equal((await service.update(1, second.key.id, { name: 'beta' })).name, 'beta')
  assert.equal((await service.update(1, second.key.id, { name: 'gamma' })).name, 'gamma')
})

test('每用户上限：计数包含已停用的 key，且并发创建不会越过上限', async (t) => {
  const { service, user } = await boot(t, { maxKeysPerUser: 2 })
  user.add(1)
  user.add(2)

  const first = await service.create(1, { name: 'a' })
  await service.create(1, { name: 'b' })
  await rejectsCode(service.create(1, { name: 'c' }), 'API_KEY_LIMIT_REACHED')

  // 停用不释放配额。
  await service.update(1, first.key.id, { enabled: false })
  await rejectsCode(service.create(1, { name: 'c' }), 'API_KEY_LIMIT_REACHED')

  // 上限按用户隔离。
  await service.create(2, { name: 'a' })

  // 事务内的「计数 → 插入」是串行的：两个并发请求只能成功一个。
  await service.create(2, { name: 'b' })
  const results = await Promise.allSettled([
    service.create(2, { name: 'c' }),
    service.create(2, { name: 'd' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 0)
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') {
      assert.equal((result.reason as ApiKeyError).code, 'API_KEY_LIMIT_REACHED')
    }
  }
})

test('用户不存在或已封禁时不能创建 / 轮换；读取按所有权隔离', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  user.add(2)
  const created = await service.create(1, { name: 'mine' })

  await rejectsCode(service.create(99, { name: 'ghost' }), 'API_KEY_USER_NOT_FOUND')
  user.add(3, 'banned')
  await rejectsCode(service.create(3, { name: 'banned' }), 'API_KEY_USER_NOT_FOUND')

  // 不属于该用户的 key 一律 NOT_FOUND，不区分「不存在」与「不是你的」。
  await rejectsCode(service.get(2, created.key.id), 'API_KEY_NOT_FOUND')
  await rejectsCode(service.update(2, created.key.id, { name: 'hijack' }), 'API_KEY_NOT_FOUND')
  await rejectsCode(service.remove(2, created.key.id), 'API_KEY_NOT_FOUND')
  await rejectsCode(service.remove(1, 'not-a-key-id'), 'API_KEY_NOT_FOUND')
  assert.deepEqual(await service.list(2), [])

  user.setStatus(1, 'banned')
  await rejectsCode(service.rotate(1, created.key.id), 'API_KEY_USER_NOT_FOUND')
})

test('verify：命中返回身份；格式错 / 不存在 / 已停用 / 用户封禁都返回 undefined', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  const created = await service.create(1, { name: 'verify' })

  assert.deepEqual(await service.verify(created.secret), {
    keyId: created.key.id,
    userId: 1,
    name: 'verify',
    profile: 'billed',
  })

  assert.equal(await service.verify(''), undefined)
  assert.equal(await service.verify('not-a-key'), undefined)
  assert.equal(await service.verify(` ${created.secret}`), undefined)
  assert.equal(await service.verify(created.secret.toUpperCase()), undefined)
  // 合法形状但 trackingId 不存在
  assert.equal(
    await service.verify(`sk-dz-000000000000_${'A'.repeat(43)}`),
    undefined,
  )
  // 同一 trackingId、错误 secret
  const body = created.secret.slice(6)
  const separator = body.indexOf('_')
  const tracking = body.slice(0, separator)
  assert.equal(await service.verify(`sk-dz-${tracking}_${'B'.repeat(43)}`), undefined)

  await service.update(1, created.key.id, { enabled: false })
  assert.equal(await service.verify(created.secret), undefined)
  await service.update(1, created.key.id, { enabled: true })
  assert.ok(await service.verify(created.secret))

  user.setStatus(1, 'banned')
  assert.equal(await service.verify(created.secret), undefined)
  user.setStatus(1, 'enabled')
  assert.ok(await service.verify(created.secret))

  await service.remove(1, created.key.id)
  assert.equal(await service.verify(created.secret), undefined)
})

test('更新：改名 / 启停；空 patch 与非法值被拒绝', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  const created = await service.create(1, { name: 'before' })

  const renamed = await service.update(1, created.key.id, { name: 'after' })
  assert.equal(renamed.name, 'after')
  assert.equal(renamed.enabled, true)

  const disabled = await service.update(1, created.key.id, { enabled: false })
  assert.equal(disabled.enabled, false)
  assert.equal((await service.list(1))[0]?.enabled, false)

  await rejectsCode(service.update(1, created.key.id, {}), 'API_KEY_INVALID_INPUT')
  await rejectsCode(service.update(1, created.key.id, { name: '   ' }), 'API_KEY_INVALID_INPUT')
  await rejectsCode(
    service.update(1, created.key.id, { name: 'x'.repeat(65) }),
    'API_KEY_INVALID_INPUT',
  )
  await rejectsCode(
    service.update(1, created.key.id, { enabled: 'yes' as unknown as boolean }),
    'API_KEY_INVALID_INPUT',
  )
  await rejectsCode(service.update(1, 'missing', { enabled: true }), 'API_KEY_NOT_FOUND')
})

test('轮换：trackingId 与 id 不变，旧 secret 立刻失效，新完整 key 只返回一次', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  user.add(2)
  const created = await service.create(1, { name: 'rotate' })

  const rotated = await service.rotate(1, created.key.id)
  assert.equal(rotated.key.id, created.key.id)
  assert.equal(rotated.key.trackingId, created.key.trackingId)
  assert.notEqual(rotated.secret, created.secret)
  assert.notEqual(rotated.key.maskedKey, created.key.maskedKey)
  assert.notEqual(rotated.key.rotatedAt, null)
  assert.equal(await service.verify(created.secret), undefined)
  assert.deepEqual(await service.verify(rotated.secret), {
    keyId: created.key.id,
    userId: 1,
    name: 'rotate',
    profile: 'billed',
  })

  await rejectsCode(service.rotate(2, created.key.id), 'API_KEY_NOT_FOUND')
})

test('删除：幂等语义是「第二次 NOT_FOUND」；删除后 verify 不再命中', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  const created = await service.create(1, { name: 'remove' })

  assert.deepEqual(await service.remove(1, created.key.id), { removed: true })
  assert.deepEqual(await service.list(1), [])
  assert.equal(await service.verify(created.secret), undefined)
  await rejectsCode(service.remove(1, created.key.id), 'API_KEY_NOT_FOUND')
})

test('快照：只含 enabled 且用户可用的 key；只有哈希，没有明文/掩码', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  user.add(2)
  user.add(3)

  const kept = await service.create(1, { name: 'kept' })
  const disabled = await service.create(1, { name: 'disabled' })
  const banned = await service.create(2, { name: 'banned-user' })
  const orphan = await service.create(3, { name: 'orphan' })
  await service.update(1, disabled.key.id, { enabled: false })
  user.setStatus(2, 'banned')
  user.remove(3)

  const before = service.status()
  const snapshot = await service.snapshot()
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.generation, before.generation)
  assert.deepEqual(snapshot.keys.map((key) => key.keyId), [kept.key.id])
  assert.deepEqual(snapshot.keys[0], {
    keyId: kept.key.id,
    userId: 1,
    keyHash: hashApiKey(kept.secret),
    profile: 'billed',
    name: 'kept',
  })

  const payload = JSON.stringify(snapshot)
  for (const secret of [kept.secret, disabled.secret, banned.secret, orphan.secret]) {
    assert.ok(!payload.includes(secret), '快照不得包含完整 key')
    assert.ok(!payload.includes(secret.slice(-43)), '快照不得包含 secret 本体')
  }
  assert.ok(!payload.includes('maskedKey'))
  assert.ok(!payload.includes('trackingId'))

  const after = service.status()
  assert.equal(after.keys, 4)
  assert.equal(after.users, 3)
  assert.ok(after.generation >= before.generation)
  assert.notEqual(after.updatedAt, null)
})

test('snapshot 的 generation 与 keys 来自同一同步时刻', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  const first = await service.create(1, { name: 'first' })
  const generationBefore = service.status().generation

  // snapshot 先同步读 rows + generation，然后才 await user.get。
  const release = user.holdNextGet()
  const pending = service.snapshot()
  // 在 user.get 挂起期间写入第二个 key：它只能出现在下一份快照里。
  await service.create(1, { name: 'second' })
  assert.ok(service.status().generation > generationBefore)
  release()

  const snapshot = await pending
  assert.equal(snapshot.generation, generationBefore)
  assert.deepEqual(snapshot.keys.map((key) => key.keyId), [first.key.id])
})

test('每次写操作递增 generation；事件载荷只有 userId/keyId/action', async (t) => {
  const { ctx, service, user } = await boot(t)
  user.add(1)
  const events: ApiKeyChangedEvent[] = []
  ctx.on('api-key/changed', (event) => events.push(event))

  const start = service.status().generation
  const created = await service.create(1, { name: 'event' })
  assert.ok(service.status().generation > start)
  await service.update(1, created.key.id, { name: 'event-2' })
  await service.rotate(1, created.key.id)
  await service.remove(1, created.key.id)

  assert.deepEqual(
    events.map((event) => event.action),
    ['created', 'updated', 'rotated', 'removed'],
  )
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['action', 'keyId', 'userId'])
    assert.ok(!JSON.stringify(event).includes(created.secret))
  }
})

test('持久化：重新打开同一个 SQLite 文件后 key 与哈希仍然可用', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-api-keys-'))
  const dataPath = join(dir, 'api-keys.db')
  try {
    const first = new Context()
    await first.plugin(FakeUser)
    ;(first.get('user') as unknown as FakeUser).add(1)
    const fiber = await first.plugin(ApiKeyService, { dataPath })
    const service = first.get('apiKey') as ApiKeyService
    const created = await service.create(1, { name: 'persisted' })
    const generation = service.status().generation
    await fiber.dispose()

    const second = new Context()
    await second.plugin(FakeUser)
    ;(second.get('user') as unknown as FakeUser).add(1)
    const secondFiber = await second.plugin(ApiKeyService, { dataPath })
    const reopened = second.get('apiKey') as ApiKeyService
    try {
      const views = await reopened.list(1)
      assert.equal(views.length, 1)
      assert.equal(views[0]?.maskedKey, created.key.maskedKey)
      assert.ok(await reopened.verify(created.secret))
      assert.ok(reopened.status().generation >= generation)
    } finally {
      await secondFiber.dispose()
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('损坏检测：不是 SQLite 的文件直接以 API_KEY_STORE_CORRUPT 拒绝装载', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-api-keys-corrupt-'))
  const dataPath = join(dir, 'broken.db')
  try {
    await writeFile(dataPath, 'this is definitely not a sqlite database', 'utf8')
    const ctx = new Context()
    await ctx.plugin(FakeUser)
    await assert.rejects(
      async () => {
        await ctx.plugin(ApiKeyService, { dataPath })
      },
      (error: unknown) => {
        assert.ok(isApiKeyError(error), `期望 ApiKeyError，收到 ${String(error)}`)
        assert.equal(error.code, 'API_KEY_STORE_CORRUPT')
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('配置：未知字段与越界上限由 cordis 拒绝；appManaged 会原样记录', async (t) => {
  const { service, user } = await boot(t)
  user.add(1)
  const created = await service.create(1, { name: 'app', appManaged: true })
  assert.equal(created.key.appManaged, true)

  const rejectsConfig = async (config: ApiKeyConfig): Promise<void> => {
    // inject 未满足时 fiber 停在 PENDING，配置校验不会跑；先给一个 user。
    const bad = new Context()
    await bad.plugin(FakeUser)
    await assert.rejects(async () => {
      await bad.plugin(ApiKeyService, config)
    }, ValidationError)
    assert.equal(bad.get('apiKey'), undefined)
  }
  await rejectsConfig({ nope: true } as unknown as ApiKeyConfig)
  await rejectsConfig({ maxKeysPerUser: 0 })
  await rejectsConfig({ maxKeysPerUser: 10_001 })
})

test('卸载后服务与数据库连接一起回收（D5）', async () => {
  const ctx = new Context()
  await ctx.plugin(FakeUser)
  ;(ctx.get('user') as unknown as FakeUser).add(1)
  const fiber = await ctx.plugin(ApiKeyService)
  await ctx.apiKey.create(1, { name: 'gone' })
  assert.equal((await ctx.apiKey.list(1)).length, 1)
  await fiber.dispose()
  assert.equal(ctx.get('apiKey'), undefined)

  // 双重 close 不应抛错。
  await fiber.dispose()
})

test('能力清单声明了 api-keys / credential-issue / key-rotation 与桥命令', () => {
  assert.deepEqual(ApiKeyService.catalog.capabilities, [
    'api-keys',
    'credential-issue',
    'key-rotation',
  ])
  assert.deepEqual(
    ApiKeyService.catalog.bridge.map((item) => item.method),
    ['keys.replace', 'keys.status'],
  )
  assert.equal(ApiKeyService.catalog.events[0]?.name, 'api-key/changed')
})
