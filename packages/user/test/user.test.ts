import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, ValidationError } from 'cordis'
import UserService, {
  UserError,
  isUserError,
  type UserChangedEvent,
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
    assert.equal(alice.role, 'admin', '首个用户自动是 admin')
    assert.equal(bob.role, 'user')
    assert.equal(alice.balance, 0n)
    assert.equal(alice.balanceEnabled, false, '余额显示默认关闭')
    assert.equal(alice.avatar, null)
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
    // 需要一个备用可用 admin，否则封禁唯一管理员会被 USER_LAST_ADMIN 拦下
    await user.create(ADMIN, { name: 'backup', role: 'admin' })
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

test('角色：首个用户 admin，第二个 user；可显式指定（迁移 / 测试用）', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    assert.equal((await user.create(ADMIN, { name: 'alice' })).role, 'admin')
    assert.equal((await user.create(ADMIN, { name: 'bob' })).role, 'user')
    assert.equal((await user.create(ADMIN, { name: 'carol', role: 'admin' })).role, 'admin')
    assert.equal((await user.create(ADMIN, { name: 'dave', role: 'user' })).role, 'user')
    await rejectsCode(user.create(ADMIN, { name: 'eve', role: 'root' as never }), 'USER_ROLE_INVALID')
  })
})

test('setRole：仅管理插件；拒绝撤销最后一个 admin；可以重新授予', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const bob = await user.create(ADMIN, { name: 'bob' })

    await rejectsCode(user.setRole('@dizzyapi/plugin-other', bob.id, 'admin'), 'USER_ACTOR_FORBIDDEN')
    assert.equal((await user.setRole(ADMIN, bob.id, 'admin')).role, 'admin')

    // 现在有两个 admin，可以把 alice 降级
    assert.equal((await user.setRole(ADMIN, alice.id, 'user')).role, 'user')
    // bob 是最后一个 admin，不能降级
    await rejectsCode(user.setRole(ADMIN, bob.id, 'user'), 'USER_LAST_ADMIN')
    assert.equal((await user.get(bob.id))?.role, 'admin')
    await rejectsCode(user.setRole(ADMIN, bob.id, 'root' as never), 'USER_ROLE_INVALID')
  })
})

test('setStatus：不能封禁最后一个可用管理员；有第二个可用 admin 后可以', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' }) // admin, enabled
    const bob = await user.create(ADMIN, { name: 'bob' })

    await rejectsCode(user.setStatus(ADMIN, alice.id, 'banned'), 'USER_LAST_ADMIN')
    assert.equal((await user.get(alice.id))?.status, 'enabled', '失败不改变数据库状态')
    assert.equal((await user.get(alice.id))?.role, 'admin')

    // 先授予第二个可用 admin，再封禁原 admin 是允许的
    await user.setRole(ADMIN, bob.id, 'admin')
    assert.equal((await user.setStatus(ADMIN, alice.id, 'banned')).status, 'banned')

    // 现在 bob 是唯一可用 admin，不能封禁
    await rejectsCode(user.setStatus(ADMIN, bob.id, 'banned'), 'USER_LAST_ADMIN')
    assert.equal((await user.get(bob.id))?.status, 'enabled')
  })
})

test('remove：不能删除最后一个可用管理员；有第二个可用 admin 后可以', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const bob = await user.create(ADMIN, { name: 'bob' })

    // 先余额、后管理员：余额非零时给余额错误
    await user.adjustBalance(ADMIN, alice.id, 1n, '临时充值')
    await rejectsCode(user.remove(ADMIN, alice.id), 'USER_BALANCE_NOT_ZERO')
    await user.adjustBalance(ADMIN, alice.id, -1n, '退回')
    await rejectsCode(user.remove(ADMIN, alice.id), 'USER_LAST_ADMIN')
    assert.ok(await user.get(alice.id), '失败不改变数据库状态')

    // 先授予第二个可用 admin，再删除原 admin 是允许的
    await user.setRole(ADMIN, bob.id, 'admin')
    assert.equal((await user.remove(ADMIN, alice.id)).id, alice.id)
  })
})

test('被 banned 的 admin 不计入可用管理员：可降级 / 删除，唯一可用 admin 仍受保护', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const bob = await user.create(ADMIN, { name: 'bob', role: 'admin' })
    assert.equal((await user.setStatus(ADMIN, bob.id, 'banned')).status, 'banned')

    // 此时 bob 是 banned admin，不构成管理入口；alice 是唯一可用 admin
    await rejectsCode(user.setStatus(ADMIN, alice.id, 'banned'), 'USER_LAST_ADMIN')
    await rejectsCode(user.setRole(ADMIN, alice.id, 'user'), 'USER_LAST_ADMIN')
    await rejectsCode(user.remove(ADMIN, alice.id), 'USER_LAST_ADMIN')

    // 但 bob 可以被降级或删除：它本来就不是可用管理员
    assert.equal((await user.setRole(ADMIN, bob.id, 'user')).role, 'user')
    const carol = await user.create(ADMIN, { name: 'carol', role: 'admin' })
    await user.setStatus(ADMIN, carol.id, 'banned')
    assert.equal((await user.remove(ADMIN, carol.id)).id, carol.id)
    assert.equal((await user.get(alice.id))?.role, 'admin')
  })
})

test('setBalanceEnabled：仅管理插件；可打开 / 关闭余额显示，不动余额数值', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    assert.equal(alice.balanceEnabled, false)

    await rejectsCode(
      user.setBalanceEnabled('@dizzyapi/plugin-other', alice.id, true),
      'USER_ACTOR_FORBIDDEN',
    )
    assert.equal((await user.setBalanceEnabled(ADMIN, alice.id, true)).balanceEnabled, true)
    assert.equal(await user.getBalance(alice.id), 0n)
    assert.equal((await user.setBalanceEnabled(ADMIN, alice.id, false)).balanceEnabled, false)
    await rejectsCode(
      user.setBalanceEnabled(ADMIN, alice.id, 'yes' as unknown as boolean),
      'USER_BALANCE_ENABLED_INVALID',
    )
  })
})

test('updateProfile：自助改用户名与头像；不做 actor 白名单；只改这两个字段', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const bob = await user.create(ADMIN, { name: 'bob' })

    const renamed = await user.updateProfile(alice.id, { name: 'alice-renamed' })
    assert.equal(renamed.name, 'alice-renamed')
    assert.equal(renamed.role, 'admin', '资料更新不该碰角色')

    // 重名仍然拒绝
    await rejectsCode(user.updateProfile(alice.id, { name: 'bob' }), 'USER_NAME_TAKEN')
    // 空补丁原样返回
    const untouched = await user.updateProfile(alice.id, {})
    assert.equal(untouched.name, 'alice-renamed')

    // 只允许 name / avatar
    await rejectsCode(
      user.updateProfile(alice.id, { role: 'user' } as never),
      'USER_PROFILE_INVALID',
    )
    await rejectsCode(user.updateProfile(alice.id, { balance: 1n } as never), 'USER_PROFILE_INVALID')
    assert.equal((await user.get(alice.id))?.role, 'admin')
    assert.equal((await user.get(bob.id))?.name, 'bob')
  })
})

test('头像：http(s) URL、四种允许的 data URL、null 清除；其余拒绝', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const png = 'data:image/png;base64,iVBORw0KGgo='

    assert.equal((await user.updateProfile(alice.id, { avatar: 'https://example.com/a.png' })).avatar, 'https://example.com/a.png')
    assert.equal((await user.updateProfile(alice.id, { avatar: png })).avatar, png)
    assert.equal((await user.updateProfile(alice.id, { avatar: 'data:image/jpeg;base64,/9j/4AAQ' })).avatar, 'data:image/jpeg;base64,/9j/4AAQ')
    assert.equal((await user.updateProfile(alice.id, { avatar: 'data:image/webp;base64,UklGRg==' })).avatar, 'data:image/webp;base64,UklGRg==')
    assert.equal((await user.updateProfile(alice.id, { avatar: 'data:image/gif;base64,R0lGODlh' })).avatar, 'data:image/gif;base64,R0lGODlh')
    assert.equal((await user.updateProfile(alice.id, { avatar: null })).avatar, null)

    const rejected = [
      'ftp://example.com/a.png',
      'javascript:alert(1)',
      'https://' + 'a'.repeat(2048),
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PGgxPg==',
      'data:image/png;base64,',
      'not-a-url',
      '   ',
    ]
    for (const avatar of rejected) {
      await rejectsCode(user.updateProfile(alice.id, { avatar }), 'USER_AVATAR_INVALID')
    }

    // 解码后超过 256 KiB
    const oversized = `data:image/png;base64,${Buffer.alloc(256 * 1024 + 1).toString('base64')}`
    await rejectsCode(user.updateProfile(alice.id, { avatar: oversized }), 'USER_AVATAR_INVALID')

    // 刚好 256 KiB 可以接受
    const exact = `data:image/png;base64,${Buffer.alloc(256 * 1024).toString('base64')}`
    assert.equal((await user.updateProfile(alice.id, { avatar: exact })).avatar, exact)
  })
})

test('余额精度：超过 Number.MAX_SAFE_INTEGER 也不丢', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })
    const huge = 9_007_199_254_740_993n // 2^53 + 1
    assert.equal(await user.adjustBalance(ADMIN, alice.id, huge, '精度测试'), huge)
    assert.equal(await user.getBalance(alice.id), huge)
    assert.equal((await user.listBalanceEntries(alice.id))[0]?.balanceAfter, huge)
  })
})

test('并发写不交错：20 笔余额变更按顺序逐笔落账', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    const alice = await user.create(ADMIN, { name: 'alice' })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        user.adjustBalance(ADMIN, alice.id, 1n, `并发 ${index}`),
      ),
    )

    assert.equal(await user.getBalance(alice.id), 20n)
    const entries = await user.listBalanceEntries(alice.id, 1000)
    assert.equal(entries.length, 20)
    assert.deepEqual(
      entries.map((entry) => entry.balanceAfter),
      Array.from({ length: 20 }, (_, index) => BigInt(index + 1)),
      '每笔的 balanceAfter 应是连续的 1..20，说明没有交错',
    )
  })
})

test('user/changed：每次成功写入发出通知，顺序、fields 与动作都对，载荷不含秘密', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(UserService, ADMIN_ONLY)
  const events: UserChangedEvent[] = []
  ctx.on('user/changed', (payload) => {
    events.push(payload)
  })

  try {
    const alice = await ctx.user.create(ADMIN, { name: 'alice' })
    const bob = await ctx.user.create(ADMIN, { name: 'bob' })
    await ctx.user.setStatus(ADMIN, bob.id, 'banned')
    await ctx.user.setRole(ADMIN, bob.id, 'admin')
    await ctx.user.setBalanceEnabled(ADMIN, bob.id, true)
    await ctx.user.updateProfile(bob.id, {
      name: 'robert',
      avatar: 'https://example.com/a.png',
    })
    await ctx.user.adjustBalance(ADMIN, bob.id, 0n, '余额事件')
    await ctx.user.updateProfile(bob.id, { avatar: null })
    await ctx.user.remove(ADMIN, bob.id)

    assert.deepEqual(events, [
      { userId: alice.id, action: 'created' },
      { userId: bob.id, action: 'created' },
      { userId: bob.id, action: 'updated', fields: ['status'] },
      { userId: bob.id, action: 'updated', fields: ['role'] },
      { userId: bob.id, action: 'updated', fields: ['balanceEnabled'] },
      { userId: bob.id, action: 'updated', fields: ['name', 'avatar'] },
      { userId: bob.id, action: 'updated', fields: ['balance'] },
      { userId: bob.id, action: 'updated', fields: ['avatar'] },
      { userId: bob.id, action: 'removed' },
    ])

    // 载荷只有 userId / action / fields；没有名字、邮箱、密码、令牌或余额数值
    const serialized = JSON.stringify(events)
    assert.equal(serialized.includes('@'), false)
    assert.equal(/password|hash|token|secret/i.test(serialized), false)
    for (const event of events) {
      assert.deepEqual(
        Object.keys(event).sort(),
        event.fields === undefined ? ['action', 'userId'] : ['action', 'fields', 'userId'],
      )
      assert.equal(typeof event.userId, 'number')
    }

    // 失败的写不发事件
    const before = events.length
    await rejectsCode(ctx.user.setRole(ADMIN, 999, 'admin'), 'USER_NOT_FOUND')
    await rejectsCode(ctx.user.updateProfile(999, { name: 'nobody' }), 'USER_NOT_FOUND')
    assert.equal(events.length, before)
  } finally {
    await fiber.dispose()
  }
})

test('list：可按角色过滤', async () => {
  await withUser(ADMIN_ONLY, async (user) => {
    await user.create(ADMIN, { name: 'alice' }) // admin
    await user.create(ADMIN, { name: 'bob' })
    await user.create(ADMIN, { name: 'carol', role: 'admin' })

    assert.deepEqual((await user.list({ role: 'admin' })).map((item) => item.name), ['alice', 'carol'])
    assert.deepEqual((await user.list({ role: 'user' })).map((item) => item.name), ['bob'])
    await rejectsCode(user.list({ role: 'root' as never }), 'USER_ROLE_INVALID')
  })
})
