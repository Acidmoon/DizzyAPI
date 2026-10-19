/**
 * 控制桥客户端。
 *
 * 帧格式与服务端一致：4 字节大端长度 + UTF-8 JSON。
 * 这里只做控制消息；LLM 请求永远不过桥（AGENTS.md D3 / §2.3）。
 */
import { connect, type Socket } from 'node:net'
import { AccountPriorityError } from './errors.ts'

export const BRIDGE_PROTOCOL_VERSION = 1
export const BRIDGE_MAX_FRAME_BYTES = 16 << 20

export interface BridgeNotification {
  readonly event: string
  readonly data?: unknown
}

export interface BridgeClientOptions {
  readonly transport: 'unix' | 'tcp'
  readonly address: string
  readonly timeoutMs: number
  readonly onEvent?: (event: BridgeNotification) => void
  readonly onClose?: (error: AccountPriorityError | null) => void
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

interface HelloWaiter {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

export class BridgeClient {
  private readonly options: BridgeClientOptions
  private socket: Socket | undefined
  private buffer: Buffer = Buffer.alloc(0)
  private pending = new Map<string, PendingRequest>()
  private nextId = 1
  private connected = false
  private closed = false
  private helloData: unknown = undefined
  private helloReceived = false
  private helloWaiter: HelloWaiter | undefined

  constructor(options: BridgeClientOptions) {
    this.options = options
  }

  /** 连接并等待 hello 握手；返回 hello 数据。 */
  async connect(): Promise<unknown> {
    if (this.closed) {
      throw new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE', '控制桥已关闭')
    }

    const socket = this.createSocket()
    this.socket = socket
    socket.on('data', (chunk: Buffer) => this.handleData(chunk))
    socket.on('error', (error) => {
      this.fail(
        new AccountPriorityError(
          'ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE',
          `控制桥连接失败：${error.message}`,
        ),
      )
    })
    socket.on('close', () => {
      if (!this.closed) {
        this.fail(
          new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE', '控制桥连接已断开'),
        )
      }
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AccountPriorityError(
            'ACCOUNT_PRIORITY_BRIDGE_TIMEOUT',
            `连接控制桥超时（${this.options.timeoutMs}ms）`,
          ),
        )
      }, this.options.timeoutMs)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(
          new AccountPriorityError(
            'ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE',
            `连接控制桥失败：${error.message}`,
          ),
        )
      })
    })

    const hello = await this.waitForHello()
    const version = (hello as { protocolVersion?: unknown } | null | undefined)?.protocolVersion
    if (version !== BRIDGE_PROTOCOL_VERSION) {
      this.close()
      throw new AccountPriorityError(
        'ACCOUNT_PRIORITY_BRIDGE_PROTOCOL',
        `控制桥协议版本不匹配：期望 ${BRIDGE_PROTOCOL_VERSION}，收到 ${String(version)}`,
      )
    }

    this.connected = true
    return hello
  }

  /** 发一条控制请求；失败时抛稳定错误码。 */
  request<T>(method: string, params?: unknown, timeoutMs = this.options.timeoutMs): Promise<T> {
    if (this.closed || !this.connected || this.socket === undefined) {
      return Promise.reject(
        new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE', '控制桥尚未连接'),
      )
    }

    const id = String(this.nextId)
    this.nextId += 1
    const payload = Buffer.from(
      JSON.stringify({
        id,
        type: 'request',
        method,
        ...(params === undefined ? {} : { params }),
      }),
      'utf8',
    )
    if (payload.length > BRIDGE_MAX_FRAME_BYTES) {
      return Promise.reject(
        new AccountPriorityError('ACCOUNT_PRIORITY_REQUEST_FAILED', '请求帧超过大小上限'),
      )
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new AccountPriorityError(
            'ACCOUNT_PRIORITY_BRIDGE_TIMEOUT',
            `控制桥请求超时：${method}（${timeoutMs}ms）`,
          ),
        )
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })

      const frame = Buffer.allocUnsafe(4 + payload.length)
      frame.writeUInt32BE(payload.length, 0)
      payload.copy(frame, 4)
      this.socket?.write(frame, (error) => {
        if (error === null || error === undefined) return
        const pending = this.pending.get(id)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(
          new AccountPriorityError(
            'ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE',
            `控制桥写入失败：${error.message}`,
          ),
        )
      })
    })
  }

  /** 主动关闭；不会再触发 onClose 的「意外断开」回调。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.rejectAll(
      new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE', '控制桥已关闭'),
    )
    this.rejectHello(
      new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE', '控制桥已关闭'),
    )
    this.socket?.destroy()
    this.socket = undefined
  }

  private createSocket(): Socket {
    if (this.options.transport === 'unix') {
      return connect({ path: this.options.address })
    }
    const parsed = parseTcpAddress(this.options.address)
    return connect({ host: parsed.host, port: parsed.port })
  }

  private waitForHello(): Promise<unknown> {
    if (this.helloReceived) return Promise.resolve(this.helloData)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloWaiter = undefined
        reject(
          new AccountPriorityError(
            'ACCOUNT_PRIORITY_BRIDGE_TIMEOUT',
            `等待控制桥 hello 超时（${this.options.timeoutMs}ms）`,
          ),
        )
      }, this.options.timeoutMs)
      timer.unref?.()
      this.helloWaiter = { resolve, reject, timer }
    })
  }

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length === 0 || length > BRIDGE_MAX_FRAME_BYTES) {
        this.fail(
          new AccountPriorityError(
            'ACCOUNT_PRIORITY_BRIDGE_PROTOCOL',
            `控制桥帧长度非法：${length}`,
          ),
        )
        return
      }
      if (this.buffer.length < 4 + length) return
      const payload = this.buffer.subarray(4, 4 + length)
      this.buffer = this.buffer.subarray(4 + length)
      this.dispatch(payload)
      if (this.closed) return
    }
  }

  private dispatch(payload: Buffer): void {
    let message: unknown
    try {
      message = JSON.parse(payload.toString('utf8'))
    } catch (error) {
      this.fail(
        new AccountPriorityError(
          'ACCOUNT_PRIORITY_BRIDGE_PROTOCOL',
          `控制桥返回了坏 JSON：${error instanceof Error ? error.message : String(error)}`,
        ),
      )
      return
    }

    if (typeof message !== 'object' || message === null) {
      this.fail(new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_PROTOCOL', '控制桥返回了非对象消息'))
      return
    }
    const record = message as Record<string, unknown>

    if (record.type === 'event') {
      const event = typeof record.event === 'string' ? record.event : ''
      if (event === 'hello') {
        this.helloReceived = true
        this.helloData = record.data
        const waiter = this.helloWaiter
        if (waiter !== undefined) {
          clearTimeout(waiter.timer)
          this.helloWaiter = undefined
          waiter.resolve(record.data)
        }
      }
      this.options.onEvent?.({ event, data: record.data })
      return
    }

    if (record.type !== 'response' || typeof record.id !== 'string') {
      this.fail(
        new AccountPriorityError('ACCOUNT_PRIORITY_BRIDGE_PROTOCOL', '控制桥返回的消息类型不合法'),
      )
      return
    }

    const pending = this.pending.get(record.id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(record.id)

    if (record.ok === true) {
      pending.resolve(record.result)
      return
    }
    const errorBody =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {}
    const code = typeof errorBody.code === 'string' ? errorBody.code : 'BRIDGE_INTERNAL'
    const detail = typeof errorBody.message === 'string' ? errorBody.message : '未知错误'
    pending.reject(
      new AccountPriorityError('ACCOUNT_PRIORITY_REQUEST_FAILED', `${code}: ${detail}`, {
        remoteCode: code,
      }),
    )
  }

  private fail(error: AccountPriorityError): void {
    if (this.closed) return
    this.closed = true
    this.rejectAll(error)
    this.rejectHello(error)
    this.socket?.destroy()
    this.socket = undefined
    this.options.onClose?.(error)
  }

  private rejectHello(error: Error): void {
    const waiter = this.helloWaiter
    if (waiter === undefined) return
    clearTimeout(waiter.timer)
    this.helloWaiter = undefined
    waiter.reject(error)
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function parseTcpAddress(address: string): { host: string; port: number } {
  const separator = address.lastIndexOf(':')
  if (separator <= 0) {
    throw new AccountPriorityError(
      'ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE',
      `控制桥 TCP 地址不合法：${address}`,
    )
  }
  let host = address.slice(0, separator)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const port = Number(address.slice(separator + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new AccountPriorityError(
      'ACCOUNT_PRIORITY_BRIDGE_UNAVAILABLE',
      `控制桥 TCP 端口不合法：${address}`,
    )
  }
  return { host, port }
}
