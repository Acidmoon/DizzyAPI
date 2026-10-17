/**
 * 集成用例：mailer 接**真的**凭据插件（不是上面那个替身）。
 *
 * 这里 import 另一个插件的实现，是刻意的例外，只出现在测试里：mailer 在运行期
 * 只认结构化 seam（见 src/index.ts 的 CredentialsSeam），但「我们的凭据插件
 * 确实满足那个 seam」这件事，只有把它们接起来才验得到。生产代码不 import 它
 * （AGENTS.md D16）。
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from 'cordis'
import { CredentialsService } from '@dizzyapi/plugin-credentials'
import { MailerService, type CredentialsSeam } from '../src/index.ts'
import { decodeBody, startFakeSmtp } from './fake-smtp.ts'

function authPass(commands: readonly string[]): string | undefined {
  for (let index = commands.length - 1; index >= 0; index--) {
    const line = commands[index]!
    if (line.startsWith('AUTH PLAIN ')) {
      return Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8').split('\0')[2]
    }
  }
  return undefined
}

test('真的凭据插件：mailer 通过引用名取密码，轮换后立刻生效', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  const dataPath = join(await mkdtemp(join(tmpdir(), 'dizzyapi-mailer-')), 'credentials.json')
  const ctx = new Context()
  await ctx.plugin(CredentialsService, { dataPath })
  const credentials = ctx.get('credentials') as CredentialsService
  await credentials.set('dizzyapi/smtp-163', 'first-code')

  await ctx.plugin(MailerService, {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: server.port, user: 'robot', passRef: 'dizzyapi/smtp-163' },
  })
  const mailer = ctx.get('mailer') as MailerService

  await mailer.send({ to: 'alice@example.com', subject: '注册验证码', text: '验证码：111111' })
  assert.equal(authPass(server.commands), 'first-code')
  assert.match(decodeBody(server.body), /验证码：111111/)

  await credentials.set('dizzyapi/smtp-163', 'second-code')
  await mailer.send({ to: 'alice@example.com', subject: '注册验证码', text: '验证码：222222' })
  assert.equal(authPass(server.commands), 'second-code')

  assert.deepEqual(mailer.credentialStatus, { kind: 'ref', ref: 'dizzyapi/smtp-163', configured: true })
})

test('凭据被删掉之后，投递以 MISSING 明确失败', async (t) => {
  const ctx = new Context()
  await ctx.plugin(CredentialsService, {})
  const credentials = ctx.get('credentials') as CredentialsService
  await credentials.set('dizzyapi/smtp-163', 'code')

  await ctx.plugin(MailerService, {
    transport: 'smtp',
    from: 'no-reply@dizzyapi.test',
    allowPlaintext: true,
    smtp: { host: '127.0.0.1', port: 1, user: 'robot', passRef: 'dizzyapi/smtp-163' },
  })
  const mailer = ctx.get('mailer') as MailerService

  await credentials.unset('dizzyapi/smtp-163')
  await assert.rejects(
    mailer.send({ to: 'alice@example.com', subject: 'x', text: 'y' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MAILER_CREDENTIAL_MISSING')
      return true
    },
  )
})

test('凭据服务满足 mailer 声明的 seam（类型层，运行期不 import 实现）', async () => {
  const ctx = new Context()
  await ctx.plugin(CredentialsService, {})
  const credentials = ctx.get('credentials') as CredentialsService

  const seam: CredentialsSeam = credentials
  assert.equal(seam.resolve('dizzyapi/nope'), undefined)
  assert.equal(seam.describe('dizzyapi/nope').configured, false)
})
