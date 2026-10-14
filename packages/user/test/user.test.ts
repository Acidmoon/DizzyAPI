import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, ValidationError } from 'cordis'
import UserService, {
  UserError,
  isUserError,
  type UserConfig,
  type UserErrorCode,
  type UserStatus,
} from '../src/index.ts'

const ADMIN = '@dizzyapi/plugin-admin'

const ADMIN_ONLY: UserConfig = { adminPlugins: [ADMIN] }

async function withUser(
  config: UserConfig,
  body: (user: UserService, ctx: Context) => Promise<void>,
): Promise<void> {
  const ctx = new Context()
  const fiber = await ctx.plugin(UserService, config)
  try {
    await body(ctx.user, ctx)
  } finally {
    await fiber.dispose()
  }
}

async function rejectsCode(operation: Promise<unknown>, code: UserErrorCode): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof UserError, `期望 UserError，收到 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

test('创建用户：ID 按注册顺序分配，默认启用、余额为零', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const bob = await user.create(ADMIN, { name: 'bob' })

    assert.equal(alice.id, 1)
    assert.equal(bob.id, 2)
    assert.equal(alice.status, 'enabled')
    assert.equal(alice.balance, 0n)
    assert.deepEqual((await user.list()).map((item) => item.name), ['alice', 'bob'])
  })
})

test('管理面只认 adminPlugins 里的插件，缺省为空即谁都不许', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    await rejectsCode(user.create('@dizzyapi/plugin-other', { name: 'mallory' }), 'USER_ACTOR_FORBIDDEN')
  })

  await withUser({}, async (user) => {
    await rejectsCode(user.create(ADMIN, { name: 'alice' }), 'USER_ACTOR_FORBIDDEN')
    assert.deepEqual(await user.list(), [])
  })
})

test('调用方必须声明插件名', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    await rejectsCode(user.create('   ', { name: 'alice' }), 'USER_ACTOR_REQUIRED')
  })
})

test('用户名：去空白、重名拒绝、非法值拒绝', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: '  alice  ' })
    assert.equal(alice.name, 'alice')
    const bob = await user.create(ADMIN, { name: 'bob' })

    await rejectsCode(user.create(ADMIN, { name: 'alice' }), 'USER_NAME_TAKEN')
    await rejectsCode(user.rename(ADMIN, bob.id, 'alice'), 'USER_NAME_TAKEN')
    await rejectsCode(user.create(ADMIN, { name: '   ' }), 'USER_NAME_INVALID')
    await rejectsCode(user.create(ADMIN, { name: 'a'.repeat(65) }), 'USER_NAME_INVALID')
    await rejectsCode(user.create(ADMIN, { name: 'a\u0000b' }), 'USER_NAME_INVALID')
    await rejectsCode(user.create(ADMIN, { name: 42 as unknown as string }), 'USER_NAME_INVALID')

    // 失败不改变状态：上面每次失败都只应该留下 alice 与 bob
    assert.deepEqual((await user.list()).map((item) => item.name), ['alice', 'bob'])

    const renamed = await user.rename(ADMIN, bob.id, 'robert')
    assert.equal(renamed.name, 'robert')
    assert.equal(renamed.id, bob.id)
    // 改成自己原来的名字不算重名
    assert.equal((await user.rename(ADMIN, bob.id, 'robert')).name, 'robert')
  })
})

test('封禁与启用', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    assert.equal((await user.setStatus(ADMIN, alice.id, 'banned')).status, 'banned')
    assert.equal((await user.get(alice.id))?.status, 'banned')
    assert.equal((await user.setStatus(ADMIN, alice.id, 'enabled')).status, 'enabled')
    await rejectsCode(user.setStatus(ADMIN, alice.id, 'deleted' as UserStatus), 'USER_STATUS_INVALID')
    await rejectsCode(user.setStatus(ADMIN, 999, 'banned'), 'USER_NOT_FOUND')
  })
})

test('删除用户：余额不为零先拒绝；结清后可删；ID 不复用；流水保留', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    await user.create(ADMIN, { name: 'alice' })
    await user.create(ADMIN, { name: 'bob' })
    await user.adjustBalance(ADMIN, 2, 5_000_000n, '充值')

    await rejectsCode(user.remove(ADMIN, 2), 'USER_BALANCE_NOT_ZERO')
    assert.equal((await user.get(2))?.name, 'bob')

    await user.adjustBalance(ADMIN, 2, -5_000_000n, '结清后退款')
    const removed = await user.remove(ADMIN, 2)
    assert.equal(removed.id, 2)
    assert.equal(await user.get(2), undefined)

    // 注册顺序不允许回收：删掉 2 号之后，下一个新用户仍然是 3 号
    assert.equal((await user.create(ADMIN, { name: 'carol' })).id, 3)
    // 用户没了，但钱走过的痕迹还在
    assert.equal((await user.listBalanceEntries(2)).length, 2)
  })
})

test('余额：读取、按增量修改、返回新余额、流水可查', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    assert.equal(await user.getBalance(alice.id), 0n)

    const credited = await user.adjustBalance('@dizzyapi/plugin-payment', alice.id, 10_000_000n, '充值 10 元')
    assert.equal(credited, 10_000_000n)
    assert.equal(await user.getBalance(alice.id), 10_000_000n)

    const settled = await user.adjustBalance('@dizzyapi/plugin-billing', alice.id, -2_500_000n, '结算一次推理')
    assert.equal(settled, 7_500_000n)

    const entries = await user.listBalanceEntries(alice.id)
    assert.deepEqual(
      entries.map((entry) => [entry.delta, entry.balanceAfter, entry.reason, entry.actor]),
      [
        [10_000_000n, 10_000_000n, '充值 10 元', '@dizzyapi/plugin-payment'],
        [-2_500_000n, 7_500_000n, '结算一次推理', '@dizzyapi/plugin-billing'],
      ],
    )
    assert.equal((await user.get(alice.id))?.balance, 7_500_000n)
  })
})

test('余额可以扣成负数：后付费结算本来就可能超出余额（D11）', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    assert.equal(await user.adjustBalance(ADMIN, alice.id, -1n, '先扣后付'), -1n)
  })
})

test('余额变更必须用 bigint 整数、必须给出原因', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    await rejectsCode(user.adjustBalance(ADMIN, alice.id, 1 as unknown as bigint, '充值'), 'USER_BALANCE_INVALID')
    await rejectsCode(user.adjustBalance(ADMIN, alice.id, 1.5 as unknown as bigint, '充值'), 'USER_BALANCE_INVALID')
    await rejectsCode(user.adjustBalance(ADMIN, alice.id, 1n, '   '), 'USER_REASON_REQUIRED')
    await rejectsCode(user.adjustBalance(ADMIN, 999, 1n, '充值'), 'USER_NOT_FOUND')
    await rejectsCode(user.getBalance(0), 'USER_ID_INVALID')
    assert.equal(await user.getBalance(alice.id), 0n)
  })
})

test('balanceWriters 可以收窄余额写者，但读始终不限', async () => {
  await withUser({ adminPlugins: [ADMIN], balanceWriters: ['@dizzyapi/plugin-billing'] }, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })

    await rejectsCode(user.adjustBalance('@dizzyapi/plugin-other', alice.id, 1n, '充值'), 'USER_ACTOR_FORBIDDEN')
    assert.equal(await user.getBalance(alice.id), 0n)

    assert.equal(await user.adjustBalance('@dizzyapi/plugin-billing', alice.id, 1n, '充值'), 1n)
    assert.equal(await user.getBalance(alice.id), 1n)
  })
})

test('外部拿到的是副本，改不动插件内部状态', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const sneaky = (await user.get(alice.id)) as { name: string }
    sneaky.name = 'hacked'
    assert.equal((await user.get(alice.id))?.name, 'alice')
  })
})

test('list：按状态过滤，offset / limit 分页', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    await user.create(ADMIN, { name: 'alice' })
    await user.create(ADMIN, { name: 'bob' })
    await user.create(ADMIN, { name: 'carol' })
    await user.setStatus(ADMIN, 2, 'banned')

    assert.deepEqual((await user.list({ status: 'banned' })).map((item) => item.name), ['bob'])
    assert.deepEqual((await user.list({ offset: 1, limit: 2 })).map((item) => item.name), ['bob', 'carol'])
    assert.deepEqual((await user.list({ limit: 0 })), [])
  })
})

test('配置 schema 由 cordis 强制执行：未知字段直接拒绝', async () => {
  const ctx = new Context()
  await assert.rejects(
    async () => {
      await ctx.plugin(UserService, { nope: true } as unknown as UserConfig)
    },
    ValidationError,
  )
  assert.equal(ctx.get('user'), undefined)
})

test('插件卸载后服务一起回收（D5：注册即副作用）', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(UserService, ADMIN_ONLY)
  await ctx.user.create(ADMIN, { name: 'alice' })
  assert.equal((await ctx.user.list()).length, 1)

  await fiber.dispose()
  assert.equal(ctx.get('user'), undefined)
  assert.equal(isUserError(new UserError('USER_NOT_FOUND', 'x')), true)
})
