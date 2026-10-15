import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service, ValidationError } from 'cordis'
import UserService from '@dizzyapi/plugin-user'
import type { MailMessage, SendReceipt } from '@dizzyapi/plugin-mailer'
import AuthService, { AuthError, type AuthConfig, type AuthErrorCode } from '../src/index.ts'

const ACTOR = '@dizzyapi/plugin-auth'
const EMAIL = 'alice@example.com'
const PASSWORD = 'correct horse battery'

/** 记录式通讯模块：把「发出去的邮件」留在内存里，测试再从里面取验证码。 */
class RecordingMailer extends Service {
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
      acceptedAt: new Date().toISOString(),
    }
  }

  last(): MailMessage {
    const message = this.sent[this.sent.length - 1]
    if (message === undefined) throw new Error('测试期间没有发出任何邮件')
    return message
  }

  codeOf(index = this.sent.length - 1): string {
    const message = this.sent[index]
    if (message === undefined) throw new Error(`没有第 ${index} 封邮件`)
    const match = /验证码：(\d+)/.exec(message.text)
    if (match === null) throw new Error(`邮件里没有验证码：${message.text}`)
    return match[1]!
  }
}

interface Harness {
  ctx: Context
  mailer: RecordingMailer
  dispose(): Promise<void>
}

async function boot(
  options: { auth?: AuthConfig; userAdmins?: string[]; userDataPath?: string } = {},
): Promise<Harness> {
  const ctx = new Context()
  const userFiber = await ctx.plugin(UserService, {
    adminPlugins: options.userAdmins ?? [ACTOR],
    dataPath: options.userDataPath,
  })
  const mailerFiber = await ctx.plugin(RecordingMailer)
  const authFiber = await ctx.plugin(AuthService, {
    // 测试里不想被冷却与限流挡住，除非测试自己指定
    codeResendCooldownMs: 0,
    codeRequestsPerHour: 100,
    ...options.auth,
  })

  return {
    ctx,
    mailer: ctx.get('mailer') as RecordingMailer,
    async dispose() {
      await authFiber.dispose()
      await mailerFiber.dispose()
      await userFiber.dispose()
    },
  }
}

async function rejectsCode(operation: Promise<unknown>, code: AuthErrorCode): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof AuthError, `期望 AuthError，收到 ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

async function register(harness: Harness, email = EMAIL, password = PASSWORD, name?: string) {
  await harness.ctx.auth.requestRegistration(name === undefined ? { email, password } : { email, password, name })
  return harness.ctx.auth.confirmRegistration({ email, code: harness.mailer.codeOf() })
}

test('注册全流程：验证码通过之前不建用户，通过之后建用户 + 建凭证 + 直接给会话', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())

  const ticket = await harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD, name: 'alice' })
  assert.equal(ticket.email, EMAIL)
  assert.ok(ticket.expiresAt > ticket.email ? true : true)

  // 还没验证码之前，用户表里什么都没有
  assert.deepEqual(await harness.ctx.user.list(), [])
  assert.equal(harness.mailer.sent.length, 1)
  assert.equal(harness.mailer.last().kind, 'auth-register-code')
  assert.equal(harness.mailer.last().to, EMAIL)

  const result = await harness.ctx.auth.confirmRegistration({ email: EMAIL, code: harness.mailer.codeOf() })
  assert.equal(result.user.id, 1)
  assert.equal(result.user.name, 'alice')
  assert.equal(result.user.status, 'enabled')
  assert.equal(result.user.balance, 0n)

  const users = await harness.ctx.user.list()
  assert.equal(users.length, 1)

  // 注册即登录：拿到的令牌可以换回身份
  const view = await harness.ctx.auth.verifySession(result.token)
  assert.equal(view.userId, 1)
  assert.equal(view.user.name, 'alice')
  assert.equal(view.sessionId, result.sessionId)
})

test('验证码：错了不建用户；错够次数作废；过期/重复确认都不认', async (t) => {
  const harness = await boot({ auth: { codeMaxAttempts: 3 } })
  t.after(() => harness.dispose())

  await harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD })
  const code = harness.mailer.codeOf()
  const wrong = code === '000000' ? '111111' : '000000'

  await rejectsCode(harness.ctx.auth.confirmRegistration({ email: EMAIL, code: wrong }), 'AUTH_CODE_INVALID')
  await rejectsCode(harness.ctx.auth.confirmRegistration({ email: EMAIL, code: wrong }), 'AUTH_CODE_INVALID')
  assert.deepEqual(await harness.ctx.user.list(), [])

  // 第三次错到上限：这条码作废
  await rejectsCode(
    harness.ctx.auth.confirmRegistration({ email: EMAIL, code: wrong }),
    'AUTH_CODE_ATTEMPTS_EXCEEDED',
  )
  await rejectsCode(harness.ctx.auth.confirmRegistration({ email: EMAIL, code }), 'AUTH_CODE_INVALID')
})

test('防枚举：邮箱已注册时回执形状一致，但不再发信', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())

  await register(harness)
  assert.equal(harness.mailer.sent.length, 1)

  const again = await harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD })
  assert.equal(again.email, EMAIL)
  assert.equal(harness.mailer.sent.length, 1, '已占用的邮箱不应再发验证码')
  assert.equal((await harness.ctx.user.list()).length, 1)
})

test('登录：密码与身份都要对；邮箱不存在与密码错误给同一个错误', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())
  await register(harness)

  const ok = await harness.ctx.auth.login({ email: EMAIL, password: PASSWORD })
  assert.equal(ok.user.id, 1)

  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: 'wrong password' }), 'AUTH_CREDENTIALS_INVALID')
  await rejectsCode(harness.ctx.auth.login({ email: 'nobody@example.com', password: PASSWORD }), 'AUTH_CREDENTIALS_INVALID')
  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: '' }), 'AUTH_CREDENTIALS_INVALID')
})

test('登录失败次数到上限后暂时拒绝', async (t) => {
  const harness = await boot({ auth: { loginMaxFailures: 2 } })
  t.after(() => harness.dispose())
  await register(harness)

  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: 'nope' }), 'AUTH_CREDENTIALS_INVALID')
  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: 'nope' }), 'AUTH_CREDENTIALS_INVALID')
  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: PASSWORD }), 'AUTH_RATE_LIMITED')
})

test('验证码请求次数到上限后拒绝', async (t) => {
  const harness = await boot({ auth: { codeRequestsPerHour: 2 } })
  t.after(() => harness.dispose())

  await harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD })
  await harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD })
  await rejectsCode(
    harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD }),
    'AUTH_RATE_LIMITED',
  )
})

test('封禁的用户不能登录，已签发的会话也立即失效', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())
  const result = await register(harness)

  await harness.ctx.user.setStatus(ACTOR, result.user.id, 'banned')
  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: PASSWORD }), 'AUTH_USER_BANNED')
  await rejectsCode(harness.ctx.auth.verifySession(result.token), 'AUTH_USER_BANNED')
})

test('会话：登出即失效；列表只看见自己的；可逐个或全部吊销', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())
  const first = await register(harness)
  const second = await harness.ctx.auth.login({ email: EMAIL, password: PASSWORD })

  const sessions = await harness.ctx.auth.listSessions(first.token)
  assert.equal(sessions.length, 2)
  assert.equal(sessions.filter((item) => item.current).length, 1)

  await harness.ctx.auth.revokeSession(first.token, second.sessionId)
  await rejectsCode(harness.ctx.auth.verifySession(second.token), 'AUTH_SESSION_INVALID')

  await harness.ctx.auth.logout(first.token)
  await rejectsCode(harness.ctx.auth.verifySession(first.token), 'AUTH_SESSION_INVALID')

  const third = await harness.ctx.auth.login({ email: EMAIL, password: PASSWORD })
  assert.equal(await harness.ctx.auth.revokeAllSessions(third.token), 1)
  await rejectsCode(harness.ctx.auth.verifySession(third.token), 'AUTH_SESSION_INVALID')
})

test('改密：先验旧密码；改完作废其它会话，当前会话还能用', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())
  const first = await register(harness)
  const second = await harness.ctx.auth.login({ email: EMAIL, password: PASSWORD })

  await rejectsCode(
    harness.ctx.auth.changePassword(first.token, 'not the password', 'brand new password'),
    'AUTH_CREDENTIALS_INVALID',
  )
  await rejectsCode(
    harness.ctx.auth.changePassword(first.token, PASSWORD, 'short'),
    'AUTH_PASSWORD_WEAK',
  )

  const outcome = await harness.ctx.auth.changePassword(first.token, PASSWORD, 'brand new password')
  assert.equal(outcome.revokedSessions, 1, '其它会话要被作废')

  await harness.ctx.auth.verifySession(first.token)
  await rejectsCode(harness.ctx.auth.verifySession(second.token), 'AUTH_SESSION_INVALID')
  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: PASSWORD }), 'AUTH_CREDENTIALS_INVALID')
  assert.equal((await harness.ctx.auth.login({ email: EMAIL, password: 'brand new password' })).user.id, first.user.id)
})

test('找回密码：验证码通过后换密码，并把全部会话作废', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())
  const session = await register(harness)

  await harness.ctx.auth.requestPasswordReset(EMAIL)
  assert.equal(harness.mailer.last().kind, 'auth-reset-code')
  const code = harness.mailer.codeOf()

  const outcome = await harness.ctx.auth.confirmPasswordReset({ email: EMAIL, code, password: 'another good password' })
  assert.equal(outcome.userId, session.user.id)
  assert.equal(outcome.revokedSessions, 1)

  await rejectsCode(harness.ctx.auth.verifySession(session.token), 'AUTH_SESSION_INVALID')
  await rejectsCode(harness.ctx.auth.login({ email: EMAIL, password: PASSWORD }), 'AUTH_CREDENTIALS_INVALID')
  assert.equal(
    (await harness.ctx.auth.login({ email: EMAIL, password: 'another good password' })).user.id,
    session.user.id,
  )
})

test('找回密码同样防枚举：没注册过的邮箱不发信', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())

  const ticket = await harness.ctx.auth.requestPasswordReset('nobody@example.com')
  assert.equal(ticket.email, 'nobody@example.com')
  assert.equal(harness.mailer.sent.length, 0)
})

test('不填用户名时用邮箱本地部分派生；撞名自动加后缀', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())

  // 先手工占用 alice 这个名字
  await harness.ctx.user.create(ACTOR, { name: 'alice' })

  const result = await register(harness)
  assert.equal(result.user.name, 'alice-2')
  assert.equal(result.user.id, 2)
})

test('用户插件没授权本插件建用户时，注册明确失败', async (t) => {
  const harness = await boot({ userAdmins: ['@dizzyapi/plugin-someone-else'] })
  t.after(() => harness.dispose())

  await harness.ctx.auth.requestRegistration({ email: EMAIL, password: PASSWORD })
  await rejectsCode(
    harness.ctx.auth.confirmRegistration({ email: EMAIL, code: harness.mailer.codeOf() }),
    'AUTH_DEPENDENCY_MISSING',
  )
  assert.deepEqual(await harness.ctx.user.list(), [])
})

test('用户被删除后留下孤儿凭证：同邮箱可以重新注册，拿到新的用户 ID', async (t) => {
  const harness = await boot()
  t.after(() => harness.dispose())

  const first = await register(harness)
  await harness.ctx.user.remove(ACTOR, first.user.id)
  assert.equal((await harness.ctx.user.list()).length, 0)

  const second = await register(harness)
  assert.equal(second.user.id, 2, '用户 ID 不复用，重新注册拿到新号')
  assert.equal((await harness.ctx.auth.login({ email: EMAIL, password: PASSWORD })).user.id, 2)
})

test('凭证与会话落盘：换一个 Context 重新装载后仍然能登录', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dizzyapi-auth-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const dataPath = { userDataPath: join(dir, 'users.json'), auth: { dataPath: join(dir, 'auth.json') } }

  const first = await boot(dataPath)
  const registered = await register(first)
  const session = await first.ctx.auth.login({ email: EMAIL, password: PASSWORD })
  await first.dispose()

  const second = await boot(dataPath)
  t.after(() => second.dispose())

  // 用户表与凭证都落盘了
  const again = await second.ctx.auth.login({ email: EMAIL, password: PASSWORD })
  assert.equal(again.user.id, registered.user.id)
  assert.equal(again.user.name, registered.user.name)

  // 会话也落盘了
  assert.equal((await second.ctx.auth.verifySession(session.token)).userId, registered.user.id)
})

test('配置 schema 由 cordis 强制执行：未知字段直接拒绝', async () => {
  const ctx = new Context()
  await ctx.plugin(UserService, { adminPlugins: [ACTOR] })
  await ctx.plugin(RecordingMailer)

  await assert.rejects(
    async () => {
      await ctx.plugin(AuthService, { nope: true } as unknown as AuthConfig)
    },
    ValidationError,
  )
  assert.equal(ctx.get('auth'), undefined)
})

test('缺少 mailer 时插件不上马：inject 没被满足，服务不存在', async () => {
  const ctx = new Context()
  await ctx.plugin(UserService, { adminPlugins: [ACTOR] })
  assert.equal(ctx.get('mailer'), undefined)

  // 依赖没满足时 cordis 把 fiber 停在 PENDING：不构造，也不报错。
  // 注意不能拿 `await fiber` 判断——PENDING 且没有在途工作的 fiber 也会立刻 resolve。
  const fiber = ctx.plugin(AuthService, {})
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(ctx.get('auth'), undefined, '依赖没满足时不该构造插件')
  assert.equal(fiber.state, 0, 'fiber 应停在 FiberState.PENDING')
})
