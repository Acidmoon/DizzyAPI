/**
 * 账号健康检查插件（服务名 `accountHealth`）。
 *
 * 它做三件事，而且只做这三件：
 * 1. 按 `intervalMs` 定时拿门面的账号列表，对可参与调度的账号做连通性测试（有界并发）；
 * 2. 连续失败到 `failureThreshold` → `accountAdmin.autoDisable`，连续成功到
 *    `recoverySuccesses` → `accountAdmin.autoEnable`；
 * 3. 把判定结果写成成本账号的 `health`（healthy / degraded / unhealthy），
 *    它是 Go 侧 `Filter.Health` 的输入。
 *
 * 边界（AGENTS.md 2.4 / D5）：
 * - **自己不存任何状态**：没有存储、没有文件；账号记录只有 identity 写，
 *   本插件只经 `accountAdmin` 门面调用（不 import identity，也不直连 accounts.json）。
 * - 进程内计数（连续失败 / 成功次数）只是调度用的易失状态，禁用即丢——它不参与调度。
 * - 后台任务只有定时器：挂 `ctx.effect`，禁用 / 卸载时立刻停；在飞的单次测试无法中断
 *   （fetch 由门面持有、有自己的超时），但结果在 disposed 之后一律丢弃，不写回任何状态。
 */
import { Service, type Context, type Logger } from 'cordis'
// 只为了类型：@cordisjs/plugin-timer 往 Context 上 mixin 了 setInterval / timer。
// 运行时由 app.yml 的 timer entry 提供，本插件不自己装载它。
import type {} from '@cordisjs/plugin-timer'
import { describeError } from '@dizzyapi/plugin-kit'
import {
  ACCOUNT_HEALTH_CONFIG_SCHEMA,
  ACCOUNT_HEALTH_DEFAULTS,
  type AccountHealthConfig,
  type ResolvedAccountHealthConfig,
} from './config.ts'
import { AccountHealthError } from './errors.ts'

/** 本插件作为写入方时用的 actor 名；必须出现在 account-admin 的 `adminPlugins` 里。 */
export const ACCOUNT_HEALTH_ACTOR = '@dizzyapi/plugin-account-health'

const ACTOR_MAX_LENGTH = 200

type HealthValue = 'unknown' | 'healthy' | 'degraded' | 'unhealthy'

/** 门面结构视图：只声明本插件用到的方法，不 import account-admin 的实现。 */
interface AccountAdminSeam {
  list(
    query?: Readonly<Record<string, never>>,
    options?: { readonly view?: 'lite' | 'full' },
  ): readonly AccountHealthItem[]
  testConnection(id: string): Promise<{ readonly ok: boolean; readonly error: string | null }>
  setHealth(actor: string, id: string, health: HealthValue): Promise<unknown>
  autoDisable(actor: string, id: string, reason: string): Promise<unknown>
  autoEnable(actor: string, id: string): Promise<unknown>
}

interface AccountHealthItem {
  readonly id: string
  readonly enabled: boolean
  readonly status: string
  readonly health: HealthValue
}

/** 一轮检查的可观察结果；公开给测试与将来的面板。 */
export interface AccountHealthPass {
  /** 实际测了几个账号。 */
  readonly checked: number
  /** 测通的数量。 */
  readonly healthy: number
  /** 没测通的数量。 */
  readonly failed: number
  /** 这一轮里被自动停用的账号 id。 */
  readonly autoDisabled: readonly string[]
  /** 这一轮里被自动恢复的账号 id。 */
  readonly autoEnabled: readonly string[]
}

export interface AccountHealthStatus {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly failureThreshold: number
  readonly recoverySuccesses: number
  readonly maxConcurrent: number
  /** 是否有一轮正在跑（单飞）。 */
  readonly running: boolean
  /** 上一轮结果；还没跑过为 null。 */
  readonly lastPass: AccountHealthPass | null
  readonly lastPassAt: string | null
}

const EMPTY_PASS: AccountHealthPass = { checked: 0, healthy: 0, failed: 0, autoDisabled: [], autoEnabled: [] }

export class AccountHealthService extends Service {
  static Config = ACCOUNT_HEALTH_CONFIG_SCHEMA
  /**
   * 只依赖门面拿数据、写状态（identity 不在运行时它也不该在，D16）。
   *
   * `timer` 也必须声明在 inject 里：`ctx.setInterval` 是 @cordisjs/plugin-timer 的 mixin，
   * cordis 只允许「已声明依赖」的上下文访问它——不声明会直接抛
   * `cannot get property "timer" without inject`。没有 timer 时本插件停在 PENDING
   * （与其它 inject 依赖一致），而不是偷偷退回到裸 setInterval。
   */
  static inject = ['accountAdmin', 'timer']

  /**
   * 能力清单：纯后台任务，没有 HTTP 路由、没有桥命令、没有存储。
   * 手动触发是进程内方法（`runOnce`），按 `adminPlugins` 白名单限权。
   */
  static catalog = {
    capabilities: ['account-health-check', 'account-auto-disable'],
    events: [],
    bridge: [],
    storage: [],
    methods: {
      runOnce: {
        description:
          '手动跑一轮健康检查（只对 adminPlugins 里的插件开放）；结果与定时器跑的那一轮完全一致',
      },
      status: { description: '定时器与上一轮检查的可观察状态（不含账号数据）' },
    },
  } as const

  readonly config: ResolvedAccountHealthConfig
  private readonly adminPlugins: readonly string[]
  private readonly logger: Logger
  private ready = false
  private disposed = false
  private running: Promise<AccountHealthPass> | undefined
  /** 连续失败 / 成功计数：易失状态，禁用即丢。 */
  private readonly failures = new Map<string, number>()
  private readonly successes = new Map<string, number>()
  private lastPass: AccountHealthPass | null = null
  private lastPassAt: string | null = null

  constructor(ctx: Context, config: AccountHealthConfig | ResolvedAccountHealthConfig = {}) {
    super(ctx, 'accountHealth')
    this.config = resolveConfig(config)
    this.adminPlugins = this.config.adminPlugins
    this.logger = ctx.logger('account-health')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.ready = true
    this.logger.info(
      `账号健康检查已装载：每 ${this.config.intervalMs}ms 一轮；连续失败 ${this.config.failureThreshold} 次自动停用；` +
        `连续成功 ${this.config.recoverySuccesses} 次自动恢复；并发 ${this.config.maxConcurrent}；` +
        `启用 ${this.config.enabled ? '开' : '关'}`,
    )
    if (!this.config.enabled) {
      this.logger.info('自动健康检查已禁用（enabled=false）：不注册定时器')
      yield () => {
        this.disposed = true
      }
      return
    }
    if (this.ctx.get('timer', false) === undefined) {
      throw new AccountHealthError(
        'ACCOUNT_HEALTH_TIMER_UNAVAILABLE',
        'timer 服务不可用（app.yml 的 timer entry 没启用），无法注册健康检查定时器',
      )
    }

    this.logger.info(`健康检查定时器已注册：定时器归 ctx.effect 管，禁用即停`)
    // 注册即副作用：定时器挂在 ctx.effect 上，插件卸载时由 cordis 回收（D5）。
    const stop = this.ctx.effect(
      () => this.ctx.setInterval(() => {
        void this.runPass().catch((error) => {
          this.logger.warn(`健康检查失败：${describeError(error)}`)
        })
      }, this.config.intervalMs),
      'accountHealth.timer',
    )

    yield () => {
      this.disposed = true
      stop()
    }
  }

  /** 手动跑一轮；只对白名单里的插件开放（定时器自己不走这里）。 */
  async runOnce(actor: string): Promise<AccountHealthPass> {
    this.assertReady()
    const name = normalizeActor(actor)
    if (!this.adminPlugins.includes(name)) {
      throw new AccountHealthError(
        'ACCOUNT_HEALTH_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权触发健康检查（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
    return this.runPass()
  }

  status(): AccountHealthStatus {
    return {
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
      failureThreshold: this.config.failureThreshold,
      recoverySuccesses: this.config.recoverySuccesses,
      maxConcurrent: this.config.maxConcurrent,
      running: this.running !== undefined,
      lastPass: this.lastPass,
      lastPassAt: this.lastPassAt,
    }
  }

  /**
   * 跑一轮检查。单飞：上一轮没跑完就返回同一个 Promise，不叠加压力。
   * 公开是为了单测能直接驱动；日常由定时器调用。
   */
  runPass(): Promise<AccountHealthPass> {
    this.assertReady()
    if (this.running !== undefined) return this.running
    const task = this.doPass().finally(() => {
      this.running = undefined
    })
    this.running = task
    return task
  }

  private async doPass(): Promise<AccountHealthPass> {
    const admin = this.facade()
    const accounts = admin.list({}, { view: 'lite' })
    // 人的开关优先：enabled=false 的账号不测；needs_reauth 没有可用凭据，测了也没意义。
    const targets = accounts.filter(
      (account) => account.enabled && account.status !== 'needs_reauth',
    )

    let healthy = 0
    let checked = 0
    const autoDisabled: string[] = []
    const autoEnabled: string[] = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.disposed) return
        const index = cursor
        cursor += 1
        if (index >= targets.length) return
        const outcome = await this.checkOne(admin, targets[index])
        checked += 1
        if (outcome.ok) healthy += 1
        if (outcome.autoDisabled) autoDisabled.push(targets[index].id)
        if (outcome.autoEnabled) autoEnabled.push(targets[index].id)
      }
    }
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(this.config.maxConcurrent, targets.length)) }, worker),
    )

    // 易失计数只为「连续」服务：账号被删 / 被移出检查范围后清掉，避免无限增长。
    const alive = new Set(accounts.map((account) => account.id))
    for (const id of this.failures.keys()) if (!alive.has(id)) this.failures.delete(id)
    for (const id of this.successes.keys()) if (!alive.has(id)) this.successes.delete(id)

    const pass: AccountHealthPass = { checked, healthy, failed: checked - healthy, autoDisabled, autoEnabled }
    if (this.disposed) return EMPTY_PASS
    this.lastPass = pass
    this.lastPassAt = new Date().toISOString()
    if (autoDisabled.length > 0) this.logger.warn(`已自动停用账号：${autoDisabled.join(', ')}`)
    if (autoEnabled.length > 0) this.logger.info(`已自动恢复账号：${autoEnabled.join(', ')}`)
    return pass
  }

  /** 单个账号：测一次、按连续次数决定写什么状态。任何写失败只记日志，不让整轮挂掉。 */
  private async checkOne(
    admin: AccountAdminSeam,
    account: AccountHealthItem,
  ): Promise<{ ok: boolean; autoDisabled: boolean; autoEnabled: boolean }> {
    let result: { readonly ok: boolean; readonly error: string | null }
    try {
      result = await admin.testConnection(account.id)
    } catch (error) {
      // testConnection 只在参数 / 配置错误时抛（连接失败是结果对象），兜底记录。
      this.logger.warn(`账号 ${account.id} 的连通性测试异常：${describeError(error)}`)
      return { ok: false, autoDisabled: false, autoEnabled: false }
    }
    if (this.disposed) return { ok: result.ok, autoDisabled: false, autoEnabled: false }
    return result.ok
      ? this.applyHealthy(admin, account)
      : this.applyFailure(admin, account, result.error)
  }

  private async applyHealthy(
    admin: AccountAdminSeam,
    account: AccountHealthItem,
  ): Promise<{ ok: boolean; autoDisabled: boolean; autoEnabled: boolean }> {
    this.failures.delete(account.id)
    const successes = (this.successes.get(account.id) ?? 0) + 1
    this.successes.set(account.id, successes)
    let autoEnabled = false
    try {
      if (account.health !== 'healthy') await admin.setHealth(ACCOUNT_HEALTH_ACTOR, account.id, 'healthy')
      if (account.status === 'auto_disabled' && successes >= this.config.recoverySuccesses) {
        await admin.autoEnable(ACCOUNT_HEALTH_ACTOR, account.id)
        this.successes.delete(account.id)
        autoEnabled = true
      }
    } catch (error) {
      this.logger.warn(`账号 ${account.id} 的健康状态写回失败：${describeError(error)}`)
    }
    return { ok: true, autoDisabled: false, autoEnabled }
  }

  private async applyFailure(
    admin: AccountAdminSeam,
    account: AccountHealthItem,
    error: string | null,
  ): Promise<{ ok: boolean; autoDisabled: boolean; autoEnabled: boolean }> {
    this.successes.delete(account.id)
    const failures = (this.failures.get(account.id) ?? 0) + 1
    this.failures.set(account.id, failures)
    const reason = `健康检查连续失败 ${failures} 次：${error ?? '未知错误'}`
    let autoDisabled = false
    try {
      if (failures >= this.config.failureThreshold) {
        if (account.health !== 'unhealthy') await admin.setHealth(ACCOUNT_HEALTH_ACTOR, account.id, 'unhealthy')
        // 只有 active 的账号会被真正停用；已停用 / 已自动停用的由 identity 做成 no-op。
        // 先记下原状态再写：写完再读 `account.status` 会被门面的写入改掉（门面返回的是视图）。
        const wasActive = account.status === 'active'
        await admin.autoDisable(ACCOUNT_HEALTH_ACTOR, account.id, reason)
        autoDisabled = wasActive
      } else if (account.health !== 'degraded') {
        await admin.setHealth(ACCOUNT_HEALTH_ACTOR, account.id, 'degraded')
      }
    } catch (writeError) {
      this.logger.warn(`账号 ${account.id} 的失败状态写回失败：${describeError(writeError)}`)
    }
    return { ok: false, autoDisabled, autoEnabled: false }
  }

  private facade(): AccountAdminSeam {
    const service = this.ctx.get('accountAdmin', false)
    if (service === undefined || service === null) {
      throw new AccountHealthError(
        'ACCOUNT_HEALTH_ADMIN_UNAVAILABLE',
        'accountAdmin 服务不可用；健康检查只经门面读写账号',
      )
    }
    return service as unknown as AccountAdminSeam
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new AccountHealthError('ACCOUNT_HEALTH_INVALID_ARGUMENT', '账号健康检查插件尚未装载完成')
    }
    if (this.disposed) {
      throw new AccountHealthError('ACCOUNT_HEALTH_INVALID_ARGUMENT', '账号健康检查插件已卸载')
    }
  }
}

// ───────────────────────────────── 工具

function resolveConfig(config: AccountHealthConfig | ResolvedAccountHealthConfig): ResolvedAccountHealthConfig {
  return {
    enabled: config.enabled ?? ACCOUNT_HEALTH_DEFAULTS.enabled,
    intervalMs: config.intervalMs ?? ACCOUNT_HEALTH_DEFAULTS.intervalMs,
    failureThreshold: config.failureThreshold ?? ACCOUNT_HEALTH_DEFAULTS.failureThreshold,
    recoverySuccesses: config.recoverySuccesses ?? ACCOUNT_HEALTH_DEFAULTS.recoverySuccesses,
    maxConcurrent: config.maxConcurrent ?? ACCOUNT_HEALTH_DEFAULTS.maxConcurrent,
    adminPlugins: config.adminPlugins ?? ACCOUNT_HEALTH_DEFAULTS.adminPlugins,
  }
}

function normalizeActor(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AccountHealthError('ACCOUNT_HEALTH_ACTOR_REQUIRED', '调用方必须声明自己的插件名')
  }
  const name = value.trim()
  if (name.length > ACTOR_MAX_LENGTH) {
    throw new AccountHealthError('ACCOUNT_HEALTH_ACTOR_REQUIRED', `插件名最长 ${ACTOR_MAX_LENGTH} 个字符`)
  }
  return name
}
