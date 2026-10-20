/**
 * 账号请求优先级管理插件（服务名 `accountPriority`）。
 *
 * 分工：
 *   - **Go（gatewayd / modules/accountpriority）** 在 LLM 请求链路里并发打分、排序、选中账号；
 *   - **本插件** 只做管理面：持有策略组（唯一写者）、拉起并监管 gatewayd、
 *     把策略推给 Go、提供预览/选择查询。
 *
 * 本插件不在请求热路径上：`preview` / `pick` 是管理面查询，不是 LLM 请求转发；
 * 真正的链路调用发生在 Go 进程内部（D1 / §2.3）。
 */
import { existsSync, unlinkSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, Service, type Context, type Logger } from 'cordis'
import {
  describeError,
  isIssueList,
  type JsonStore,
} from '@dizzyapi/plugin-kit'
import {
  ACCOUNT_PRIORITY_CONFIG_SCHEMA,
  validateAccountPriorityConfig,
  type AccountPriorityConfig,
  type ResolvedAccountPriorityConfig,
} from './config.ts'
import { AccountPriorityError, isAccountPriorityError } from './errors.ts'
import {
  createAccountPriorityStore,
  SNAPSHOT_VERSION,
  type AccountPrioritySnapshot,
} from './store.ts'
import { GatewayProcess } from './supervisor.ts'
import type { BridgeClient } from './bridge.ts'
import { DEFAULT_STRATEGY } from './types.ts'
import type {
  AccountPriorityStatus,
  ChildState,
  GatewayAccount,
  GatewayAccountSnapshot,
  GatewayAccountsResult,
  GatewayKeySnapshot,
  GatewayKeysResult,
  RemoteStatus,
  ReplaceStrategiesResult,
  ScoreRequest,
  ScoreResult,
  ScoredAccount,
  StrategyGroup,
  StrategyListSnapshot,
} from './types.ts'
import {
  MAX_STRATEGIES,
  validateScoreRequest,
  validateStrategyCollection,
  validateStrategyGroup,
} from './validate.ts'

/**
 * identity 的结构性视图：只声明本插件用到的两个方法，不 import 它的实现。
 * 令牌只进内存快照，随后经控制桥推给 Go；本插件不落盘、不记录、不回显。
 */
interface IdentitySeam {
  list(): readonly {
    readonly id: string
    readonly provider: string
    readonly kind: string
    readonly enabled: boolean
    readonly status: string
    readonly baseUrl: string | null
    readonly protocol?: string | null
    readonly models?: readonly string[] | null
    readonly modelMap?: Readonly<Record<string, string>> | null
    readonly priority: number
    readonly accessExpiresAt: string | null
  }[]
  getAccessToken(id: string): Promise<string>
}

/**
 * api-key 的结构性视图：只声明快照方法，不 import 它的实现。
 * 快照里只有哈希；本插件只负责转发，不落盘、不记录、不回显。
 */
interface ApiKeySeam {
  snapshot(): Promise<GatewayKeySnapshot>
}

interface EventRoot {
  on(
    name: string,
    listener: (...args: unknown[]) => void,
    options?: { global?: boolean },
  ): () => void
}

const ACCOUNTS_PUSH_DEBOUNCE_MS = 100
const KEYS_PUSH_DEBOUNCE_MS = 100

export class AccountPriorityService extends Service {
  static Config = ACCOUNT_PRIORITY_CONFIG_SCHEMA

  /**
   * 能力清单：策略写入 + 进程监管，经控制桥向 Go 发查询。
   * 桥命令在这里是 **outbound**（本插件发给 Go），不是 LLM 请求路径（D3）。
   */
  static catalog = {
    capabilities: ['account-selection', 'strategy-management', 'gateway-supervision'],
    events: [
      {
        name: 'account-priority/child-state',
        description: 'gatewayd 监管状态变化',
        payload: 'state: ChildState, detail: string | null',
      },
      {
        name: 'account-priority/strategies-updated',
        description: '策略组被写入或删除',
        payload: "id: string, action: 'upsert' | 'remove'",
      },
      {
        name: 'account-priority/applied',
        description: 'Go 侧确认应用了一版策略',
        payload: 'revision: string',
      },
      {
        name: 'account-priority/error',
        description: '子进程、桥或策略推送失败',
        payload: 'code: string, message: string',
      },
      {
        name: 'account-priority/accounts-applied',
        description: 'Go 侧确认缓存了一版账号/令牌快照（不含秘密）',
        payload: 'revision: string, accounts: number',
      },
    ],
    bridge: [
      { method: 'accountPriority.status', direction: 'outbound', responseShape: 'RemoteStatus' },
      { method: 'accountPriority.listStrategies', direction: 'outbound', responseShape: 'StrategyListResult' },
      { method: 'accountPriority.replaceStrategies', direction: 'outbound', responseShape: 'ReplaceStrategiesResult' },
      { method: 'accountPriority.preview', direction: 'outbound', requestShape: 'ScoreRequest', responseShape: 'ScoreResult' },
      { method: 'accountPriority.pick', direction: 'outbound', requestShape: 'ScoreRequest', responseShape: 'ScoredAccount' },
      { method: 'accounts.replace', direction: 'outbound', requestShape: 'GatewayAccountSnapshot', responseShape: 'GatewayAccountsResult' },
      { method: 'accounts.status', direction: 'outbound', responseShape: 'accounts.State' },
      { method: 'keys.replace', direction: 'outbound', requestShape: 'GatewayKeySnapshot', responseShape: 'GatewayKeysResult' },
    ],
    storage: [
      { key: 'dataPath', kind: 'file', description: '策略组 JSON（TS 是唯一写者）' },
      { key: 'socketPath', kind: 'socket', description: '控制桥 Unix socket（Windows 用回环 TCP）' },
    ],
  } as const

  readonly config: ResolvedAccountPriorityConfig
  private readonly store: JsonStore<AccountPrioritySnapshot>
  private readonly logger: Logger

  private strategies = new Map<string, StrategyGroup>()
  private defaultStrategy: string | null = null
  private ready = false
  private queue: Promise<unknown> = Promise.resolve()

  private gateway: GatewayProcess | undefined
  private bridge: BridgeClient | undefined
  private state: ChildState = 'stopped'
  private pid: number | null = null
  private activeTransport: 'unix' | 'tcp' | null = null
  private address: string | null = null
  private revision: string | null = null
  private accountsCount = 0
  private accountsRevision: string | null = null
  private keysCount = 0
  private keysRevision: string | null = null
  /** 是否曾经见过 active 的 apiKey 服务（用于区分「启动时就禁用」与「运行期被卸载」）。 */
  private keysServiceSeen = false
  /** apiKey 服务消失后，是否需要推一份空快照把 Go 的旧 key 撤销掉（D5）。 */
  private keysRevokePending = false
  /** 最近一次成功推送的 snapshot generation；撤销时用 last + 1，避免回退。 */
  private lastKeysGeneration: number | null = null
  private startedAt: string | null = null
  private lastError: string | null = null
  private restarts = 0
  private launches = 0
  private restartDelay: number
  private restartTimer: NodeJS.Timeout | undefined
  private accountsTimer: NodeJS.Timeout | undefined
  private accountsQueue: Promise<unknown> = Promise.resolve()
  private keysTimer: NodeJS.Timeout | undefined
  private keysQueue: Promise<unknown> = Promise.resolve()
  private stopping = false
  private disposing = false

  constructor(ctx: Context, config: AccountPriorityConfig | ResolvedAccountPriorityConfig = {}) {
    super(ctx, 'accountPriority')
    this.config = resolveConfig(config)
    this.store = createAccountPriorityStore(resolveLocalPath(ctx, this.config.dataPath))
    this.logger = ctx.logger('account-priority')
    this.restartDelay = this.config.restartDelayMs
  }

  async *[Service.init](): AsyncGenerator<() => Promise<void>> {
    await this.load()
    this.ready = true
    this.logger.info(
      `账号优先级插件已装载：策略 ${this.strategies.size} 个；` +
        `gatewayd ${this.config.binaryPath}；自动启动 ${this.config.autoStart ? '开' : '关'}`,
    )

    if (this.config.autoStart) {
      try {
        await this.launch()
      } catch (error) {
        // 不把整个 cordis 树拖垮：状态、日志与事件都已经记录，可以稍后 restart。
        this.logger.error(`gatewayd 自动启动失败：${describeError(error)}`)
      }
    }

    const stopAccountsWatch = this.watchAccounts()
    const stopKeysWatch = this.watchKeys()
    yield async () => {
      this.disposing = true
      stopAccountsWatch()
      stopKeysWatch()
      this.clearRestartTimer()
      this.clearAccountsTimer()
      this.clearKeysTimer()
      try {
        await this.exclusive(async () => {
          await this.stopProcess()
        })
      } catch (error) {
        this.logger.warn(`卸载时停止 gatewayd 失败：${describeError(error)}`)
      }
      if (this.activeTransport === 'unix') {
        const socketPath = this.socketPath()
        try {
          unlinkSync(socketPath)
        } catch {
          // 文件可能已被 Go 侧删除。
        }
      }
    }
  }

  // ───────────────────────────────── 读

  /** 监管状态：进程、桥、已应用的 revision。 */
  status(): AccountPriorityStatus {
    return {
      state: this.state,
      pid: this.pid,
      transport: this.activeTransport,
      address: this.address,
      bridgeConnected: this.bridge !== undefined,
      revision: this.revision,
      defaultStrategy: this.defaultStrategy,
      strategies: this.strategies.size,
      accounts: this.accountsCount,
      accountsRevision: this.accountsRevision,
      keys: this.keysCount,
      keysRevision: this.keysRevision,
      restarts: this.restarts,
      lastError: this.lastError,
      startedAt: this.startedAt,
    }
  }

  /** 策略组的权威副本（TS 是唯一写者）。 */
  listStrategies(): StrategyListSnapshot {
    this.assertReady()
    return {
      revision: this.revision,
      defaultStrategy: this.defaultStrategy,
      strategies: [...this.strategies.values()].map((strategy) => structuredClone(strategy)),
    }
  }

  getStrategy(id: string): StrategyGroup | undefined {
    this.assertReady()
    const strategy = this.strategies.get(id)
    return strategy === undefined ? undefined : structuredClone(strategy)
  }

  // ───────────────────────────────── 写（策略组）

  async upsertStrategy(input: StrategyGroup): Promise<StrategyGroup> {
    this.assertReady()
    const strategy = validateStrategyGroup(input)
    return this.exclusive(async () => {
      const next = new Map(this.strategies)
      if (!next.has(strategy.id) && next.size >= MAX_STRATEGIES) {
        throw new AccountPriorityError(
          'ACCOUNT_PRIORITY_STRATEGY_INVALID',
          `策略组最多 ${MAX_STRATEGIES} 个`,
        )
      }
      next.set(strategy.id, strategy)

      const preferred = this.defaultStrategy === strategy.id ? strategy.id : this.defaultStrategy
      const chosenDefault = chooseDefault(next, preferred)
      const validated = validateStrategyCollection([...next.values()], chosenDefault)
      await this.commit(next, validated.defaultStrategy)

      this.ctx.emit('account-priority/strategies-updated', strategy.id, 'upsert')
      await this.apply()
      return structuredClone(strategy)
    })
  }

  async removeStrategy(id: string): Promise<void> {
    this.assertReady()
    return this.exclusive(async () => {
      if (!this.strategies.has(id)) {
        throw new AccountPriorityError(
          'ACCOUNT_PRIORITY_STRATEGY_NOT_FOUND',
          `策略组不存在：${id}`,
        )
      }
      const next = new Map(this.strategies)
      next.delete(id)
      if (next.size === 0) {
        throw new AccountPriorityError(
          'ACCOUNT_PRIORITY_STRATEGY_INVALID',
          '至少要保留一个策略组',
        )
      }
      const preferred = this.defaultStrategy === id ? null : this.defaultStrategy
      const chosenDefault = chooseDefault(next, preferred)
      const validated = validateStrategyCollection([...next.values()], chosenDefault)
      await this.commit(next, validated.defaultStrategy)

      this.ctx.emit('account-priority/strategies-updated', id, 'remove')
      await this.apply()
    })
  }

  // ───────────────────────────────── 子进程生命周期

  /** 显式启动 gatewayd（autoStart=false 或启动失败后使用）。 */
  async start(): Promise<AccountPriorityStatus> {
    this.assertReady()
    return this.exclusive(async () => {
      this.stopping = false
      await this.launch()
      return this.status()
    })
  }

  /** 优雅停止 gatewayd；策略组仍保留在内存与磁盘里。 */
  async stop(): Promise<AccountPriorityStatus> {
    return this.exclusive(async () => {
      await this.stopProcess()
      return this.status()
    })
  }

  /** 停止再启动，并在就绪后重新推送当前策略。 */
  async restart(): Promise<AccountPriorityStatus> {
    this.assertReady()
    return this.exclusive(async () => {
      await this.stopProcess()
      this.stopping = false
      await this.launch()
      return this.status()
    })
  }

  /** 把当前策略、账号快照与 API key 快照再推一次；桥断线恢复后也可以手动调用。 */
  async sync(): Promise<void> {
    await this.exclusive(async () => {
      await this.apply()
      await this.pushAccounts()
      await this.pushKeys()
    })
  }

  // ───────────────────────────────── 管理面查询（经桥）

  /** 预览排序与可解释明细。 */
  async preview(request: ScoreRequest): Promise<ScoreResult> {
    const parsed = validateScoreRequest(request)
    return this.requireBridge().request<ScoreResult>(
      'accountPriority.preview',
      parsed,
      this.config.requestTimeoutMs,
    )
  }

  /** 按策略选中一个账号。 */
  async pick(request: ScoreRequest): Promise<ScoredAccount> {
    const parsed = validateScoreRequest(request)
    return this.requireBridge().request<ScoredAccount>(
      'accountPriority.pick',
      parsed,
      this.config.requestTimeoutMs,
    )
  }

  /** Go 模块自己的运行期计数（与 status() 的监管状态不同）。 */
  async remoteStatus(): Promise<RemoteStatus> {
    return this.requireBridge().request<RemoteStatus>(
      'accountPriority.status',
      {},
      this.config.requestTimeoutMs,
    )
  }

  // ───────────────────────────────── 内部：加载与持久化

  private async load(): Promise<void> {
    let snapshot: AccountPrioritySnapshot
    try {
      snapshot = await this.store.read()
    } catch (error) {
      if (
        isAccountPriorityError(error) &&
        error.code === 'ACCOUNT_PRIORITY_STORE_CORRUPT'
      ) {
        throw error
      }
      throw new AccountPriorityError(
        'ACCOUNT_PRIORITY_STORE_CORRUPT',
        `读取策略文件失败：${describeError(error)}`,
      )
    }

    let strategies = [...snapshot.strategies]
    let defaultStrategy = snapshot.defaultStrategy
    if (strategies.length === 0) {
      strategies = [structuredClone(DEFAULT_STRATEGY)]
      defaultStrategy = DEFAULT_STRATEGY.id
      try {
        await this.store.write({
          version: SNAPSHOT_VERSION,
          defaultStrategy,
          strategies,
        })
      } catch (error) {
        throw new AccountPriorityError(
          'ACCOUNT_PRIORITY_STORE_WRITE_FAILED',
          `初始化默认策略失败：${describeError(error)}`,
        )
      }
    }

    const validated = validateStrategyCollection(strategies, defaultStrategy, {
      code: 'ACCOUNT_PRIORITY_STORE_CORRUPT',
      label: '策略存储',
    })
    this.strategies = new Map(validated.strategies.map((strategy) => [strategy.id, strategy]))
    this.defaultStrategy = validated.defaultStrategy
  }

  private async commit(
    next: Map<string, StrategyGroup>,
    defaultStrategy: string | null,
  ): Promise<void> {
    const sorted = [...next.values()].sort((a, b) => a.id.localeCompare(b.id))
    try {
      await this.store.write({
        version: SNAPSHOT_VERSION,
        defaultStrategy,
        strategies: sorted,
      })
    } catch (error) {
      throw new AccountPriorityError(
        'ACCOUNT_PRIORITY_STORE_WRITE_FAILED',
        `策略写入失败：${describeError(error)}`,
      )
    }
    this.strategies = new Map(sorted.map((strategy) => [strategy.id, strategy]))
    this.defaultStrategy = defaultStrategy
  }

  // ───────────────────────────────── 内部：进程与桥

  private async launch(): Promise<void> {
    if (this.gateway !== undefined) return
    this.assertReady()

    const executable = this.resolveExecutable()
    const transport = this.resolveTransport()
    const socketPath = this.socketPath()
    if (transport === 'unix' && Buffer.byteLength(socketPath) > 100) {
      throw new AccountPriorityError(
        'ACCOUNT_PRIORITY_START_FAILED',
        `Unix socket 路径过长（${Buffer.byteLength(socketPath)} 字节，上限约 100）：${socketPath}；` +
          '请缩短路径或把 transport 配成 tcp',
      )
    }

    this.setState('starting', null)
    let gateway: GatewayProcess
    gateway = new GatewayProcess({
      executable,
      args: this.config.args,
      transport,
      socketPath,
      httpListen: this.config.httpListen,
      startTimeoutMs: this.config.startTimeoutMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      logFormat: this.config.logFormat,
      onLog: (stream, line) => {
        if (stream === 'stdout') {
          this.logger.debug(`gatewayd: ${line}`)
          return
        }
        // gatewayd 的 slog 全部写 stderr；只有真正的 WARN/ERROR 才升级为 warn。
        if (line.includes('level=WARN') || line.includes('level=ERROR')) {
          this.logger.warn(`gatewayd: ${line}`)
        } else {
          this.logger.info(`gatewayd: ${line}`)
        }
      },
      onExit: (code, signal, error) => this.handleExit(gateway, code, signal, error),
    })
    this.gateway = gateway

    try {
      const started = await gateway.start()
      if (this.stopping || this.disposing) {
        await gateway.stop(1_000)
        if (this.gateway === gateway) this.gateway = undefined
        return
      }

      this.bridge = started.bridge
      this.pid = started.ready.pid ?? started.pid
      this.activeTransport = started.ready.transport
      this.address = started.ready.address
      this.startedAt = new Date().toISOString()
      this.launches += 1
      if (this.launches > 1) this.restarts += 1
      this.restartDelay = this.config.restartDelayMs
      this.setState('ready', null)
      this.logger.info(
        `gatewayd 已就绪：${started.ready.transport} ${started.ready.address}（pid ${String(this.pid)}）` +
          (started.ready.httpAddress === undefined ? '' : `；LLM 请求入口 ${started.ready.httpAddress}`),
      )
      await this.apply()
      // 不阻塞就绪：令牌可能在 identity 侧触发一次 RT 刷新。
      this.scheduleAccountsPush()
      this.scheduleKeysPush()
    } catch (error) {
      if (this.gateway === gateway) this.gateway = undefined
      this.bridge = undefined
      this.pid = null
      await gateway.stop(1_000).catch(() => undefined)
      const wrapped = isAccountPriorityError(error)
        ? error
        : new AccountPriorityError('ACCOUNT_PRIORITY_START_FAILED', describeError(error))
      this.setState('failed', wrapped.message)
      throw wrapped
    }
  }

  private async stopProcess(): Promise<void> {
    this.stopping = true
    this.clearRestartTimer()
    const gateway = this.gateway
    this.gateway = undefined
    if (gateway !== undefined) {
      try {
        await gateway.stop(this.config.stopTimeoutMs)
      } catch (error) {
        this.logger.warn(`停止 gatewayd 失败：${describeError(error)}`)
      }
    }
    this.bridge = undefined
    this.pid = null
    this.revision = null
    this.accountsCount = 0
    this.accountsRevision = null
    this.keysCount = 0
    this.keysRevision = null
    this.setState('stopped', null)
  }

  private handleExit(
    source: GatewayProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    error: Error | null,
  ): void {
    if (this.gateway !== source) return
    if (this.stopping || this.disposing) return

    this.gateway = undefined
    this.bridge = undefined
    this.pid = null
    this.revision = null
    this.accountsCount = 0
    this.accountsRevision = null
    this.keysCount = 0
    this.keysRevision = null
    const detail =
      error !== null
        ? describeError(error)
        : `gatewayd 退出（code=${String(code)}, signal=${String(signal)}）`
    this.setState(this.config.autoStart ? 'degraded' : 'failed', detail)
    this.logger.warn(detail)
    this.ctx.emit('account-priority/error', 'ACCOUNT_PRIORITY_CHILD_EXITED', detail)
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.disposing || !this.config.autoStart || this.restartTimer !== undefined) return
    const delay = this.restartDelay
    this.restartDelay = Math.min(this.restartDelay * 2, this.config.maxRestartDelayMs)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.exclusive(async () => {
        if (this.disposing || this.gateway !== undefined) return
        this.stopping = false
        try {
          await this.launch()
        } catch (error) {
          this.logger.warn(`重启 gatewayd 失败：${describeError(error)}`)
          this.scheduleRestart()
        }
      })
    }, delay)
    this.restartTimer.unref?.()
  }

  private clearRestartTimer(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
  }

  private async apply(): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined) return
    try {
      const result = await bridge.request<ReplaceStrategiesResult>(
        'accountPriority.replaceStrategies',
        this.buildConfig(),
        this.config.requestTimeoutMs,
      )
      this.revision = result.revision
      if (this.state !== 'ready') this.setState('ready', null)
      this.ctx.emit('account-priority/applied', result.revision)
    } catch (error) {
      const message = describeError(error)
      this.setState('degraded', message)
      const code = isAccountPriorityError(error)
        ? error.code
        : 'ACCOUNT_PRIORITY_REQUEST_FAILED'
      this.logger.warn(`推送策略失败：${message}`)
      this.ctx.emit('account-priority/error', code, message)
    }
  }

  private buildConfig(): { defaultStrategy?: string; strategies: readonly StrategyGroup[] } {
    const strategies = [...this.strategies.values()]
    return {
      ...(this.defaultStrategy === null ? {} : { defaultStrategy: this.defaultStrategy }),
      strategies,
    }
  }

  // ───────────────────────────────── 内部：账号快照推送

  /**
   * identity 是账号与令牌的唯一写者；它的事件只是「该重新取一份快照」的提示，
   * 不是正确性来源。监听器挂在 root 上并带 global，跨插件子树也能收到。
   */
  private watchAccounts(): () => void {
    const root = this.ctx.root as unknown as EventRoot
    const trigger = (): void => this.scheduleAccountsPush()
    const offUpdated = root.on('identity/account-updated', trigger, { global: true })
    const offRefreshed = root.on('identity/account-refreshed', trigger, { global: true })
    const offFailed = root.on('identity/account-failed', trigger, { global: true })
    // identity 被启用 / 软重启后服务会重新 provide，此时没有账号事件，
    // 但已有令牌需要立刻再推一次；被卸载时推空快照，避免 Go 继续用旧账号。
    const offService = root.on(
      'internal/service',
      (...args: unknown[]) => {
        if (args[0] === 'identity') trigger()
      },
      { global: true },
    )
    return () => {
      offUpdated()
      offRefreshed()
      offFailed()
      offService()
    }
  }

  private scheduleAccountsPush(): void {
    if (this.disposing || this.accountsTimer !== undefined) return
    this.accountsTimer = setTimeout(() => {
      this.accountsTimer = undefined
      void this.pushAccounts()
    }, ACCOUNTS_PUSH_DEBOUNCE_MS)
    this.accountsTimer.unref?.()
  }

  private clearAccountsTimer(): void {
    if (this.accountsTimer !== undefined) {
      clearTimeout(this.accountsTimer)
      this.accountsTimer = undefined
    }
  }

  private pushAccounts(): Promise<void> {
    const task = this.accountsQueue.then(
      () => this.doPushAccounts(),
      () => this.doPushAccounts(),
    )
    this.accountsQueue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async doPushAccounts(): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined || this.disposing) return
    try {
      const snapshot = await this.buildAccountSnapshot()
      if (this.bridge !== bridge || this.disposing) return
      const result = await bridge.request<GatewayAccountsResult>(
        'accounts.replace',
        snapshot,
        this.config.requestTimeoutMs,
      )
      this.accountsCount = result.accounts
      this.accountsRevision = result.revision
      this.logger.debug(
        `账号快照已推送：revision=${result.revision} accounts=${String(result.accounts)}`,
      )
      this.ctx.emit('account-priority/accounts-applied', result.revision, result.accounts)
    } catch (error) {
      const message = describeError(error)
      this.logger.warn(`推送账号快照失败：${message}`)
      this.ctx.emit('account-priority/error', 'ACCOUNT_PRIORITY_ACCOUNTS_PUSH_FAILED', message)
    }
  }

  private async buildAccountSnapshot(): Promise<GatewayAccountSnapshot> {
    const identity = this.ctx.get('identity', false) as IdentitySeam | undefined
    const accounts: GatewayAccount[] = []
    if (identity !== undefined) {
      for (const account of identity.list()) {
        if (!account.enabled || account.status !== 'active') continue
        const baseUrl = account.baseUrl ?? this.config.upstreamBaseUrls[account.provider]
        if (baseUrl === undefined) continue
        try {
          const token = await identity.getAccessToken(account.id)
          if (token.trim() === '') continue
          accounts.push({
            accountId: account.id,
            provider: account.provider,
            kind: account.kind,
            baseUrl,
            ...(account.protocol === null || account.protocol === undefined ? {} : { protocol: account.protocol }),
            ...(account.models === null || account.models === undefined ? {} : { models: account.models }),
            ...(account.modelMap === null || account.modelMap === undefined ? {} : { modelMap: account.modelMap }),
            token,
            priority: account.priority,
            ...(account.accessExpiresAt === null ? {} : { expiresAt: account.accessExpiresAt }),
          })
        } catch (error) {
          // 令牌不在日志里；这里只记 identity 的安全错误文本。
          this.logger.debug(`账号 ${account.id} 没有可用令牌，跳过：${describeError(error)}`)
        }
      }
    }
    return { version: 1, generation: `gen-${Date.now()}`, accounts }
  }

  // ───────────────────────────────── 内部：API key 快照推送

  /**
   * api-key 是 key 的唯一写者；事件只是「该重新取一份快照」的提示。
   * 监听器挂在 root 上并带 global，跨插件子树也能收到。
   *
   * 触发来源：
   *   - api-key/changed：key 本身被创建 / 修改 / 轮换 / 删除；
   *   - user/changed：用户被封禁 / 删除 / 改状态后，snapshot() 的过滤结果会变；
   *   - internal/service(apiKey)：服务出现时先推一份（HMR 后也能进入 Ready）；
   *     服务消失时，若曾经成功推送过，就推一份空快照撤销旧 key（D5）。
   *     启动时就从未出现过则不推——保留 Go 的 Ready=false 启动/降级路径。
   */
  private watchKeys(): () => void {
    const root = this.ctx.root as unknown as EventRoot
    const trigger = (): void => this.scheduleKeysPush()
    const offChanged = root.on('api-key/changed', trigger, { global: true })
    const offUserChanged = root.on('user/changed', trigger, { global: true })
    const offService = root.on(
      'internal/service',
      (...args: unknown[]) => {
        if (args[0] !== 'apiKey') return
        if (args[1] !== undefined) {
          // 服务出现。清掉可能残留的撤销意图：重新出现后应推真实快照。
          this.keysServiceSeen = true
          this.keysRevokePending = false
          trigger()
          return
        }
        // 服务消失。只有当它曾经推送过时才撤销；否则保留启动/降级路径。
        if (this.keysServiceSeen && this.lastKeysGeneration !== null) {
          this.keysRevokePending = true
          trigger()
        }
      },
      { global: true },
    )
    return () => {
      offChanged()
      offUserChanged()
      offService()
    }
  }

  private scheduleKeysPush(): void {
    if (this.disposing || this.keysTimer !== undefined) return
    this.keysTimer = setTimeout(() => {
      this.keysTimer = undefined
      void this.pushKeys()
    }, KEYS_PUSH_DEBOUNCE_MS)
    this.keysTimer.unref?.()
  }

  private clearKeysTimer(): void {
    if (this.keysTimer !== undefined) {
      clearTimeout(this.keysTimer)
      this.keysTimer = undefined
    }
  }

  private pushKeys(): Promise<void> {
    const task = this.keysQueue.then(
      () => this.doPushKeys(),
      () => this.doPushKeys(),
    )
    this.keysQueue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async doPushKeys(): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined || this.disposing) return
    const apiKey = this.apiKeySeam()
    if (apiKey === undefined && !this.keysRevokePending) return

    try {
      let snapshot: GatewayKeySnapshot | undefined
      let revoke = apiKey === undefined

      if (apiKey !== undefined) {
        // 正常启动时 apiKey 可能在 account-priority 之前就已 active，收不到
        // internal/service 的「出现」事件；一次成功的取快照同样算「见过」。
        this.keysServiceSeen = true
        const observed = await apiKey.snapshot()
        // 等待期间服务被卸载：不要推过期的非空快照，改为撤销。
        if (this.keysRevokePending || this.apiKeySeam() === undefined) {
          revoke = true
        } else {
          // 撤销时 generation 用了 last+1；服务重新出现后 DB generation 可能还停在
          // 旧值。这里钳到不小于 last，避免 generation 回退。
          const generation =
            this.lastKeysGeneration === null
              ? observed.generation
              : Math.max(observed.generation, this.lastKeysGeneration)
          snapshot =
            generation === observed.generation ? observed : { ...observed, generation }
        }
      }

      if (revoke) {
        // D5：api-key 服务消失后撤销旧 key。只有曾经成功推送过才需要撤销；
        // 启动时就从未出现过时不推，保留 Go 的 Ready=false 启动/降级路径。
        if (!this.keysServiceSeen || this.lastKeysGeneration === null) return
        snapshot = {
          version: 1,
          generation: this.lastKeysGeneration + 1,
          keys: [],
        }
      }
      if (snapshot === undefined) return

      if (this.bridge !== bridge || this.disposing) return
      const result = await bridge.request<GatewayKeysResult>(
        'keys.replace',
        snapshot,
        this.config.requestTimeoutMs,
      )
      this.keysCount = result.keys
      this.keysRevision = result.revision
      this.lastKeysGeneration = snapshot.generation

      if (revoke) {
        this.keysRevokePending = false
        // 撤销期间服务又回来了：再推一份真实快照。
        if (this.apiKeySeam() !== undefined) this.scheduleKeysPush()
      } else if (this.keysRevokePending || this.apiKeySeam() === undefined) {
        // 正常推送期间服务消失：保留撤销意图，下一轮推空快照。
        this.keysRevokePending = true
        this.scheduleKeysPush()
      } else {
        this.keysRevokePending = false
      }

      // 只记计数与 generation；key / 哈希永不进日志。
      this.logger.debug(
        `API key 快照已推送：revision=${result.revision} keys=${String(result.keys)} ` +
          `generation=${String(snapshot.generation)}` +
          (revoke ? '（api-key 已卸载，撤销旧快照）' : ''),
      )
    } catch (error) {
      const message = describeError(error)
      this.logger.warn(`推送 API key 快照失败：${message}`)
      this.ctx.emit('account-priority/error', 'ACCOUNT_PRIORITY_KEYS_PUSH_FAILED', message)
    }
  }

  /**
   * 取 api-key 服务的原始实例。
   *
   * 不用 static inject：api-key 被禁用时 account-priority 不应该跟着 pending。
   * 也不碰 `ctx.get()` 的 traced proxy（AGENTS.md §10）。
   */
  private apiKeySeam(): ApiKeySeam | undefined {
    const impl = this.ctx.root.reflect._getImpl('apiKey', false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value as Partial<ApiKeySeam> | undefined
    return typeof value?.snapshot === 'function' ? (value as ApiKeySeam) : undefined
  }

  private requireBridge(): BridgeClient {
    if (this.bridge === undefined) {
      throw new AccountPriorityError(
        'ACCOUNT_PRIORITY_NOT_READY',
        `gatewayd 未就绪（当前状态：${this.state}）`,
      )
    }
    return this.bridge
  }

  private resolveExecutable(): string {
    const configured = resolveLocalPath(this.ctx, this.config.binaryPath)
    if (configured === undefined) {
      throw new AccountPriorityError('ACCOUNT_PRIORITY_BINARY_MISSING', 'binaryPath 不能为空')
    }
    if (existsSync(configured)) return configured
    if (process.platform === 'win32' && !configured.toLowerCase().endsWith('.exe')) {
      const withExe = `${configured}.exe`
      if (existsSync(withExe)) return withExe
    }
    throw new AccountPriorityError(
      'ACCOUNT_PRIORITY_BINARY_MISSING',
      `找不到 gatewayd：${configured}（先运行 pnpm build:go）`,
    )
  }

  private resolveTransport(): 'unix' | 'tcp' {
    if (this.config.transport === 'auto') {
      return process.platform === 'win32' ? 'tcp' : 'unix'
    }
    return this.config.transport
  }

  private socketPath(): string {
    return resolveLocalPath(this.ctx, this.config.socketPath) as string
  }

  private setState(state: ChildState, error: string | null): void {
    this.state = state
    this.lastError = error
    this.ctx.emit('account-priority/child-state', state, error)
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new AccountPriorityError('ACCOUNT_PRIORITY_NOT_READY', '账号优先级插件尚未装载完成')
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function resolveConfig(
  config: AccountPriorityConfig | ResolvedAccountPriorityConfig,
): ResolvedAccountPriorityConfig {
  const result = validateAccountPriorityConfig(config)
  if (isIssueList(result)) {
    throw new AccountPriorityError(
      'ACCOUNT_PRIORITY_INVALID_ARGUMENT',
      `账号优先级配置不合法：${result.map((item) => item.message).join('；')}`,
    )
  }
  return result
}

function resolveLocalPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function chooseDefault(
  strategies: Map<string, StrategyGroup>,
  preferred: string | null,
): string | null {
  const firstEnabled =
    [...strategies.values()].find((strategy) => strategy.enabled !== false)?.id ?? null
  if (preferred !== null) {
    const target = strategies.get(preferred)
    if (target !== undefined && target.enabled !== false) return preferred
  }
  return firstEnabled
}
