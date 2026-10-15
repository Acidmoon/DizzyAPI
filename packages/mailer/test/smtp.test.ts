import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeBody, headersOf, startFakeSmtp } from './fake-smtp.ts'
import {
  encodeHeader,
  sendSmtp,
  serialize,
  SmtpError,
  type SmtpConfig,
  type SmtpMessage,
} from '../src/smtp.ts'

/**
 * 用本机假 SMTP 服务器核对客户端的命令序列。
 *
 * **未覆盖**：真正的 TLS 握手（STARTTLS 与 465）。这里只测到
 * 「服务器不宣告 STARTTLS 时客户端必须拒绝明文投递」这一条安全约束。
 * 投产前必须对真实 SMTP 服务器联调一次。
 */

export function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: '127.0.0.1',
    port,
    secure: false,
    user: 'robot',
    pass: 'p@ssw0rd',
    from: 'no-reply@dizzyapi.test',
    replyTo: undefined,
    heloDomain: 'dizzyapi.test',
    timeoutMs: 5000,
    rejectUnauthorized: true,
    allowPlaintext: true,
    ...overrides,
  }
}

export function message(overrides: Partial<SmtpMessage> = {}): SmtpMessage {
  return {
    to: 'alice@example.com',
    subject: 'DizzyAPI 注册验证码',
    text: '验证码：123456',
    messageId: '<abc@dizzyapi.test>',
    date: 'Thu, 01 Jan 1970 00:00:00 GMT',
    ...overrides,
  }
}

test('按 SMTP 顺序投递：EHLO → AUTH → MAIL → RCPT → DATA → QUIT', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  await sendSmtp(config(server.port), message())

  const verbs = server.commands.map((line) => line.split(' ')[0]!.toUpperCase())
  assert.deepEqual(verbs, ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
  assert.match(server.commands[1]!, /^AUTH PLAIN /)
  assert.equal(server.commands[2], 'MAIL FROM:<no-reply@dizzyapi.test>')
  assert.equal(server.commands[3], 'RCPT TO:<alice@example.com>')
  assert.match(headersOf(server.body), /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m)
  assert.match(decodeBody(server.body), /验证码：123456/)
})

test('AUTH PLAIN 的载荷是 base64(\\0user\\0pass)', async (t) => {
  const server = await startFakeSmtp()
  t.after(() => server.close())

  await sendSmtp(config(server.port), message())
  const token = server.commands[1]!.replace('AUTH PLAIN ', '')
  assert.equal(Buffer.from(token, 'base64').toString('utf8'), '\0robot\0p@ssw0rd')
})

test('认证失败时抛出错误，且错误信息不回显凭据', async (t) => {
  const server = await startFakeSmtp({ authReply: '535 5.7.8 authentication failed' })
  t.after(() => server.close())

  await assert.rejects(sendSmtp(config(server.port), message()), (error: unknown) => {
    assert.ok(error instanceof SmtpError, `期望 SmtpError，收到 ${String(error)}`)
    assert.equal(error.code, 'SMTP_AUTH_FAILED')
    assert.ok(!error.message.includes('p@ssw0rd'), '错误信息里不能出现密码')
    assert.ok(!error.message.includes('robot'), '错误信息里不能出现用户名')
    return true
  })
})

test('服务器不宣告 STARTTLS 时拒绝明文投递，并且不再往下说话', async (t) => {
  const server = await startFakeSmtp({ advertiseStartTls: false })
  t.after(() => server.close())

  await assert.rejects(
    sendSmtp(config(server.port, { allowPlaintext: false }), message()),
    (error: unknown) => {
      assert.ok(error instanceof SmtpError)
      assert.equal(error.code, 'SMTP_STARTTLS_MISSING')
      return true
    },
  )
  assert.deepEqual(server.commands, ['EHLO dizzyapi.test'])
})

test('serialize：非 ASCII 主题按 RFC 2047 编码，正文 base64，头齐全', () => {
  const raw = serialize(message(), config(25))
  const separator = raw.indexOf('\r\n\r\n')
  const headers = raw.slice(0, separator)
  const body = raw.slice(separator + 4)

  assert.match(headers, /^From: no-reply@dizzyapi\.test$/m)
  assert.match(headers, /^To: alice@example\.com$/m)
  assert.match(headers, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/m)
  assert.match(headers, /^Content-Type: text\/plain; charset=utf-8$/m)
  assert.match(headers, /^Content-Transfer-Encoding: base64$/m)
  assert.match(headers, /^Message-ID: <abc@dizzyapi\.test>$/m)
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), '验证码：123456')
})

test('encodeHeader：纯 ASCII 原样，非 ASCII 编码', () => {
  assert.equal(encodeHeader('DizzyAPI register code'), 'DizzyAPI register code')
  assert.equal(encodeHeader('验证码'), '=?UTF-8?B?6aqM6K+B56CB?=')
})
