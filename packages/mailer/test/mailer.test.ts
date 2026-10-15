import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, ValidationError } from 'cordis'
import { MailerError, MailerService, type MailerConfig } from '../src/index.ts'
import { decodeBody, startFakeSmtp } from './fake-smtp.ts'

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
