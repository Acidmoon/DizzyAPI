import { createServer, type Server } from 'node:net'

/**
 * 本机假 SMTP 服务器：把收到的命令逐条记下来，供测试断言客户端说了什么。
 * 它只实现被测到的那几条命令，**不是**真服务器：不实现 TLS。
 */
export interface FakeSmtp {
  readonly port: number
  readonly commands: string[]
  readonly body: readonly string[]
  close(): Promise<void>
}

export async function startFakeSmtp(
  options: { advertiseStartTls?: boolean; authReply?: string } = {},
): Promise<FakeSmtp> {
  const commands: string[] = []
  const body: string[] = []

  const server: Server = createServer((socket) => {
    let buffer = ''
    let inData = false
    socket.setEncoding('utf8')
    socket.write('220 fake.local ESMTP ready\r\n')

    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\r\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)

        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 2.0.0 queued\r\n')
          } else {
            body.push(line)
          }
        } else {
          commands.push(line)
          const verb = line.split(' ')[0]!.toUpperCase()
          if (verb === 'EHLO') {
            const lines = ['250-fake.local greets you']
            if (options.advertiseStartTls ?? true) lines.push('250-STARTTLS')
            lines.push('250-AUTH PLAIN LOGIN')
            lines.push('250 SIZE 10485760')
            socket.write(`${lines.join('\r\n')}\r\n`)
          } else if (verb === 'AUTH') {
            socket.write(`${options.authReply ?? '235 2.7.0 accepted'}\r\n`)
          } else if (verb === 'DATA') {
            inData = true
            socket.write('354 go ahead\r\n')
          } else if (verb === 'QUIT') {
            socket.write('221 bye\r\n')
            socket.end()
          } else {
            socket.write('250 2.0.0 OK\r\n')
          }
        }

        index = buffer.indexOf('\r\n')
      }
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('假服务器没有拿到端口')

  return {
    port: address.port,
    commands,
    body,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * DATA 阶段收到的是「头 + 空行 + 正文」，这里只还原正文。
 * 正文是 base64，去掉折行再解码。
 */
export function decodeBody(lines: readonly string[]): string {
  const text = lines.join('\r\n')
  const separator = text.indexOf('\r\n\r\n')
  const body = separator >= 0 ? text.slice(separator + 4) : text
  return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')
}

/** DATA 阶段收到的头部（含末尾那个空行之前的部分）。 */
export function headersOf(lines: readonly string[]): string {
  const text = lines.join('\r\n')
  const separator = text.indexOf('\r\n\r\n')
  return separator >= 0 ? text.slice(0, separator) : text
}
