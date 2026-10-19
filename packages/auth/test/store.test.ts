import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { Context, Service } from 'cordis'
import UserService from '@dizzyapi/plugin-user'
import type { MailMessage, SendReceipt } from '@dizzyapi/plugin-mailer'
import AuthService, { AuthError, type AuthConfig } from '../src/index.ts'
import { sha256Hex, hashPassword } from '../src/crypto.ts'

const ACTOR = '@dizzyapi/plugin-auth'
const EMAIL = 'legacy@example.com'
const PASSWORD = 'legacy password'
const NOW = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'

class StubMailer extends Service {
  sent: MailMessage[] = []

  constructor(ctx: Context) {
    super(ctx, 'mailer')
  }

  async send(message: MailMessage): Promise<SendReceipt> {
    this.sent.push(message)
    return {
      id: `stub-${this.sent.length}`,
      to: message.to,
      transport: 'stub',
      acceptedAt: NOW,
    }
  }
}

interface Harness {
  ctx: Context
  dispose(): Promise<void>
}

async function boot(authPath: string, userPath?: string): Promise<Harness> {
  const ctx = new Context()
  const userFiber = await ctx.plugin(UserService, {
    adminPlugins: [ACTOR],
    ...(userPath === undefined ? {} : { dataPath: userPath }),
  })
  const mailerFiber = await ctx.plugin(StubMailer)
  const authFiber = await ctx.plugin(AuthService, {
    dataPath: authPath,
    userActor: ACTOR,
    codeResendCooldownMs: 0,
    codeRequestsPerHour: 100,
  } satisfies AuthConfig)
  return {
    ctx,
    async dispose() {
      await authFiber.dispose()
      await mailerFiber.dispose()
      await userFiber.dispose()
    },
  }
}

async function temporaryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dizzyapi-auth-store-'))
}

/** 先逆序关闭插件释放 SQLite 句柄，再删目录；Windows 上顺序反过来会 EBUSY。 */
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

function legacySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    credentials: [],
    pendings: [],
    sessions: [],
    counters: [],
    ...overrides,
  }
}

test('SQLite：建表与迁移幂等；文件库启用 WAL；版本记录在 user_version', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const file = join(dir, 'auth.db')

  const first = await boot(file)
  track.push(first.dispose)
  await first.dispose()

  const second = await boot(file)
  track.push(second.dispose)
  await second.dispose()

  const raw = new DatabaseSync(file)
  try {
    assert.equal(Number(raw.prepare('PRAGMA user_version').get()?.user_version), 1)
    assert.equal(String(raw.prepare('PRAGMA journal_mode').get()?.journal_mode).toLowerCase(), 'wal')
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => String(row.name))
    for (const table of ['credentials', 'pendings', 'sessions', 'counters']) {
      assert.ok(tables.includes(table), `缺少表 ${table}`)
    }
  } finally {
    raw.close()
  }
})

test('旧 auth.json 一次性导入：凭证、验证码、会话、计数都可用；旧文件保留', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const legacy = join(dir, 'auth.json')
  const file = join(dir, 'auth.db')

  const passwordHash = await hashPassword(PASSWORD)
  const token = 'legacy-session-token'
  const future = new Date(Date.now() + 3600_000).toISOString()

  await writeFile(
    legacy,
    JSON.stringify(
      legacySnapshot({
        credentials: [
          { userId: 1, email: EMAIL, passwordHash, createdAt: NOW, updatedAt: NOW },
        ],
        pendings: [
          {
            purpose: 'register',
            email: 'pending@example.com',
            codeHash: 'deadbeef',
            salt: 'salt',
            attempts: 0,
            createdAt: NOW,
            expiresAt: future,
            name: 'pending',
            passwordHash: 'scrypt$1$1$1$AA$AA',
          },
        ],
        sessions: [
          {
            id: 'legacy-session',
            userId: 1,
            tokenHash: sha256Hex(token),
            createdAt: NOW,
            expiresAt: future,
            lastSeenAt: NOW,
          },
        ],
        counters: [
          { key: 'legacy:counter', count: 1, windowStart: new Date().toISOString(), windowMs: 900_000 },
        ],
      }),
      null,
      2,
    ),
    'utf8',
  )

  const harness = await boot(file)
  track.push(harness.dispose)

  const user = await harness.ctx.user.create(ACTOR, { name: 'legacy' })
  assert.equal(user.id, 1)

  // 凭证可用
  const loggedIn = await harness.ctx.auth.login({ email: EMAIL, password: PASSWORD })
  assert.equal(loggedIn.user.id, 1)

  // 会话可用（导入的会话在登录前就已签发）
  const view = await harness.ctx.auth.verifySession(token)
  assert.equal(view.userId, 1)
  assert.equal(view.email, EMAIL)

  // 验证码与计数窗口也导入了
  const raw = new DatabaseSync(file)
  try {
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM pendings').get()?.n), 1)
    assert.equal(Number(raw.prepare('SELECT COUNT(*) AS n FROM counters').get()?.n), 1)
  } finally {
    raw.close()
  }

  // 旧文件保留
  assert.equal(existsSync(legacy), true)
  assert.equal(JSON.parse(readFileSync(legacy, 'utf8')).version, 1)
})

test('旧 auth.json 不会覆盖已有数据库', async (t) => {
  const dir = await temporaryDir()
  const track = trackCleanup(t, dir)
  const legacy = join(dir, 'auth.json')
  const file = join(dir, 'auth.db')

  // 先建一个正常注册的用户
  const first = await boot(file)
  track.push(first.dispose)
  await first.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD })
  const mailer = first.ctx.get('mailer') as StubMailer
  const code = /验证码：(\d+)/.exec(mailer.sent[0]!.text)![1]!
  const registered = await first.ctx.auth.confirmRegistration({ email: EMAIL, code })
  await first.dispose()

  await writeFile(
    legacy,
    JSON.stringify(
      legacySnapshot({
        credentials: [
          {
            userId: 1,
            email: 'json@example.com',
            passwordHash: await hashPassword('json password'),
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
      }),
    ),
    'utf8',
  )

  const second = await boot(file)
  track.push(second.dispose)
  // DB 里的凭证还在，JSON 里的没被导进来
  assert.equal(await second.ctx.auth.getEmail(registered.user.id), EMAIL)
  assert.notEqual(await second.ctx.auth.getEmail(registered.user.id), 'json@example.com')
})

test('旧 auth.json 损坏时整份拒绝导入，不留下半截数据库', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacy = join(dir, 'auth.json')
  const file = join(dir, 'auth.db')
  await writeFile(legacy, '{ this is not json', 'utf8')

  await assert.rejects(
    async () => {
      await boot(file)
    },
    (error: unknown) => {
      assert.ok(error instanceof AuthError, `期望 AuthError，收到 ${String(error)}`)
      assert.equal(error.code, 'AUTH_STORE_CORRUPT')
      return true
    },
  )

  assert.equal(existsSync(file), false)
  assert.equal(existsSync(legacy), true)
})

test('数据库文件损坏时报告 AUTH_STORE_CORRUPT，不静默重建', async (t) => {
  const dir = await temporaryDir()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'auth.db')
  await writeFile(file, 'definitely not a sqlite database', 'utf8')

  await assert.rejects(
    async () => {
      await boot(file)
    },
    (error: unknown) => {
      assert.ok(error instanceof AuthError, `期望 AuthError，收到 ${String(error)}`)
      assert.equal(error.code, 'AUTH_STORE_CORRUPT')
      return true
    },
  )
})
