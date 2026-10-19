/**
 * gatewayd 子进程监管。
 *
 * 只做一件事：把 Go 进程拉起来、读到 ready 行、连上控制桥、优雅停止。
 * 重启策略在 AccountPriorityService 里（它还要重新推送策略）。
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import type { Readable } from 'node:stream'
import { BridgeClient } from './bridge.ts'
import { AccountPriorityError } from './errors.ts'

export interface GatewayReadyInfo {
  readonly transport: 'unix' | 'tcp'
  readonly address: string
  readonly pid: number
  readonly protocolVersion: number
}

export interface GatewayProcessOptions {
  readonly executable: string
  readonly args: readonly string[]
  readonly transport: 'unix' | 'tcp'
  readonly socketPath: string
  readonly startTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly logFormat: 'text' | 'json'
  readonly onLog?: (stream: 'stdout' | 'stderr', line: string) => void
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null, error: Error | null) => void
}

export interface StartedGateway {
  readonly bridge: BridgeClient
  readonly ready: GatewayReadyInfo
  readonly pid: number | null
}

const STDERR_TAIL_LINES = 20
const KILL_GRACE_MS = 1_000

export class GatewayProcess {
  private readonly options: GatewayProcessOptions
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null
  private bridge: BridgeClient | null = null
  private stdoutReader: Interface | null = null
  private stderrReader: Interface | null = null
  private stderrTail: string[] = []
  private stopping = false
  private exited = false
  private started = false
  private exitWaiters = new Set<() => void>()

  constructor(options: GatewayProcessOptions) {
    this.options = options
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  async start(): Promise<StartedGateway> {
    if (this.child !== null) {
      throw new AccountPriorityError('ACCOUNT_PRIORITY_START_FAILED', 'gatewayd 已经在运行')
    }
    this.stopping = false
    this.exited = false
    this.started = false
    this.stderrTail = []

    const args = buildArgs(this.options)
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(this.options.executable, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw mapSpawnError(error)
    }
    this.child = child

    child.once('exit', (code, signal) => {
      this.exited = true
      for (const waiter of this.exitWaiters) waiter()
      this.exitWaiters.clear()
      this.closeReaders()
      if (!this.stopping && this.started) {
        this.options.onExit?.(code, signal, null)
      }
    })
    child.once('error', (error) => {
      if (!this.stopping && this.started) {
        this.options.onExit?.(null, null, error)
      }
    })

    this.stdoutReader = createInterface({ input: child.stdout })
    this.stderrReader = createInterface({ input: child.stderr })
    this.stderrReader.on('line', (line) => {
      this.stderrTail.push(line)
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift()
      this.options.onLog?.('stderr', line)
    })

    const ready = await this.waitForReady(child)

    let bridge: BridgeClient
    try {
      bridge = new BridgeClient({
        transport: ready.transport,
        address: ready.address,
        timeoutMs: this.options.startTimeoutMs,
        onEvent: (event) => {
          if (event.event === 'hello') return
          this.options.onLog?.('stdout', `event ${event.event}`)
        },
        onClose: (error) => {
          if (this.stopping || this.exited) return
          this.options.onLog?.(
            'stderr',
            `控制桥断开：${error?.message ?? '未知原因'}；重启 gatewayd`,
          )
          this.killChild()
        },
      })
      await bridge.connect()
    } catch (error) {
      this.stopping = true
      await this.stop(1_000).catch(() => undefined)
      throw new AccountPriorityError(
        'ACCOUNT_PRIORITY_START_FAILED',
        `gatewayd 已启动但控制桥握手失败：${describeError(error)}`,
      )
    }

    this.stopping = false
    this.started = true
    this.bridge = bridge
    return { bridge, ready, pid: child.pid ?? null }
  }

  async stop(timeoutMs: number): Promise<void> {
    this.stopping = true
    const bridge = this.bridge
    this.bridge = null
    if (bridge !== null) {
      try {
        await bridge.request('shutdown', {}, Math.min(1_000, timeoutMs))
      } catch {
        // 桥可能已经不在了；下面的退出等待/强杀仍然有效。
      }
      bridge.close()
    }

    const child = this.child
    if (child === null) {
      this.closeReaders()
      return
    }

    if (!(await this.waitForExit(timeoutMs))) {
      child.kill('SIGTERM')
      if (!(await this.waitForExit(KILL_GRACE_MS))) {
        child.kill('SIGKILL')
      }
    }

    this.child = null
    this.bridge = null
    this.closeReaders()
  }

  private waitForReady(
    child: ChildProcessByStdio<null, Readable, Readable>,
  ): Promise<GatewayReadyInfo> {
    return new Promise<GatewayReadyInfo>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        callback()
      }
      const timer = setTimeout(() => {
        finish(() => {
          reject(
            new AccountPriorityError(
              'ACCOUNT_PRIORITY_START_TIMEOUT',
              `等待 gatewayd ready 超时（${this.options.startTimeoutMs}ms）${this.tail()}`,
            ),
          )
        })
      }, this.options.startTimeoutMs)
      timer.unref?.()

      this.stdoutReader?.on('line', (line) => {
        let parsed: GatewayReadyInfo | null
        try {
          parsed = parseReadyLine(line)
        } catch (error) {
          finish(() => {
            reject(
              new AccountPriorityError(
                'ACCOUNT_PRIORITY_START_FAILED',
                `gatewayd ready 行不合法：${describeError(error)}`,
              ),
            )
          })
          return
        }
        if (parsed !== null) {
          finish(() => resolve(parsed))
          return
        }
        this.options.onLog?.('stdout', line)
      })
      child.once('exit', (code, signal) => {
        finish(() => {
          reject(
            new AccountPriorityError(
              'ACCOUNT_PRIORITY_CHILD_EXITED',
              `gatewayd 在 ready 之前退出（code=${String(code)}, signal=${String(signal)}）${this.tail()}`,
            ),
          )
        })
      })
      child.once('error', (error) => {
        finish(() => reject(mapSpawnError(error)))
      })
    })
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const cleanup = (): void => {
        clearTimeout(timer)
        this.exitWaiters.delete(onExit)
      }
      const onExit = (): void => {
        if (done) return
        done = true
        cleanup()
        resolve(true)
      }
      const timer = setTimeout(() => {
        if (done) return
        done = true
        cleanup()
        resolve(false)
      }, timeoutMs)
      timer.unref?.()
      this.exitWaiters.add(onExit)
    })
  }

  private killChild(): void {
    const child = this.child
    if (child === null || this.exited) return
    child.kill('SIGTERM')
  }

  private closeReaders(): void {
    this.stdoutReader?.close()
    this.stderrReader?.close()
    this.stdoutReader = null
    this.stderrReader = null
  }

  private tail(): string {
    if (this.stderrTail.length === 0) return ''
    return `\n最近 stderr：\n${this.stderrTail.join('\n')}`
  }
}

function buildArgs(options: GatewayProcessOptions): string[] {
  const args = [...options.args]
  args.push(`--transport=${options.transport}`)
  if (options.transport === 'unix') {
    args.push(`--socket=${options.socketPath}`)
  } else {
    args.push('--listen=127.0.0.1:0')
  }
  args.push(`--log-format=${options.logFormat}`)
  return args
}

function parseReadyLine(line: string): GatewayReadyInfo | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.type !== 'ready') return null
  if (record.transport !== 'unix' && record.transport !== 'tcp') {
    throw new Error(`transport 不合法：${String(record.transport)}`)
  }
  if (typeof record.address !== 'string' || record.address === '') {
    throw new Error('address 缺失')
  }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid)) {
    throw new Error('pid 缺失')
  }
  if (typeof record.protocolVersion !== 'number') {
    throw new Error('protocolVersion 缺失')
  }
  return {
    transport: record.transport,
    address: record.address,
    pid: record.pid,
    protocolVersion: record.protocolVersion,
  }
}

function mapSpawnError(error: unknown): AccountPriorityError {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') {
    return new AccountPriorityError(
      'ACCOUNT_PRIORITY_BINARY_MISSING',
      `找不到 gatewayd 可执行文件：${describeError(error)}（先运行 pnpm build:go）`,
    )
  }
  return new AccountPriorityError(
    'ACCOUNT_PRIORITY_START_FAILED',
    `启动 gatewayd 失败：${describeError(error)}`,
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
