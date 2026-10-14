import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from 'cordis'
import UserService, { UserError, type UserConfig } from '../src/index.ts'

const ADMIN = '@dizzyapi/plugin-admin'

async function temporaryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dizzyapi-user-'))
}

async function bootAt(path: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  const config: UserConfig = { dataPath: path, adminPlugins: [ADMIN] }
  const fiber = await ctx.plugin(UserService, config)
  return { ctx, dispose: () => fiber.dispose() }
}

test('JSON 存储：重新装载后用户、ID 序号与余额精度都还在', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'users.json')

  // 比 Number.MAX_SAFE_INTEGER 还大，一旦用 number 编解码就会失真
  const huge = 9_007_199_254_740_993n

  const first = await bootAt(file)
  await first.ctx.user.create(ADMIN, { name: 'alice' })
  await first.ctx.user.adjustBalance(ADMIN, 1, huge, '精度测试')
  await first.dispose()

  const second = await bootAt(file)
  t.after(() => second.dispose())

  const alice = await second.ctx.user.get(1)
  assert.equal(alice?.name, 'alice')
  assert.equal(alice?.balance, huge)
  assert.equal((await second.ctx.user.listBalanceEntries(1))[0]?.reason, '精度测试')

  // nextId 也落盘：重启后继续按注册顺序发号，不会从头再来
  assert.equal((await second.ctx.user.create(ADMIN, { name: 'bob' })).id, 2)
})

test('JSON 存储：文件不存在时按空状态启动', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))

  const { ctx, dispose } = await bootAt(join(dir, 'nested', 'users.json'))
  t.after(dispose)

  assert.deepEqual(await ctx.user.list(), [])
  assert.equal((await ctx.user.create(ADMIN, { name: 'alice' })).id, 1)
})

test('JSON 存储：写盘是原子的，不留下临时文件', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'users.json')

  const { ctx, dispose } = await bootAt(file)
  t.after(dispose)
  await ctx.user.create(ADMIN, { name: 'alice' })
  await ctx.user.adjustBalance(ADMIN, 1, 1n, '充值')

  assert.deepEqual(await readdir(dir), ['users.json'])
})

test('JSON 存储：文件损坏时报错，不静默重建成空库', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'users.json')

  const cases: [string, string][] = [
    ['不是 JSON', '{ this is not json'],
    ['版本不认识', JSON.stringify({ version: 99, nextId: 1, users: [], entries: [] })],
    ['余额不是整数字符串', JSON.stringify({
      version: 1,
      nextId: 2,
      users: [{ id: 1, name: 'alice', status: 'enabled', balance: 1.5, createdAt: 'x', updatedAt: 'x' }],
      entries: [],
    })],
    ['状态不认识', JSON.stringify({
      version: 1,
      nextId: 2,
      users: [{ id: 1, name: 'alice', status: 'deleted', balance: '0', createdAt: 'x', updatedAt: 'x' }],
      entries: [],
    })],
  ]

  for (const [label, payload] of cases) {
    await writeFile(file, payload, 'utf8')
    const { ctx, dispose } = await bootAt(file)
    try {
      await assert.rejects(ctx.user.list(), (error: unknown) => {
        assert.ok(error instanceof UserError, `${label}：期望 UserError，收到 ${String(error)}`)
        assert.equal(error.code, 'USER_STORE_CORRUPT')
        return true
      }, label)
    } finally {
      await dispose()
    }
  }
})
