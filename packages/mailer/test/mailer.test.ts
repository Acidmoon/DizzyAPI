import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service, ValidationError } from 'cordis'
import { MailerError, MailerService, type MailerConfig } from '../src/index.ts'
import { decodeBody, startFakeSmtp } from './fake-smtp.ts'

/**
 * 凭据插件的替身：只实现 mailer 用到的那两个方法。
 * 真的凭据插件在 packages/credentials，这里要的是「mailer 的解析路径对不对」。
 */
class FakeCredentials extends Service {
  private readonly values = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  set(ref: string, value: string): void {
    this.values.set(ref, value)
  }

  resolve(ref: string): string | undefined {
    return this.values.get(ref)
  }

  describe(ref: string): { configured: boolean } {
    return { configured: this.values.has(ref) }
  }
}

/** 从假服务器记录的命令里取回 AUTH PLAIN 的密码（取最后一次）。 */
function authPass(commands: readonly string[]): string | undefined {
  for (let index = commands.length - 1; index >= 0; index--) {
    const line = commands[index]!
    if (!line.startsWith('AUTH PLAIN ')) continue
    return Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8').split('\0')[2]
  }
  return undefined
}

async function boot(config: MailerConfig): Promise<{ ctx: Context; mailer: MailerService }> {
  const ctx = new Context()
  await ctx.plugin(MailerService, config)
  return { ctx, mailer: ctx.get('mailer') as MailerService }
}

test('log 投递：不碰网络，返回回执', async () => {
  const { mailer } = await boot({ transport: 'log' })
  const receipt = await mailer.send({ to: 'alice@example.com', subject: '注册验证码', text: '验证码：123456' })
  assert.equal(receipt.transport, 'log')
  assert.equal(receipt.to, 'alice@example.com')
  assert.ok(receipt.id.length > 0)
})

test('smtp 投递：走真实 socket 命令，正文能还原', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  const { mailer } = await boot({
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    heloDomain: 'dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: server.port },
  })

  const receipt = await mailer.send({ to: 'alice@example.com', subject: '注册验证码', text: '验证码：654321' })
  assert.equal(receipt.transport, 'smtp')
  assert.match(decodeBody(server.body), /验证码：654321/)
})

test('投递失败时包成 MailerError，并带上原因', async (t) => {
  const server = await startFakeSmtp({ authReply: '535 5.7.8 nope' })
  t.after(() => server.close())

  const { mailer } = await boot({
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: server.port, user: 'robot', pass: 'p@ssw0rd' },
  })

  await assert.rejects(
    mailer.send({ to: 'alice@example.com', subject: '注册验证码', text: '验证码：000000' }),
    (error: unknown) => {
      assert.ok(error instanceof MailerError)
      assert.equal(error.code, 'MAILER_SEND_FAILED')
      return true
    },
  )
})

test('消息本身不合法时直接拒绝', async () => {
  const { mailer } = await boot({ transport: 'log' })
  await assert.rejects(
    mailer.send({ to: 'not-an-email', subject: 'x', text: 'y' }),
    (error: unknown) => {
      assert.ok(error instanceof MailerError)
      assert.equal(error.code, 'MAILER_MESSAGE_INVALID')
      return true
    },
  )
  await assert.rejects(
    mailer.send({ to: 'alice@example.com', subject: '  ', text: 'y' }),
    (error: unknown) => {
      assert.ok(error instanceof MailerError)
      assert.equal(error.code, 'MAILER_MESSAGE_INVALID')
      return true
    },
  )
})

test('配置 schema 由 cordis 强制执行', async () => {
  const ctx = new Context()

  await assert.rejects(
    async () => {
      await ctx.plugin(MailerService, { nope: true } as unknown as MailerConfig)
    },
    ValidationError,
  )
  await assert.rejects(
    async () => {
      await ctx.plugin(MailerService, { transport: 'smtp' })
    },
    ValidationError,
    'smtp 但没给 from / smtp 子对象，必须拒绝',
  )
  await assert.rejects(
    async () => {
      await ctx.plugin(MailerService, {
        transport: 'smtp',
        from: 'no-reply@dizzyapi.test',
        smtp: { host: '127.0.0.1', port: 25, passEnv: 'DIZZYAPI_TEST_MAIL_PASS_SHOULD_BE_EMPTY' },
      })
    },
    ValidationError,
    'passEnv 指向空环境变量，必须拒绝',
  )
})

test('密码三选一：pass / passEnv / passRef 同时给多个必须拒绝', async () => {
  for (const smtp of [
    { pass: 'a', passEnv: 'P' },
    { pass: 'a', passRef: 'r' },
    { passEnv: 'P', passRef: 'r' },
    { pass: 'a', passEnv: 'P', passRef: 'r' },
  ]) {
    const ctx = new Context()
    await assert.rejects(
      async () => {
        await ctx.plugin(MailerService, {
          transport: 'smtp',
          from: 'no-reply@dizzyapi.test',
          smtp: { host: '127.0.0.1', port: 25, ...smtp },
        })
      },
      ValidationError,
      `${JSON.stringify(smtp)} 应当被拒绝`,
    )
  }
})

test('passRef 只在投递时解析，因此装载时不需要凭据插件在', async () => {
  const ctx = new Context()
  await ctx.plugin(MailerService, {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    smtp: { host: '127.0.0.1', port: 25, user: 'robot', passRef: 'dizzyapi/smtp-163' },
  })
  const mailer = ctx.get('mailer') as MailerService
  assert.equal(mailer.credentialStatus.kind, 'ref')
  assert.equal(mailer.credentialStatus.configured, false)
})

test('配了 passRef 却没有凭据服务：投递明确失败，且不被包成 SEND_FAILED', async () => {
  const ctx = new Context()
  await ctx.plugin(MailerService, {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: 25, user: 'robot', passRef: 'dizzyapi/smtp-163' },
  })
  const mailer = ctx.get('mailer') as MailerService

  await assert.rejects(
    mailer.send({ to: 'alice@example.com', subject: 'x', text: 'y' }),
    (error: unknown) => {
      assert.ok(error instanceof MailerError)
      assert.equal(error.code, 'MAILER_CREDENTIAL_UNAVAILABLE')
      return true
    },
  )
})

test('凭据里还没有这个引用：报 MISSING，而不是去连服务器', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  const ctx = new Context()
  await ctx.plugin(FakeCredentials)
  await ctx.plugin(MailerService, {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: server.port, user: 'robot', passRef: 'dizzyapi/smtp-163' },
  })
  const mailer = ctx.get('mailer') as MailerService

  await assert.rejects(
    mailer.send({ to: 'alice@example.com', subject: 'x', text: 'y' }),
    (error: unknown) => {
      assert.ok(error instanceof MailerError)
      assert.equal(error.code, 'MAILER_CREDENTIAL_MISSING')
      return true
    },
  )
  assert.equal(server.commands.length, 0, '不该连上去')
})

test('密码来自凭据插件：轮换后下一次投递就用新值，全程不重启', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  const ctx = new Context()
  await ctx.plugin(FakeCredentials)
  const credentials = ctx.get('credentials') as unknown as FakeCredentials
  credentials.set('dizzyapi/smtp-163', 'auth-code-old')

  await ctx.plugin(MailerService, {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: server.port, user: 'robot', passRef: 'dizzyapi/smtp-163' },
  })
  const mailer = ctx.get('mailer') as MailerService
  assert.equal(mailer.credentialStatus.configured, true)

  await mailer.send({ to: 'alice@example.com', subject: '第一封', text: 'x' })
  assert.equal(authPass(server.commands), 'auth-code-old')

  credentials.set('dizzyapi/smtp-163', 'auth-code-new')
  await mailer.send({ to: 'alice@example.com', subject: '第二封', text: 'y' })
  assert.equal(authPass(server.commands), 'auth-code-new')
  // 轮换不涉及任何配置变更，因而不该有重新装载
  assert.equal(mailer.config.smtp?.passRef, 'dizzyapi/smtp-163')
})
