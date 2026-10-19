#!/usr/bin/env node
/**
 * 测试用的假 gatewayd。
 *
 * 它不是 Go 实现的替身，只按同一套控制桥协议说话：
 * 4 字节大端长度 + JSON；连接后先发 hello；
 * 支持 status / listStrategies / replaceStrategies / preview / pick / shutdown。
 *
 * 用 `--mode=` 模拟故障：
 *   exit-before-ready | hang | crash-after-ready | reject-config | no-shutdown
 */
import net from 'node:net'

const options = {
  transport: 'tcp',
  socket: '',
  listen: '127.0.0.1:0',
  logFormat: 'text',
  mode: 'ok',
}

const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  const argument = argv[index]
  if (!argument.startsWith('--')) continue
  const body = argument.slice(2)
  const separator = body.indexOf('=')
  const key = separator === -1 ? body : body.slice(0, separator)
  const value = separator === -1 ? argv[++index] : body.slice(separator + 1)
  if (key === 'transport') options.transport = value
  else if (key === 'socket') options.socket = value
  else if (key === 'listen') options.listen = value
  else if (key === 'log-format') options.logFormat = value
  else if (key === 'mode') options.mode = value
}

if (options.mode === 'exit-before-ready') {
  process.exit(1)
}
if (options.mode === 'hang') {
  setInterval(() => {}, 1_000)
  // 故意不打印 ready，让监管方超时。
} else {
  run()
}

function run() {
  let revision = 0
  let strategies = []
  let defaultStrategy = 'default'
  let accounts = []
  let accountsRevision = 0

  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0)
    send(socket, {
      type: 'event',
      event: 'hello',
      data: {
        protocolVersion: 1,
        pid: process.pid,
        service: 'account-priority',
        mode: options.mode,
      },
    })

    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0)
        if (length === 0 || buffer.length < 4 + length) return
        const payload = buffer.subarray(4, 4 + length)
        buffer = buffer.subarray(4 + length)
        let request
        try {
          request = JSON.parse(payload.toString('utf8'))
        } catch {
          continue
        }
        handle(socket, request)
      }
    })
  })

  server.on('error', (error) => {
    process.stderr.write(`fake-gatewayd: ${error.message}\n`)
    process.exit(1)
  })

  const announce = (address) => {
    process.stdout.write(
      `${JSON.stringify({
        type: 'ready',
        transport: options.transport,
        address,
        pid: process.pid,
        protocolVersion: 1,
      })}\n`,
    )
    if (options.mode === 'crash-after-ready') {
      setTimeout(() => process.exit(2), 200).unref()
    }
  }

  if (options.transport === 'unix') {
    server.listen(options.socket, () => announce(options.socket))
  } else {
    const separator = options.listen.lastIndexOf(':')
    const host = options.listen.slice(0, separator) || '127.0.0.1'
    const port = Number(options.listen.slice(separator + 1))
    server.listen(port, host, () => {
      const address = server.address()
      announce(`127.0.0.1:${address.port}`)
    })
  }

  function handle(socket, request) {
    if (request.type !== 'request') {
      respondError(socket, request.id, 'BRIDGE_BAD_REQUEST', '只接受 request')
      return
    }
    switch (request.method) {
      case 'accountPriority.status':
        respond(socket, request.id, {
          ready: true,
          revision: `fake-${revision}`,
          defaultStrategy,
          strategies: Math.max(1, strategies.length),
          startedAt: new Date().toISOString(),
          scored: 0,
          picked: 0,
          candidatesMax: 10_000,
          accounts: accounts.length,
        })
        return

      case 'accountPriority.listStrategies':
        respond(socket, request.id, {
          revision: `fake-${revision}`,
          defaultStrategy,
          strategies,
        })
        return

      case 'accountPriority.replaceStrategies': {
        if (options.mode === 'reject-config') {
          respondError(
            socket,
            request.id,
            'ACCOUNT_PRIORITY_INVALID_CONFIG',
            'fake gatewayd 拒绝配置',
          )
          return
        }
        const params = request.params ?? {}
        strategies = Array.isArray(params.strategies) ? params.strategies : []
        defaultStrategy = params.defaultStrategy ?? strategies[0]?.id ?? 'default'
        revision += 1
        respond(socket, request.id, {
          revision: `fake-${revision}`,
          strategies: strategies.length,
          defaultStrategy,
        })
        return
      }

      case 'accounts.replace': {
        const params = request.params ?? {}
        accounts = Array.isArray(params.accounts) ? params.accounts : []
        accountsRevision += 1
        respond(socket, request.id, {
          revision: `fake-accounts-${accountsRevision}`,
          accounts: accounts.length,
          updatedAt: new Date().toISOString(),
        })
        return
      }

      case 'accounts.status':
        respond(socket, request.id, {
          ready: true,
          revision: `fake-accounts-${accountsRevision}`,
          generation: '',
          accounts: accounts.length,
          updatedAt: new Date().toISOString(),
        })
        return

      case 'accountPriority.preview': {
        const params = request.params ?? {}
        const candidates = Array.isArray(params.candidates) ? params.candidates : []
        const ranked = candidates.map((candidate, index) => ({
          accountId: candidate.accountId,
          score: 100 - index,
          breakdown: [
            { name: 'fake', raw: 1, normalized: 1, weight: 1, contribution: 1 },
          ],
        }))
        respond(socket, request.id, {
          strategy: params.strategy ?? defaultStrategy,
          revision: `fake-${revision}`,
          evaluatedAt: new Date().toISOString(),
          ranked,
          excluded: [],
        })
        return
      }

      case 'accountPriority.pick': {
        const params = request.params ?? {}
        const candidates = Array.isArray(params.candidates) ? params.candidates : []
        if (candidates.length === 0) {
          respondError(
            socket,
            request.id,
            'ACCOUNT_PRIORITY_NO_ELIGIBLE_ACCOUNT',
            '没有可用账号',
          )
          return
        }
        respond(socket, request.id, {
          accountId: candidates[0].accountId,
          score: 100,
          breakdown: [],
        })
        return
      }

      case 'shutdown':
        respond(socket, request.id, { ok: true })
        if (options.mode !== 'no-shutdown') {
          setTimeout(() => {
            server.close()
            process.exit(0)
          }, 20)
        }
        return

      default:
        respondError(socket, request.id, 'BRIDGE_METHOD_NOT_FOUND', `未知方法 ${request.method}`)
    }
  }

  function respond(socket, id, result) {
    send(socket, { id: id ?? '', type: 'response', ok: true, result })
  }

  function respondError(socket, id, code, message) {
    send(socket, {
      id: id ?? '',
      type: 'response',
      ok: false,
      error: { code, message },
    })
  }

  function send(socket, message) {
    const payload = Buffer.from(JSON.stringify(message), 'utf8')
    const frame = Buffer.allocUnsafe(4 + payload.length)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    socket.write(frame)
  }
}
