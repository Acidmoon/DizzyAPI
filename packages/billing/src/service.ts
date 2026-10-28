/**
 * 结算插件（服务名 `billing`）。
 *
 * 定位：**真实扣费的唯一执行者**。`usage` 拉到一轮用量记录后先调 `settle(records)`，
 * 本插件把 token 事实换成整数微元、经 `user.adjustBalance(...)` 扣款，再让 usage 落统计、
 * 推进游标（顺序见 packages/usage/src/service.ts 的 pollOnce）。
 *
 * 三条纪律：
 * - **价格事实归 `pricing`**：不信调用方传来的金额（Go 只传 token），每次都用
 *   `pricing.quote()` 复算；模型没配价 → `no-price` 状态、扣 0、告警，不当免费。
 * - **钱归 `user`**：只提交增量，余额（含负数，后付费）由 user 原子调整。
 * - **幂等靠 `req_id` 唯一键 + CAS**：`pending → settling → settled`；同一笔请求无论重放
 *   多少次只扣一次。跨库（billing.db / users.db）没有事务，所以 `settling` 崩溃残留
 *   靠 reqId 重放收敛：先查余额流水里有没有这笔扣款，有就收尾、没有就留人工核查，
 *   **绝不重复扣费**。
 *
 * 禁用语义（D5）：插件卸载即关闭账本连接（`ctx.effect`），没有定时器、没有 HTTP 路由、
 * 没有桥命令；管理面读接口由 api / web 在运行期解析本服务，缺席只让对应路由 503。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import { describeError, isIssueList } from '@dizzyapi/plugin-kit'
import {
  BILLING_CONFIG_SCHEMA,
  BILLING_DEFAULTS,
  validateBillingConfig,
  type BillingConfig,
  type ResolvedBillingConfig,
} from './config.ts'
import { BillingError } from './errors.ts'
import {
  BillingStore,
  openBillingDatabase,
  toView,
  isSettleStatus,
  type SettleRow,
} from './db.ts'
import {
  BILLING_ACTOR,
  SETTLE_LIST_DEFAULT_LIMIT,
  SETTLE_LIST_MAX_LIMIT,
  type BillingServiceLike,
  type SettleBatchResult,
  type SettleCandidate,
  type SettleDailyPoint,
  type SettleFilter,
  type SettleModelPoint,
  type SettlePage,
  type SettleQuery,
  type SettleSummary,
  type SettleTotals,
} from './types.ts'

const DAY_MS = 86_400_000
/** 汇总里按天展示的窗口长度。 */
const SUMMARY_DAYS = 30
/** 汇总里按模型展示的条数。 */
const SUMMARY_MODELS = 20
/** 崩溃残留核对时翻多少条余额流水（user 侧上限 200）。 */
const LEDGER_SCAN_LIMIT = 200
/** 同一条记录导致「可重试失败」的告警节流（毫秒）。 */
const FAILURE_WARN_INTERVAL_MS = 60_000
const REQUEST_ID_MAX_LENGTH = 200

export class BillingService extends Service implements BillingServiceLike {
  static Config = BILLING_CONFIG_SCHEMA

  /**
   * 两个依赖都是**真的必需**：没有 user 就不能动钱，没有 pricing 就没有价格事实。
   * 缺任一个就停在 PENDING 是正确行为（fail-closed），而不是拿 0 价格偷偷记账。
   * 注意 usage 不 inject 本插件：本插件被禁用时 usage 照常落统计、只是不结算（D5）。
   */
  static inject = ['user', 'pricing'] as const

  static catalog = {
    capabilities: ['billing', 'settlement'],
    events: [],
    bridge: [],
    storage: [
      { key: 'dataPath', kind: 'file', description: 'SQLite 结算账本：reqId 唯一、整数微元、不含余额' },
    ],
    shapes: {
      SettleRecord: {
        description: '一条请求的结算记录（金额已扣，余额变更在 user 的流水里）',
        fields: {
          reqId: { type: 'string' },
          userId: { type: 'integer' },
          accountId: { type: 'string' },
          model: { type: 'string' },
          costMicro: { type: 'string（整数微元）' },
          status: { type: 'string' },
          attempts: { type: 'integer' },
          startedAt: { type: 'string' },
          settledAt: { type: 'string', optional: true },
        },
      },
    },
  } as const

  readonly config: ResolvedBillingConfig
  private readonly logger: Logger
  private readonly adminPlugins: readonly string[]
  private store: BillingStore | undefined
  private ready = false
  private queue: Promise<unknown> = Promise.resolve()
  private lastFailureWarnAt = 0

  constructor(ctx: Context, config: BillingConfig | ResolvedBillingConfig = {}) {
    super(ctx, 'billing')
    const resolved = validateBillingConfig(config)
    if (isIssueList(resolved)) {
      throw new BillingError(
        'BILLING_CONFIG_INVALID',
        `结算插件配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = {
      dataPath: resolved.dataPath ?? BILLING_DEFAULTS.dataPath,
      adminPlugins: resolved.adminPlugins,
    }
    this.adminPlugins = this.config.adminPlugins
    this.logger = ctx.logger('billing')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    const db = openBillingDatabase(resolveDataPath(this.ctx, this.config.dataPath))
    this.store = new BillingStore(db)
    this.ready = true
    this.logger.info(
      `结算插件已装载：账本 ${this.config.dataPath ?? ':memory:'}；` +
        `扣费调用方 ${BILLING_ACTOR}；管理面读权限 ${this.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (this.adminPlugins.length === 0) {
      this.logger.warn('adminPlugins 为空：当前没有任何插件可以读结算记录（默认拒绝）')
    }

    // 注册即副作用：插件卸载时账本连接跟着关闭（AGENTS.md D5）。
    this.ctx.effect(() => () => this.close(), 'billing.store')

    yield () => {
      this.ready = false
    }
  }

  // ───────────────────────────────── 写：结算 ─────────────────────────────────

  /**
   * 结算一批用量记录。
   *
   * 幂等：同一 `requestId` 重复传入只扣一次（已结算的跳过、残留的按余额流水核对）。
   * 只有**可重试**的失败（余额写入抛了未知错误、账本写不进去）才抛出——抛出会让
   * usage 不落库、不推进游标，下一轮重放。其余业务结果（无价、无用户、配置性拒绝）
   * 都落成终态，不阻塞整条链路。
   */
  async settle(records: readonly SettleCandidate[]): Promise<SettleBatchResult> {
    this.assertReady()
    if (!Array.isArray(records)) {
      throw new BillingError('BILLING_INPUT_INVALID', '结算入参必须是记录数组')
    }
    const candidates = records.map((item) => normalizeCandidate(item))
    return this.exclusive(async () => this.settleBatch(candidates))
  }

  // ───────────────────────────────── 读：管理面 ─────────────────────────────────

  /** 结算记录分页；`status: 'problem'` 一次拿到失败 / 待核查 / 结算中残留。 */
  list(actor: string, query: SettleQuery = {}): SettlePage {
    this.assertAdmin(actor)
    const store = this.requireStore()
    const limit = clampInteger(query.limit, SETTLE_LIST_DEFAULT_LIMIT, 1, SETTLE_LIST_MAX_LIMIT)
    const offset = clampInteger(query.offset, 0, 0, 10_000_000)
    const filter = normalizeFilter(query.status)
    const items = store.list(filter, limit, offset).map(toView)
    return { items, total: store.count(filter) }
  }

  /** 汇总：按状态计数、累计与今日扣费、按天与按模型。 */
  summary(actor: string, nowMs: number = Date.now()): SettleSummary {
    this.assertAdmin(actor)
    const store = this.requireStore()
    const totalsRow = store.totals()
    const today = utcDay(nowMs)
    const fromDay = utcDay(nowMs - (SUMMARY_DAYS - 1) * DAY_MS)
    const totals: SettleTotals = {
      records: safeCount(totalsRow.records),
      settled: safeCount(totalsRow.settled),
      noPrice: safeCount(totalsRow.no_price),
      noUser: safeCount(totalsRow.no_user),
      failed: safeCount(totalsRow.failed),
      review: safeCount(totalsRow.review),
      settling: safeCount(totalsRow.settling),
      overdrawn: safeCount(totalsRow.overdrawn),
      chargedMicros: totalsRow.charged,
      todayChargedMicros: store.chargedOnDay(today),
    }
    const daily: SettleDailyPoint[] = store.daily(fromDay).map((row) => ({
      date: row.day,
      records: safeCount(row.records),
      settled: safeCount(row.settled),
      chargedMicros: row.charged,
    }))
    const models: SettleModelPoint[] = store.models(SUMMARY_MODELS).map((row) => ({
      model: row.model,
      records: safeCount(row.records),
      chargedMicros: row.charged,
    }))
    return { totals, daily, models }
  }

  // ───────────────────────────────── 内部：结算过程 ─────────────────────────────────

  private async settleBatch(records: readonly SettleCandidate[]): Promise<SettleBatchResult> {
    const store = this.requireStore()
    const now = new Date().toISOString()
    let settled = 0
    let noPrice = 0
    let noUser = 0
    let failed = 0
    let review = 0
    let skipped = 0
    let chargedMicros = 0n

    for (const candidate of records) {
      const reqId = candidate.requestId
      const existing = store.find(reqId)

      if (existing !== undefined && existing.status === 'settling') {
        // 崩溃残留：先看余额流水里有没有这笔扣款，绝不盲目重扣。
        const resolution = await this.resolveResidue(existing)
        if (resolution.kind === 'settled') {
          const overdrawn = resolution.balanceAfter < 0n
          store.markSettled(
            reqId,
            existing.cost_micro,
            '残留结算收尾：余额流水里已能找到这笔扣款，未重复扣费',
            now,
            overdrawn,
            resolution.balanceAfter,
          )
          settled += 1
          chargedMicros += existing.cost_micro
        } else {
          store.finish(
            reqId,
            'review',
            existing.cost_micro,
            '残留结算：无法从余额流水确认是否已扣款，需人工核查（未重复扣费）',
            now,
            ['settling'],
          )
          review += 1
          this.logger.warn(
            `请求 ${reqId} 停在 settling 且余额流水里找不到扣款记录：已转 review，请人工核查`,
          )
        }
        continue
      }

      if (existing !== undefined && isTerminal(existing.status)) {
        skipped += 1
        continue
      }

      if (existing === undefined) {
        store.insertPending(candidate, utcDayOf(candidate.startedAt), candidate.startedAt, now)
      }

      if (!this.hasPrice(candidate.model)) {
        store.finish(reqId, 'no-price', 0n, '模型没有配置价格：按 0 结算，未动余额', now, ['pending', 'failed'])
        noPrice += 1
        this.logger.warn(`模型 ${JSON.stringify(candidate.model)} 没有价格：请求 ${reqId} 按 no-price 结算（扣 0）`)
        continue
      }

      const userId = Number(candidate.userId)
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        store.finish(reqId, 'no-user', 0n, '用量记录没有用户 id：未扣款', now, ['pending', 'failed'])
        noUser += 1
        this.logger.warn(`请求 ${reqId} 没有用户 id，无法扣费：已记 no-user`)
        continue
      }

      const costMicros = this.quote(candidate)
      if (costMicros === 0n) {
        store.finish(reqId, 'settled', 0n, '费用为 0（没有可计费 token）：未动余额', now, ['pending', 'failed'])
        settled += 1
        continue
      }

      if (!store.claim(reqId, costMicros, now)) {
        // 另一轮已经抢到（正常路径不会发生：settle 在进程内串行）。
        skipped += 1
        continue
      }

      let balance: bigint
      try {
        balance = await this.ctx.user.adjustBalance(BILLING_ACTOR, userId, -costMicros, chargeReason(reqId))
      } catch (error) {
        const code = errorCodeOf(error)
        if (code === 'USER_NOT_FOUND') {
          store.finish(reqId, 'no-user', 0n, '用户已不存在：未扣款', now, ['settling'])
          noUser += 1
          continue
        }
        if (code === 'USER_ACTOR_FORBIDDEN') {
          // 配置性拒绝：重试不会自己变好，但也不能静默当免费——落 failed 供管理面看见。
          store.finish(
            reqId,
            'failed',
            0n,
            `余额写入被拒绝（检查 user.balanceWriters 是否含 ${BILLING_ACTOR}）：${describeError(error)}`,
            now,
            ['settling'],
          )
          failed += 1
          this.warnFailure(`余额写入被拒绝：${describeError(error)}`)
          continue
        }
        // 可重试：把这笔退回 pending，整轮抛出 → usage 不落库、不推进游标，下一轮重放。
        store.finish(reqId, 'pending', 0n, `扣费失败，等待重试：${describeError(error)}`, now, ['settling'])
        throw new BillingError('BILLING_SETTLE_FAILED', `结算失败（请求 ${reqId}）：${describeError(error)}`)
      }

      // 余额允许为负（后付费）：扣成负数不算失败，但要留成稳定事实供管理面查。
      const overdrawn = balance < 0n
      const note = overdrawn ? `余额不足：扣费后余额 ${balance} 微元（后付费允许为负）` : null
      if (!store.markSettled(reqId, costMicros, note, now, overdrawn, balance)) {
        // 理论上不可能：进程内只有本插件写账本，且这一轮已串行化。钱已扣，行留在 settling，
        // 下一轮按 reqId + 余额流水重放收敛，不会重复扣费。
        this.logger.error(`请求 ${reqId} 已扣费但未能标记为已结算：下一轮会按流水核对（不会重复扣费）`)
        failed += 1
        continue
      }
      if (overdrawn) {
        this.warnFailure(`用户 #${userId} 扣费后余额为负（${balance} 微元）：已按透支记账，见 /admin/billing`)
      }
      settled += 1
      chargedMicros += costMicros
    }

    return { records: records.length, settled, noPrice, noUser, failed, review, skipped, chargedMicros }
  }

  /**
   * 残留核对：查该用户最近的余额流水里有没有这笔扣款（reason 以 `结算 <reqId>` 开头）。
   *
   * 这是唯一能跨库判断「钱到底扣了没有」的事实来源。查不到（或流水读不出来）一律
   * 判 review：宁可少收一笔留人工核查，也绝不重复扣款。
   */
  private async resolveResidue(
    row: SettleRow,
  ): Promise<{ kind: 'settled'; balanceAfter: bigint } | { kind: 'review' }> {
    const marker = chargeReason(row.req_id)
    try {
      const entries = await this.ctx.user.listBalanceEntries(Number(row.user_id), LEDGER_SCAN_LIMIT)
      const hit = entries.find(
        (entry) => typeof entry.reason === 'string' && entry.reason.startsWith(marker),
      )
      // 流水里带着扣款后的余额：顺手把「是否透支」也补回账本。
      return hit === undefined ? { kind: 'review' } : { kind: 'settled', balanceAfter: hit.balanceAfter }
    } catch (error) {
      this.logger.warn(`读取余额流水失败，残留结算转人工核查：${describeError(error)}`)
      return { kind: 'review' }
    }
  }

  /** 模型有没有价格（含 `'*'` 兜底）。价格事实只问 pricing。 */
  private hasPrice(model: string): boolean {
    if (typeof model !== 'string' || model.trim() === '') return false
    const pricing = this.ctx.pricing
    try {
      return pricing.get(model) !== null || pricing.get('*') !== null
    } catch (error) {
      // 价格表拒绝这个模型名（空 / 超长 / 控制字符）：它不可能算出价，判 no-price。
      // 这里绝不能抛错——一笔坏模型名不该把整条用量链路堵死（游标会一直不动）。
      if (errorCodeOf(error) === 'PRICING_MODEL_INVALID') return false
      throw new BillingError('BILLING_PRICE_INVALID', `读取价格表失败：${describeError(error)}`)
    }
  }

  /** 用 pricing 的当前价格复算应扣微元；返回非整数一律明确失败（fail-closed）。 */
  private quote(candidate: SettleCandidate): bigint {
    let raw: string
    try {
      raw = this.ctx.pricing.quote(candidate.model, {
        inputTokens: candidate.inputTokens,
        outputTokens: candidate.outputTokens,
        cacheReadTokens: candidate.cacheReadTokens,
        cacheWriteTokens: candidate.cacheWriteTokens,
      })
    } catch (error) {
      throw new BillingError('BILLING_PRICE_INVALID', `算价失败（请求 ${candidate.requestId}）：${describeError(error)}`)
    }
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw new BillingError('BILLING_PRICE_INVALID', `价格服务返回的金额不合法：${String(raw)}`)
    }
    return BigInt(raw)
  }

  // ───────────────────────────────── 内部：杂项 ─────────────────────────────────

  private assertAdmin(actor: string): void {
    const name = typeof actor === 'string' ? actor.trim() : ''
    if (name === '' || !this.adminPlugins.includes(name)) {
      throw new BillingError(
        'BILLING_ACTOR_FORBIDDEN',
        `插件 ${name || '(空)'} 不在结算记录读取白名单里（当前：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }

  private requireStore(): BillingStore {
    if (this.store === undefined) {
      throw new BillingError('BILLING_NOT_READY', '结算插件尚未装载完成')
    }
    return this.store
  }

  private assertReady(): void {
    if (!this.ready) throw new BillingError('BILLING_NOT_READY', '结算插件尚未装载完成')
  }

  /** 串行执行：同一时刻只有一轮结算在进行，跨轮的 requeue / 重放由此不会互相穿插。 */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private warnFailure(message: string): void {
    const now = Date.now()
    if (now - this.lastFailureWarnAt < FAILURE_WARN_INTERVAL_MS) return
    this.lastFailureWarnAt = now
    this.logger.warn(message)
  }

  private close(): void {
    this.ready = false
    const store = this.store
    this.store = undefined
    store?.close()
  }
}

// ───────────────────────────────── 纯函数 ─────────────────────────────────

/** 记在余额流水里的原因；残留核对靠它辨认同一笔请求。 */
function chargeReason(reqId: string): string {
  return `结算 ${reqId}`
}

function isTerminal(status: string): boolean {
  return status === 'settled' || status === 'no-price' || status === 'no-user' || status === 'review'
}

function normalizeCandidate(value: SettleCandidate): SettleCandidate {
  if (typeof value !== 'object' || value === null) {
    throw new BillingError('BILLING_INPUT_INVALID', '结算记录必须是对象')
  }
  const requestId = typeof value.requestId === 'string' ? value.requestId.trim() : ''
  if (requestId === '' || requestId.length > REQUEST_ID_MAX_LENGTH) {
    throw new BillingError('BILLING_INPUT_INVALID', '结算记录缺少合法的 requestId')
  }
  if (typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) {
    throw new BillingError('BILLING_INPUT_INVALID', `结算记录的时间不合法：${String(value.startedAt)}`)
  }
  // 用户 id 缺失不算入参错误：落一行 user_id=0，随后按 no-user 结算（一笔坏记录
  // 不能把整条用量链路堵死——游标会一直不动）。
  return {
    requestId,
    userId: typeof value.userId === 'string' ? value.userId.trim() : '',
    accountId: textOf(value.accountId),
    model: textOf(value.model),
    inputTokens: countOf(value.inputTokens),
    outputTokens: countOf(value.outputTokens),
    cacheReadTokens: countOf(value.cacheReadTokens),
    cacheWriteTokens: countOf(value.cacheWriteTokens),
    startedAt: value.startedAt,
  }
}

function normalizeFilter(value: SettleFilter | undefined): SettleFilter | undefined {
  if (value === undefined) return undefined
  if (value === 'problem' || isSettleStatus(value)) return value
  throw new BillingError('BILLING_INPUT_INVALID', `未知的结算状态：${String(value)}`)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function countOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value))
  return 0
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function utcDayOf(iso: string): string {
  return new Date(Date.parse(iso)).toISOString().slice(0, 10)
}

function safeCount(value: bigint): number {
  if (value < 0n) return 0
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  return Number(value)
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === '' || path === ':memory:' || isAbsolute(path)) {
    return path === '' ? undefined : path
  }
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}
