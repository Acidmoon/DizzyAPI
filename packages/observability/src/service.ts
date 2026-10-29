/**
 * 运维总览插件（服务名 `observability`）。
 *
 * 定位：**纯只读聚合**。它不落盘、不写任何数据、不发事件、不挂 HTTP，只把六份只读事实
 * 拼成一屏：
 *
 * 1. `usage` 的 `status()` —— TS 侧轮询状态（连续失败 / 缺口 / 隔离区）；
 * 2. `accountPriority.usageStats()` —— Go 环形缓冲健康度（capacity / size / dropped / gap）；
 * 3. `billing.summary()` —— 结算各状态计数与扣费额（整数微元）；
 * 4. `accountPriority.quotaStatus()` —— 余额快照的新鲜度（ageMs / ttlMs）；
 * 5. `accountPriority.accountsRuntime()` —— Go 侧全站 active / cooling 计数；
 * 6. `audit` 的 `list` / `stats` —— 最近动作与异常；
 * 7. `accountAdmin.list()` + `accountHealth.status()` —— 账号池健康四态与最近一轮检查。
 *
 * 纪律：
 * - **不 inject 任何服务**：七个源全部运行期解析（`ctx.root.reflect._getImpl(name, false)`）。
 *   缺谁只让那一块「不可用」，**其余块照常渲染**，本插件也不 PENDING（D5）。
 * - **每块自带健康度**：`ok` / `degraded` / `unavailable` + 人话原因；绝不因为一个源抛错
 *   把整份报告打挂。
 * - **不泄漏**：只有计数、时间、稳定码与摘要；账号 id / label / baseUrl / 用户隐私 / 秘密
 *   一律不出现在报告里（审计条目只带 actor / action / target 与已脱敏摘要）。
 * - **金额一律十进制字符串**（整数微元），跨层不经浮点。
 * - **不缓存**：每次调用现算，没有「缓存过期」这一类 bug。
 */
import { FiberState, Service, type Context, type Logger } from 'cordis'
import { describeError, isIssueList } from '@dizzyapi/plugin-kit'
import {
  OBSERVABILITY_CONFIG_SCHEMA,
  validateObservabilityConfig,
  type ObservabilityConfig,
  type ResolvedObservabilityConfig,
} from './config.ts'
import { ObservabilityError } from './errors.ts'
import type {
  AccountsView,
  AuditItemView,
  AuditView,
  BillingView,
  ObservabilityReport,
  QuotaView,
  RuntimeView,
  SourceHealth,
  UsageChainView,
} from './types.ts'

/** 管理面读白名单里要登记本插件的名字（billing / audit 的 `adminPlugins`）。 */
export const OBSERVABILITY_ACTOR = '@dizzyapi/plugin-observability'

const DAY_MS = 86_400_000
const RECENT_AUDIT_LIMIT = 5
const HEALTH_DETAIL_MAX = 200

// ───────────────────────────────── 运行期解析的服务面（结构声明，不 import 实现） ─────────────────────────────────

interface UsageStatusSeam {
  records: number
  epoch: string | null
  lastSeq: number
  polling: boolean
  pricingAvailable: boolean
  consecutiveFailures: number
  lastError: string | null
  gapRecords: number
  rejectedCount: number
  rejectedPending: number
}

interface UsageSeam {
  status(): UsageStatusSeam
}

interface UsageStatsSeam {
  epoch: string
  capacity: number
  size: number
  firstSeq: number
  lastSeq: number
  dropped: number
  gap: number
}

interface QuotaStatusSeam {
  ready: boolean
  revision?: string
  generation?: number
  size: number
  updatedAt?: string
  ageMs: number
  ttlMs: number
}

interface AccountsRuntimeSeam {
  active: number
  cooling: number
}

interface PrioritySeam {
  usageStats?(): Promise<UsageStatsSeam>
  quotaStatus?(): Promise<QuotaStatusSeam>
  accountsRuntime?(): Promise<AccountsRuntimeSeam | undefined>
}

interface SettleTotalsSeam {
  records: number
  settled: number
  noPrice: number
  noUser: number
  failed: number
  review: number
  settling: number
  overdrawn: number
  chargedMicros: bigint
  todayChargedMicros: bigint
}

interface DailyPointSeam {
  date: string
  records: number
  settled: number
  chargedMicros: bigint
}

interface BillingSeam {
  summary(actor: string, nowMs?: number): {
    totals: SettleTotalsSeam
    daily: readonly DailyPointSeam[]
    models: readonly unknown[]
  }
}

interface AuditRecordSeam {
  id: number
  at: string
  atMs: number
  actor: string
  actorPlugin: string
  action: string
  targetType: string
  targetId: string
  summary: string
  metadata: unknown
  result: 'ok' | 'failed'
  errorCode: string | null
}

interface AuditStatsSeam {
  total: number
  today: number
  last24h: number
  failed: number
  lastAt: string | null
}

interface AuditSeam {
  list(
    actor: string,
    query?: { limit?: number; offset?: number; fromMs?: number; toMs?: number },
  ): { items: readonly AuditRecordSeam[]; total: number }
  stats(actor: string): AuditStatsSeam
}

interface AccountHealthStatusSeam {
  enabled: boolean
  running: boolean
  lastPass: {
    checked: number
    healthy: number
    failed: number
    autoDisabled: readonly string[]
    autoEnabled: readonly string[]
  } | null
  lastPassAt: string | null
}

interface AccountHealthSeam {
  status(): AccountHealthStatusSeam
}

interface AccountSeamRecord {
  enabled?: boolean
  status?: string
  health?: string | null
}

interface AccountAdminSeam {
  list(query?: unknown): readonly AccountSeamRecord[]
}

// ───────────────────────────────── 服务 ─────────────────────────────────

export class ObservabilityService extends Service {
  static Config = OBSERVABILITY_CONFIG_SCHEMA

  /** 不 inject：任一源缺席只让那一块降级，本插件与整个运维页仍然可用（D5）。 */
  static inject: readonly string[] = []

  static catalog = {
    capabilities: ['observability', 'read-only-aggregate'],
    events: [],
    bridge: [],
    storage: [],
    shapes: {
      ObservabilityReport: {
        description: '运维总览：六块只读事实 + 每块的数据源健康度；金额是整数微元字符串',
        fields: {
          generatedAt: { type: 'string' },
          warnings: { type: 'array' },
          degraded: { type: 'boolean' },
        },
      },
    },
  } as const

  readonly config: ResolvedObservabilityConfig
  private readonly logger: Logger
  private ready = false

  constructor(ctx: Context, config: ObservabilityConfig | ResolvedObservabilityConfig = {}) {
    super(ctx, 'observability')
    const resolved = validateObservabilityConfig(config)
    if (isIssueList(resolved)) {
      throw new ObservabilityError(
        'OBSERVABILITY_CONFIG_INVALID',
        `运维总览配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.logger = ctx.logger('observability')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.ready = true
    this.logger.info(`运维总览插件已装载：审计窗口上限 ${this.config.auditWindowLimit} 条；纯只读、不落盘`)
    yield () => {
      this.ready = false
    }
  }

  /**
   * 现算一份报告。**任何单个源失败都不抛错**：只把那一块标成不可用并写一句原因。
   *
   * 公开是为了单测能直接驱动；日常由 `api` 的 `/api/admin/observability` 与
   * `web` 的 `/admin/observability` 调用。
   */
  async observe(nowMs: number = Date.now()): Promise<ObservabilityReport> {
    if (!this.ready) throw new ObservabilityError('OBSERVABILITY_NOT_READY', '运维总览插件尚未装载完成')
    const now = Number.isFinite(nowMs) ? nowMs : Date.now()

    const priority = this.seam<PrioritySeam>('accountPriority', ['quotaStatus', 'accountsRuntime'])
    const usage = await this.observeUsage(priority)
    const billing = this.observeBilling(now)
    const quota = await this.observeQuota(priority)
    const runtime = await this.observeRuntime(priority)
    const audit = this.observeAudit(now)
    const accounts = this.observeAccounts()

    const warnings = warningsOf({ usage, billing, quota, runtime, audit, accounts })
    const blocks = [usage, billing, quota, runtime, audit, accounts] as readonly { health: SourceHealth }[]
    return {
      generatedAt: new Date(now).toISOString(),
      usage,
      billing,
      quota,
      runtime,
      audit,
      accounts,
      warnings,
      // 「不完整」= 有任何一块不是 ok：degraded（能用但不可信 / 只有一半）也算。
      degraded: blocks.some((block) => block.health.state !== 'ok'),
    }
  }

  // ───────────────────────────────── 各块 ─────────────────────────────────

  private async observeUsage(priority: PrioritySeam | undefined): Promise<UsageChainView> {
    let service: UsageChainView['service'] = null
    let health: SourceHealth = { state: 'unavailable', detail: '用量插件未运行：看不到轮询状态与隔离区' }
    const usage = this.seam<UsageSeam>('usage', ['status'])
    if (usage !== undefined) {
      try {
        const status = usage.status()
        service = {
          records: intOf(status.records),
          polling: status.polling === true,
          consecutiveFailures: intOf(status.consecutiveFailures),
          lastError: nullableTextOf(status.lastError),
          gapRecords: intOf(status.gapRecords),
          rejectedCount: intOf(status.rejectedCount),
          rejectedPending: intOf(status.rejectedPending),
          pricingAvailable: status.pricingAvailable !== false,
          epoch: nullableTextOf(status.epoch),
          lastSeq: intOf(status.lastSeq),
        }
        health = { state: 'ok', detail: '' }
      } catch (error) {
        health = { state: 'degraded', detail: `读取用量状态失败：${detailOf(error)}` }
      }
    }

    let gateway: UsageChainView['gateway'] = null
    let gatewayHealth: SourceHealth = {
      state: 'unavailable',
      detail: 'account-priority 未运行：读不到 Go 环形缓冲健康度',
    }
    if (priority !== undefined) {
      if (typeof priority.usageStats !== 'function') {
        gatewayHealth = {
          state: 'unavailable',
          detail: 'account-priority 没有提供 usageStats：读不到缓冲健康度',
        }
      } else {
        try {
          const stats = await priority.usageStats()
          gateway = {
            epoch: textOf(stats.epoch),
            capacity: intOf(stats.capacity),
            size: intOf(stats.size),
            firstSeq: intOf(stats.firstSeq),
            lastSeq: intOf(stats.lastSeq),
            dropped: intOf(stats.dropped),
            gap: intOf(stats.gap),
          }
          gatewayHealth = { state: 'ok', detail: '' }
        } catch (error) {
          gatewayHealth = {
            state: 'degraded',
            detail: `读取 Go 缓冲健康度失败：${detailOf(error)}`,
          }
        }
      }
    }

    // 整条链路的健康度取两者较差的一个：缓冲读不到 = 链路只有一半可观测。
    if (health.state === 'ok' && gatewayHealth.state !== 'ok') {
      health = { state: 'degraded', detail: gatewayHealth.detail }
    }
    return { health, service, gateway, gatewayHealth }
  }

  private observeBilling(nowMs: number): BillingView {
    const billing = this.seam<BillingSeam>('billing', ['summary'])
    if (billing === undefined) {
      return {
        health: { state: 'unavailable', detail: '结算插件未运行：看不到状态计数与扣费额' },
        totals: null,
        chargedMicros: null,
        today: null,
      }
    }
    try {
      const summary = billing.summary(OBSERVABILITY_ACTOR, nowMs)
      const totals = summary.totals
      const counted =
        intOf(totals.settled) +
        intOf(totals.noPrice) +
        intOf(totals.noUser) +
        intOf(totals.failed) +
        intOf(totals.review) +
        intOf(totals.settling)
      // pending 没有单独字段：用总数减去其它状态（不会为负）。
      const pending = Math.max(0, intOf(totals.records) - counted)
      const today = todayPointOf(summary.daily, nowMs)
      return {
        health: { state: 'ok', detail: '' },
        totals: {
          records: intOf(totals.records),
          settled: intOf(totals.settled),
          pending,
          settling: intOf(totals.settling),
          noPrice: intOf(totals.noPrice),
          noUser: intOf(totals.noUser),
          failed: intOf(totals.failed),
          review: intOf(totals.review),
          overdrawn: intOf(totals.overdrawn),
        },
        chargedMicros: bigintText(totals.chargedMicros),
        today,
      }
    } catch (error) {
      return {
        health: { state: 'degraded', detail: `读取结算汇总失败：${detailOf(error)}` },
        totals: null,
        chargedMicros: null,
        today: null,
      }
    }
  }

  private async observeQuota(priority: PrioritySeam | undefined): Promise<QuotaView> {
    const empty: QuotaView = {
      health: { state: 'unavailable', detail: 'account-priority 未运行：读不到额度快照状态' },
      ready: null,
      revision: null,
      generation: null,
      size: null,
      ageMs: null,
      ttlMs: null,
      stale: null,
    }
    if (priority === undefined) return empty
    if (typeof priority.quotaStatus !== 'function') {
      return { ...empty, health: { state: 'unavailable', detail: 'account-priority 没有提供 quotaStatus' } }
    }
    try {
      const status = await priority.quotaStatus()
      const ready = status.ready === true
      const ageMs = intOf(status.ageMs)
      const ttlMs = intOf(status.ttlMs)
      const stale = ready && ttlMs > 0 ? ageMs > ttlMs : !ready
      return {
        health:
          ready && !stale
            ? { state: 'ok', detail: '' }
            : {
                state: 'degraded',
                detail: ready
                  ? `余额快照已过期：年龄 ${ageMs}ms 超过 TTL ${ttlMs}ms（严格模式下会 503）`
                  : '余额快照尚未就绪：Go 还没收到过 quota.replace',
              },
        ready,
        revision: nullableTextOf(status.revision),
        generation:
          typeof status.generation === 'number' && Number.isFinite(status.generation)
            ? Math.trunc(status.generation)
            : null,
        size: intOf(status.size),
        ageMs,
        ttlMs,
        stale,
      }
    } catch (error) {
      return { ...empty, health: { state: 'degraded', detail: `读取额度快照状态失败：${detailOf(error)}` } }
    }
  }

  private async observeRuntime(priority: PrioritySeam | undefined): Promise<RuntimeView> {
    const empty: RuntimeView = {
      health: { state: 'unavailable', detail: 'account-priority 未运行：读不到账号运行时计数' },
      active: null,
      cooling: null,
    }
    if (priority === undefined) return empty
    if (typeof priority.accountsRuntime !== 'function') {
      return {
        ...empty,
        health: { state: 'unavailable', detail: 'account-priority 没有提供 accountsRuntime' },
      }
    }
    try {
      const summary = await priority.accountsRuntime()
      if (summary === undefined) {
        return {
          ...empty,
          health: {
            state: 'degraded',
            detail: 'Go 侧没有注入运行时跟踪器（旧二进制或测试装配）：active / cooling 不可得',
          },
        }
      }
      return {
        health: { state: 'ok', detail: '' },
        active: intOf(summary.active),
        cooling: intOf(summary.cooling),
      }
    } catch (error) {
      return { ...empty, health: { state: 'degraded', detail: `读取账号运行时失败：${detailOf(error)}` } }
    }
  }

  private observeAudit(nowMs: number): AuditView {
    const limit = this.config.auditWindowLimit
    const empty: AuditView = {
      health: { state: 'unavailable', detail: '审计插件未运行：看不到最近动作' },
      total: 0,
      failed: 0,
      lastAt: null,
      recentActions: [],
      windowLimit: limit,
      windowTruncated: false,
      latest: [],
    }
    const audit = this.seam<AuditSeam>('audit', ['list', 'stats'])
    if (audit === undefined) return empty
    try {
      const stats = audit.stats(OBSERVABILITY_ACTOR)
      const window = audit.list(OBSERVABILITY_ACTOR, {
        limit,
        offset: 0,
        fromMs: nowMs - DAY_MS,
        toMs: nowMs + 1,
      })
      const counts = new Map<string, number>()
      for (const item of window.items) {
        const action = textOf(item.action)
        if (action === '') continue
        counts.set(action, (counts.get(action) ?? 0) + 1)
      }
      const recent = audit.list(OBSERVABILITY_ACTOR, { limit: RECENT_AUDIT_LIMIT, offset: 0 })
      return {
        health: { state: 'ok', detail: '' },
        total: intOf(stats.total),
        failed: intOf(stats.failed),
        lastAt: nullableTextOf(stats.lastAt),
        recentActions: [...counts.entries()]
          .map(([action, count]) => ({ action, count }))
          .sort((a, b) => b.count - a.count || a.action.localeCompare(b.action)),
        windowLimit: limit,
        windowTruncated: window.items.length >= limit,
        latest: recent.items.map(auditItemOf),
      }
    } catch (error) {
      return { ...empty, health: { state: 'degraded', detail: `读取审计失败：${detailOf(error)}` } }
    }
  }

  private observeAccounts(): AccountsView {
    const empty: AccountsView = {
      health: { state: 'unavailable', detail: '账号服务未运行：看不到账号池健康分布' },
      total: 0,
      enabled: 0,
      unknown: 0,
      healthy: 0,
      degraded: 0,
      unhealthy: 0,
      autoDisabled: 0,
      lastPass: null,
      lastPassAt: null,
      running: null,
    }

    // account-health 只暴露「上一轮检查结果」，不暴露四态分布；分布从只读门面数出来。
    const health = this.seam<AccountHealthSeam>('accountHealth', ['status'])
    let lastPass: AccountsView['lastPass'] = null
    let lastPassAt: string | null = null
    let running: boolean | null = null
    if (health !== undefined) {
      try {
        const status = health.status()
        running = status.running === true
        lastPassAt = nullableTextOf(status.lastPassAt)
        const pass = status.lastPass
        lastPass =
          pass === null
            ? null
            : {
                checked: intOf(pass.checked),
                healthy: intOf(pass.healthy),
                failed: intOf(pass.failed),
                autoDisabled: Array.isArray(pass.autoDisabled) ? pass.autoDisabled.length : 0,
                autoEnabled: Array.isArray(pass.autoEnabled) ? pass.autoEnabled.length : 0,
              }
      } catch (error) {
        lastPassAt = null
        this.logger.warn(`读取健康检查状态失败（账号分布照常）: ${detailOf(error)}`)
      }
    }

    const accountAdmin = this.seam<AccountAdminSeam>('accountAdmin', ['list'])
    if (accountAdmin === undefined) {
      return {
        ...empty,
        health: {
          state: lastPass === null && running === null ? 'unavailable' : 'degraded',
          detail:
            lastPass === null && running === null
              ? '账号服务与健康检查都未运行：看不到账号池状态'
              : '账号服务未运行：只有最近一轮健康检查结果，没有健康分布',
        },
        lastPass,
        lastPassAt,
        running,
      }
    }

    try {
      const accounts = accountAdmin.list()
      const view: AccountsView = { ...empty, health: { state: 'ok', detail: '' }, lastPass, lastPassAt, running }
      const counted = {
        total: 0,
        enabled: 0,
        unknown: 0,
        healthy: 0,
        degraded: 0,
        unhealthy: 0,
        autoDisabled: 0,
      }
      for (const account of accounts) {
        counted.total += 1
        if (account.enabled !== false) counted.enabled += 1
        if (account.status === 'auto_disabled') counted.autoDisabled += 1
        const healthValue = textOf(account.health)
        if (healthValue === 'healthy') counted.healthy += 1
        else if (healthValue === 'degraded') counted.degraded += 1
        else if (healthValue === 'unhealthy') counted.unhealthy += 1
        else counted.unknown += 1
      }
      return { ...view, ...counted }
    } catch (error) {
      return {
        ...empty,
        health: { state: 'degraded', detail: `读取账号列表失败：${detailOf(error)}` },
        lastPass,
        lastPassAt,
        running,
      }
    }
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  /**
   * 运行期取服务（不 inject，D5）：fiber 不是 ACTIVE 一律当作不可用，
   * 并要求调用方列出的方法全部存在，避免拿到半截实例。
   */
  private seam<T>(name: string, methods: readonly string[]): T | undefined {
    const impl = this.ctx.root.reflect._getImpl(name, false)
    if (impl === undefined || impl.ctx.fiber.state !== FiberState.ACTIVE) return undefined
    const value = impl.value
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
    for (const method of methods) {
      if (typeof (value as Record<string, unknown>)[method] !== 'function') return undefined
    }
    return value as T
  }
}

// ───────────────────────────────── 纯函数 ─────────────────────────────────

function warningsOf(parts: {
  usage: UsageChainView
  billing: BillingView
  quota: QuotaView
  runtime: RuntimeView
  audit: AuditView
  accounts: AccountsView
}): string[] {
  const warnings: string[] = []
  if (parts.usage.service !== null && parts.usage.service.gapRecords > 0) warnings.push('USAGE_GAP')
  if (parts.usage.service !== null && parts.usage.service.consecutiveFailures > 0) {
    warnings.push('USAGE_POLL_FAILING')
  }
  if (parts.usage.service !== null && parts.usage.service.rejectedPending > 0) {
    warnings.push('USAGE_REJECTED_PENDING')
  }
  if (parts.usage.gateway !== null && parts.usage.gateway.dropped > 0) warnings.push('USAGE_RING_DROPPED')
  if (parts.billing.totals !== null && parts.billing.totals.review > 0) warnings.push('BILLING_REVIEW')
  if (parts.billing.totals !== null && parts.billing.totals.failed > 0) warnings.push('BILLING_FAILED')
  if (parts.billing.totals !== null && parts.billing.totals.overdrawn > 0) warnings.push('BILLING_OVERDRAWN')
  if (parts.quota.stale === true) warnings.push('QUOTA_SNAPSHOT_STALE')
  if (parts.runtime.cooling !== null && parts.runtime.cooling > 0) warnings.push('ACCOUNTS_COOLING')
  if (parts.audit.failed > 0) warnings.push('AUDIT_FAILED_ACTIONS')
  if (parts.accounts.unhealthy > 0) warnings.push('ACCOUNTS_UNHEALTHY')
  if (parts.accounts.autoDisabled > 0) warnings.push('ACCOUNTS_AUTO_DISABLED')
  return warnings
}

function auditItemOf(item: AuditRecordSeam): AuditItemView {
  return {
    at: textOf(item.at),
    actor: textOf(item.actor),
    action: textOf(item.action),
    targetType: textOf(item.targetType),
    targetId: textOf(item.targetId),
    summary: textOf(item.summary),
    result: item.result === 'failed' ? 'failed' : 'ok',
    errorCode: nullableTextOf(item.errorCode),
  }
}

/** 今天的桶：billing 的 `daily` 按请求发生日（UTC）分，取与今天相同的那一条。 */
function todayPointOf(
  daily: readonly DailyPointSeam[],
  nowMs: number,
): BillingView['today'] {
  const day = new Date(nowMs).toISOString().slice(0, 10)
  const point = daily.find((item) => item.date === day)
  if (point === undefined) return { date: day, settled: 0, chargedMicros: '0' }
  return {
    date: day,
    settled: intOf(point.settled),
    chargedMicros: bigintText(point.chargedMicros),
  }
}

function intOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  if (typeof value === 'bigint') return Number(value < 0n ? 0n : value)
  return 0
}

function bigintText(value: unknown): string {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return '0'
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableTextOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 异常原因压成一行、截断：不把堆栈或超长消息塞进页面。 */
function detailOf(error: unknown): string {
  const text = describeError(error).replace(/\s+/g, ' ').trim()
  return text.length > HEALTH_DETAIL_MAX ? `${text.slice(0, HEALTH_DETAIL_MAX)}…` : text
}
