import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context } from 'cordis'
import UserService, { UserError, type UserConfig } from '../src/index.ts'

const ADMIN = '@dizzyapi/plugin-admin'

async function temporaryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dizzyapi-user-'))
}

/**
 * 清理钩子：先逆序关闭所有插件（释放 SQLite 文件句柄），再删临时目录。
 * Windows 上顺序反过来会 EBUSY。
 */
function trackCleanup(
  t: { after(fn: () => unknown): void },
  dir: string,
): Array<() => Promise<void>> {
  const disposers: Array<() => Promise<void>> = []
  t.after(async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(dir, { recursive: true, force: true })
  })
  return disposers
}

async function bootAt(path: string | undefined): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const config: UserConfig = { dataPath: path, adminPlugins: [ADMIN] }
  const fiber = await ctx.plugin(UserService, config)
  return { ctx, dispose: () => fiber.dispose() }
}

test('SQLite：重新装载后用户、角色、资料、ID 序号与余额精度都还在', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const file = join(dir, 'users.db')

  // 比 Number.MAX_SAFE_INTEGER 还大，一旦用 number 编解码就会失真
  const huge = 9_007_199_254_740_993n

  const first = await bootAt(file)
  track.push(first.dispose)
  await first.ctx.user.create(ADMIN, { name: 'alice' })
  await first.ctx.user.create(ADMIN, { name: 'bob' })
  await first.ctx.user.updateProfile(2, {
    name: 'robert',
    avatar: 'https://example.com/avatar.png',
  })
  await first.ctx.user.setBalanceEnabled(ADMIN, 2, true)
  await first.ctx.user.adjustBalance(ADMIN, 2, huge, '精度测试')
  await first.dispose()

  const second = await bootAt(file)
  track.push(second.dispose)

  const alice = await second.ctx.user.get(1)
  assert.equal(alice?.name, 'alice')
  assert.equal(alice?.role, 'admin')
  assert.equal(alice?.balanceEnabled, false)

  const robert = await second.ctx.user.get(2)
  assert.equal(robert?.name, 'robert')
  assert.equal(robert?.role, 'user')
  assert.equal(robert?.avatar, 'https://example.com/avatar.png')
  assert.equal(robert?.balanceEnabled, true)
  assert.equal(robert?.balance, huge)
  assert.equal((await second.ctx.user.listBalanceEntries(2))[0]?.reason, '精度测试')

  // AUTOINCREMENT 落盘：重启后继续按注册顺序发号，不会从头再来
  assert.equal((await second.ctx.user.create(ADMIN, { name: 'carol' })).id, 3)
})

test('dataPath 省略时用内存库：进程退出即丢', async () => {
  const first = await bootAt(undefined)
  await first.ctx.user.create(ADMIN, { name: 'alice' })
  assert.equal((await first.ctx.user.list()).length, 1)
  await first.dispose()

  const second = await bootAt(undefined)
  try {
    assert.deepEqual(await second.ctx.user.list(), [])
  } finally {
    await second.dispose()
  }
})

test('建表与迁移幂等；文件库启用 WAL；版本记录在 user_version', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const file = join(dir, 'users.db')

  const first = await bootAt(file)
  track.push(first.dispose)
  await first.ctx.user.create(ADMIN, { name: 'alice' })
  await first.dispose()

  // 再打开两次：CREATE TABLE IF NOT EXISTS + user_version 不应报错、不应清数据
  const second = await bootAt(file)
  track.push(second.dispose)
  assert.equal((await second.ctx.user.list()).length, 1)
  await second.dispose()

  const raw = new DatabaseSync(file)
  try {
    assert.equal(Number(raw.prepare('PRAGMA user_version').get()?.user_version), 1)
    assert.equal(String(raw.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase(), 'wal')
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    assert.ok(tables.includes('users'))
    assert.ok(tables.includes('balance_entries'))
  } finally {
    raw.close()
  }

  const third = await bootAt(file)
  track.push(third.dispose)
  assert.equal((await third.ctx.user.get(1))?.name, 'alice')
})

test('旧 users.json 一次性导入：用户、流水、首用户 admin、nextId 不复用；旧文件保留', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const legacy = join(dir, 'users.json')
  const file = join(dir, 'users.db')

  const huge = '9007199254740993'
  await writeFile(
    legacy,
    JSON.stringify({
      version: 1,
      nextId: 5, // 3、4 号用户曾经存在并被删除过
      users: [
        { id: 1, name: 'alice', status: 'enabled', balance: '0', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 2, name: 'bob', status: 'banned', balance: huge, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
      ],
      entries: [
        { userId: 2, delta: huge, balanceAfter: huge, reason: '迁移充值', actor: '@dizzyapi/plugin-payment', at: '2026-01-03T00:00:00.000Z' },
      ],
    }),
    'utf8',
  )

  const { ctx, dispose } = await bootAt(file)
  track.push(dispose)

  const alice = await ctx.user.get(1)
  assert.equal(alice?.role, 'admin', '旧数据没有 role，首个用户补成 admin')
  assert.equal(alice?.balanceEnabled, false)
  assert.equal(alice?.avatar, null)

  const bob = await ctx.user.get(2)
  assert.equal(bob?.role, 'user')
  assert.equal(bob?.status, 'banned')
  assert.equal(bob?.balance, 9_007_199_254_740_993n)
  assert.equal((await ctx.user.listBalanceEntries(2))[0]?.reason, '迁移充值')

  // nextId=5 表示 3、4 已经用过；迁移后不能复用
  assert.equal((await ctx.user.create(ADMIN, { name: 'carol' })).id, 5)

  // 旧文件保留，内容一字未动
  assert.equal(existsSync(legacy), true)
  assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).version, 1)
})

test('旧 users.json 不会覆盖已有数据库', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const legacy = join(dir, 'users.json')
  const file = join(dir, 'users.db')

  const first = await bootAt(file)
  track.push(first.dispose)
  await first.ctx.user.create(ADMIN, { name: 'from-db' })
  await first.dispose()

  await writeFile(
    legacy,
    JSON.stringify({
      version: 1,
      nextId: 2,
      users: [
        { id: 1, name: 'from-json', status: 'enabled', balance: '0', createdAt: 'x', updatedAt: 'x' },
      ],
      entries: [],
    }),
    'utf8',
  )

  const second = await bootAt(file)
  track.push(second.dispose)
  assert.deepEqual((await second.ctx.user.list()).map((item) => item.name), ['from-db'])
})

test('旧 users.json 损坏时整份拒绝导入，不留下半截数据库', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacy = join(dir, 'users.json')
  const file = join(dir, 'users.db')

  await writeFile(legacy, '{ this is not json', 'utf8')

  await assert.rejects(
    async () => {
      await bootAt(file)
    },
    (error: unknown) => {
      assert.ok(error instanceof UserError, `期望 UserError，收到 ${String(error)}`)
      assert.equal(error.code, 'USER_STORE_CORRUPT')
      return true
    },
  )

  // 新建的空库被清掉，下次启动还能重试；旧文件保留
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(legacy), true)
})

test('数据库文件损坏时报告 USER_STORE_CORRUPT，不静默重建', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'users.db')
  await writeFile(file, 'definitely not a sqlite database', 'utf8')

  await assert.rejects(
    async () => {
      await bootAt(file)
    },
    (error: unknown) => {
      assert.ok(error instanceof UserError, `期望 UserError，收到 ${String(error)}`)
      assert.equal(error.code, 'USER_STORE_CORRUPT')
      return true
    },
  )
})
