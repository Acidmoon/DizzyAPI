import { randomBytes } from 'node:crypto'
import { connect as connectTcp, type Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'

/**
 * 极简 SMTP 客户端：只够发一封纯文本邮件。
 *
 * 为什么不用 nodemailer：本项目对依赖很克制，而这里需要的子集很小——
 * EHLO / STARTTLS / AUTH（PLAIN 或 LOGIN）/ MAIL FROM / RCPT TO / DATA / QUIT。
 *
 * **未与真实 SMTP 服务器联调过**：验证只到「用本机假服务器核对命令序列」这一层
 * （见 test/smtp.test.ts）。要投产必须先对真实服务器跑一次。
 */

export interface SmtpConfig {
  readonly host: string
  readonly port: number
  /** true = 直接 TLS（465 常见）；false = 明文连上后 STARTTLS（587 常见）。 */
  readonly secure: boolean
  readonly user?: string
  readonly pass?: string
  readonly from: string
  readonly replyTo?: string
  readonly heloDomain: string
  readonly timeoutMs: number
  /** 自签证书等场合才关；默认校验。 */
  readonly rejectUnauthorized: boolean
  /** 允许明文投递（不做 STARTTLS）。默认 false；关着时明文连上必须先 STARTTLS。 */
  readonly allowPlaintext: boolean
}

export interface SmtpMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly messageId: string
  readonly date: string
}

export class SmtpError extends Error {
  readonly code: string
  readonly command: string | undefined
  readonly response: string | undefined

  constructor(code: string, message: string, command?: string, response?: string) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
    this.command = command
    this.response = response
  }
}

export async function sendSmtp(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const connection = await SmtpConnection.open(config)
  try {
    await connection.greet(config)
    await connection.command(`MAIL FROM:<${stripAngles(config.from)}>`, [250])
    await connection.command(`RCPT TO:<${stripAngles(message.to)}>`, [250, 251])
    await connection.data(serialize(message, config))
    await connection.command('QUIT', [221])
  } finally {
    connection.destroy()
  }
}

/** 把邮件序列化成 DATA 阶段要发的内容（已做 header 编码与点号处理）。 */
export function serialize(message: SmtpMessage, config: SmtpConfig): string {
  const headers = [
    `From: ${config.from}`,
    `To: ${message.to}`,
    config.replyTo ? `Reply-To: ${config.replyTo}` : undefined,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${message.date}`,
    `Message-ID: ${message.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ].filter((line): line is string => line !== undefined)

  // body 用 base64：既照顾 UTF-8，又天然避开 SMTP 的点号转义问题
  const body = Buffer.from(message.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')

  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`
}

/** 非 ASCII 的 header 值按 RFC 2047 编码。 */
export function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export function smtpMessageId(domain: string): string {
  return `<${randomBytes(12).toString('hex')}@${domain}>`
}

class SmtpConnection {
  private socket: Socket
  private buffer = ''
  /** 已经收到、但还没人读的整行。响应常常先到（问候语尤其如此），丢掉就再也读不到了。 */
  private pending: string[] = []
  private waiters: ((line: string) => void)[] = []
  private failure: Error | undefined
  private readonly timeoutMs: number

  private constructor(socket: Socket, timeoutMs: number) {
    this.socket = socket
    this.timeoutMs = timeoutMs

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.drain()
    })
    socket.on('error', (error: Error) => this.fail(error))
    socket.on('close', () => this.fail(new SmtpError('SMTP_CLOSED', 'SMTP 连接被对端关闭')))
  }

  static async open(config: SmtpConfig): Promise<SmtpConnection> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const onError = (error: Error): void => reject(error)
      const options = { host: config.host, port: config.port }
      const created = config.secure
        ? connectTls({ ...options, rejectUnauthorized: config.rejectUnauthorized }, () => resolve(created))
        : connectTcp(options, () => resolve(created))
      created.setTimeout(config.timeoutMs, () => {
        created.destroy()
        reject(new SmtpError('SMTP_TIMEOUT', `连接 ${config.host}:${config.port} 超时`))
      })
      created.once('error', onError)
    })

    const connection = new SmtpConnection(socket, config.timeoutMs)
    connection.socket.setTimeout(config.timeoutMs, () => {
      connection.fail(new SmtpError('SMTP_TIMEOUT', 'SMTP 命令超时'))
    })
    return connection
  }

  /** 读问候语、EHLO，必要时 STARTTLS，然后按需认证。 */
  async greet(config: SmtpConfig): Promise<void> {
    const greeting = await this.readResponse()
    if (greeting.code !== 220) {
      throw new SmtpError('SMTP_GREETING', `SMTP 问候异常：${greeting.code}`, undefined, greeting.text)
    }

    let ehlo = await this.command(`EHLO ${config.heloDomain}`, [250, 502])

    if (!config.secure && !config.allowPlaintext) {
      if (!ehlo.text.includes('STARTTLS')) {
        throw new SmtpError(
          'SMTP_STARTTLS_MISSING',
          '服务器不支持 STARTTLS：明文投递凭据不安全，已中止。确实要走明文，请显式配置 allowPlaintext: true',
          'EHLO',
          ehlo.text,
        )
      }
      await this.command('STARTTLS', [220])
      await this.upgradeToTls(config)
      ehlo = await this.command(`EHLO ${config.heloDomain}`, [250])
    }

    if (config.user !== undefined) {
      await this.authenticate(config, ehlo.text)
    }
  }

  /**
   * 认证。原则：**凭据绝不能出现在错误信息里**（会被写进日志），
   * 所以这里不上走 command()，而是自己发自己读，错误只回报状态码。
   */
  private async authenticate(config: SmtpConfig, capabilities: string): Promise<void> {
    const user = config.user ?? ''
    const pass = config.pass ?? ''

    if (/PLAIN/.test(capabilities)) {
      const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64')
      this.write(`AUTH PLAIN ${token}\r\n`)
      const response = await this.readResponse()
      if (response.code === 235) return
      // 504 / 500 = 服务器不认这个机制，可以退回 AUTH LOGIN；其余都是认证失败
      if (response.code !== 504 && response.code !== 500) {
        throw new SmtpError('SMTP_AUTH_FAILED', `SMTP 认证失败：服务器返回 ${response.code}`)
      }
    }

    this.write('AUTH LOGIN\r\n')
    const start = await this.readResponse()
    if (start.code !== 334) {
      throw new SmtpError('SMTP_AUTH_UNSUPPORTED', '服务器不支持 AUTH PLAIN 或 AUTH LOGIN')
    }

    this.write(`${Buffer.from(user, 'utf8').toString('base64')}\r\n`)
    const userStep = await this.readResponse()
    if (userStep.code !== 334) {
      throw new SmtpError('SMTP_AUTH_FAILED', `SMTP 认证失败：服务器返回 ${userStep.code}`)
    }

    this.write(`${Buffer.from(pass, 'utf8').toString('base64')}\r\n`)
    const done = await this.readResponse()
    if (done.code !== 235) {
      throw new SmtpError('SMTP_AUTH_FAILED', `SMTP 认证失败：服务器返回 ${done.code}`)
    }
  }

  private async upgradeToTls(config: SmtpConfig): Promise<void> {
    const plain = this.socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('error')
    plain.removeAllListeners('close')

    const secured = await new Promise<Socket>((resolve, reject) => {
      const tlsSocket = connectTls(
        { socket: plain, host: config.host, rejectUnauthorized: config.rejectUnauthorized },
        () => resolve(tlsSocket),
      )
      tlsSocket.once('error', reject)
    })

    this.socket = secured
    this.buffer = ''
    secured.setEncoding('utf8')
    secured.on('data', (chunk: string) => {
      this.buffer += chunk
      this.drain()
    })
    secured.on('error', (error: Error) => this.fail(error))
    secured.on('close', () => this.fail(new SmtpError('SMTP_CLOSED', 'SMTP 连接被对端关闭')))
    secured.setTimeout(this.timeoutMs, () => {
      this.fail(new SmtpError('SMTP_TIMEOUT', 'SMTP 命令超时'))
    })
  }

  async command(line: string, expect: number[]): Promise<{ code: number; text: string }> {
    this.write(`${line}\r\n`)
    const response = await this.readResponse()
    if (!expect.includes(response.code)) {
      throw new SmtpError('SMTP_UNEXPECTED', `SMTP ${line} 被拒绝：${response.code} ${response.text}`, line, response.text)
    }
    return response
  }

  async data(message: string): Promise<void> {
    this.write('DATA\r\n')
    const ready = await this.readResponse()
    if (ready.code !== 354) {
      throw new SmtpError('SMTP_DATA_REJECTED', `DATA 被拒绝：${ready.code}`, 'DATA', ready.text)
    }
    // 已做 base64，正文里不会出现需要转义的行首点号；只补结束行
    const terminator = message.endsWith('\r\n') ? `${message}.\r\n` : `${message}\r\n.\r\n`
    this.write(terminator)
    const done = await this.readResponse()
    if (done.code !== 250) {
      throw new SmtpError('SMTP_DATA_FAILED', `邮件未被接受：${done.code} ${done.text}`, 'DATA', done.text)
    }
  }

  destroy(): void {
    this.socket.removeAllListeners('close')
    this.socket.destroy()
  }

  private write(chunk: string): void {
    if (this.failure) throw this.failure
    this.socket.write(chunk)
  }

  private fail(error: Error): void {
    this.failure ??= error
    for (const waiter of this.waiters.splice(0)) {
      // 唤醒等待者，让它们看到 failure
      waiter('')
    }
  }

  private drain(): void {
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return

      const line = this.buffer.slice(0, index + 1)
      this.buffer = this.buffer.slice(index + 1)

      const waiter = this.waiters.shift()
      if (waiter) waiter(line)
      else this.pending.push(line)
    }
  }

  private async readLine(): Promise<string> {
    if (this.failure) throw this.failure

    const queued = this.pending.shift()
    if (queued !== undefined) return queued

    return new Promise<string>((resolve) => {
      this.waiters.push(resolve)
    }).then((line) => {
      if (this.failure) throw this.failure
      return line
    })
  }

  /** 读一个完整响应：多行响应以 `250-` 续行，最后一行是 `250 `。 */
  private async readResponse(): Promise<{ code: number; text: string }> {
    const lines: string[] = []
    for (;;) {
      const raw = await this.readLine()
      const line = raw.replace(/\r?\n$/, '')
      lines.push(line)
      const match = /^(\d{3})([ -]?)/.exec(line)
      if (!match) throw new SmtpError('SMTP_MALFORMED', `无法解析 SMTP 响应：${line}`)
      if (match[2] !== '-') {
        return { code: Number(match[1]), text: lines.join('\n') }
      }
    }
  }
}

function stripAngles(address: string): string {
  return address.replace(/^<|>$/g, '')
}
