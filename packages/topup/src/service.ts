/**
 * 充值订单插件（服务名 `topup`）。
 *
 * 定位：**充值订单的唯一写者**。订单落 `data/topup.db`；到账只经
 * `user.adjustBalance(TOPUP_ACTOR, userId, +micros, reason)`——`user` 是余额唯一写者。
 *
 * 三条纪律：
 * - **金额一律整数微元**：入口只接受「元」的十进制字符串，这里用 BigInt 换算，
 *   绝不经过浮点；范围由配置 `minAmountYuan` / `maxAmountYuan` 约束。
 * - **幂等靠 CAS**：`pending → paid` 条件更新抢占，重复确认 / 并发确认只有一次能加钱；
 *   加余额失败把订单退回 `pending`（钱没到账，可以重试）。
 * - **支付通道只留 seam**：本批只有 `manual`（人工确认），不挂任何未验签的回调路由；
 *   接渠道时在 `providers.ts` 的 `verifyCallback` 里补验签与金额核对。
 *
 * 禁用语义（D5）：卸载即关库 + 停过期清扫定时器（都挂 `ctx.effect`）；没有 HTTP 路由、
 * 没有桥命令；管理面 / 用户面由 api / web 运行期解析本服务，缺席只让对应路由 503。
 */
import { randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import { describeError, isIssueList } from '@dizzyapi/plugin-kit'
import {
  TOPUP_CONFIG_SCHEMA,
  TOPUP_DEFAULTS,
  validateTopupConfig,
  type ResolvedTopupConfig,
  type TopupConfig,
} from './config.ts'
import { TopupError } from './errors.ts'
import { MICROS_PER_YUAN, formatMicrosAsYuan, parseYuanToMicros } from './money.ts'
import { findProvider, type ChargeResult, type PaymentOrderRef, type PaymentProvider } from './providers.ts'
import { providerIds } from './providers.ts'
import { TopupStore, isOrderStatus, openTopupDatabase, toView, type NewOrder } from './db.ts'
import {
  TOPUP_ACTOR,
  TOPUP_LIST_DEFAULT_LIMIT,
  TOPUP_LIST_MAX_LIMIT,
  TOPUP_NOTE_MAX_LENGTH,
  type ConfirmTopupResult,
  type CreateTopupOrderInput,
  type CreateTopupOrderResult,
  type TopupOrderPage,
  type TopupOrderQuery,
  type TopupOrderStatus,
  type TopupOrderView,
  type TopupOptions,
  type TopupServiceLike,
  type TopupStats,
} from './types.ts'

/** 过期清扫间隔：订单有效期以分钟计，60 秒一扫足够，也不会造成无谓写。 */
const EXPIRE_SWEEP_MS = 60_000
/** 订单号撞车时的重试次数（8 位十六进制随机 + 秒级时间戳，正常一次就过）。 */
const ORDER_NO_RETRY = 5

export class TopupService extends Service implements TopupServiceLike {
  static Config = TOPUP_CONFIG_SCHEMA

  /**
   * 只 inject `user`：它是余额唯一写者。`settings` / `admin` 等都不需要，
   * 管理面权限由 `adminPlugins` 白名单判断（调用方自报 actor）。
   */
  static inject = ['user'] as const

  static catalog = {
    capabilities: ['topup-orders', 'manual-settlement', 'payment-provider-seam'],
    events: [],
    bridge: [],
    storage: [
      { key: 'dataPath', kind: 'file', description: 'SQLite 充值订单库（金额整数微元，不含支付凭据）' },
    ],
    shapes: {
      TopupOrder: {
        description: '一笔充值订单；到账只经 user.adjustBalance，状态是稳定英文串',
        fields: {
          orderNo: { type: 'string' },
          userId: { type: 'integer' },
          amountMicro: { type: 'string（整数微元）' },
          status: { type: 'string' },
          provider: { type: 'string' },
          providerOrderId: { type: 'string', optional: true },
          createdAt: { type: 'string' },
          expiresAt: { type: 'string' },
          paidAt: { type: 'string', optional: true },
          canceledAt: { type: 'string', optional: true },
        },
      },
    },
  } as const

  readonly config: ResolvedTopupConfig
  private readonly logger: Logger
  private readonly adminPlugins: readonly string[]
  private readonly provider: PaymentProvider
  private store: TopupStore | undefined
  private ready = false
  private sweepTimer: NodeJS.Timeout | undefined

  constructor(ctx: Context, config: TopupConfig | ResolvedTopupConfig = {}) {
    super(ctx, 'topup')
    const resolved = validateTopupConfig(config)
    if (isIssueList(resolved)) {
      throw new TopupError(
        'TOPUP_CONFIG_INVALID',
        `充值订单插件配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.adminPlugins = resolved.adminPlugins
    this.logger = ctx.logger('topup')
    // 配置已经校验过 id；这里再取一次实例，取不到就是代码与配置漂移，明确失败。
    const provider = findProvider(resolved.provider)
    if (provider === undefined) {
      throw new TopupError(
        'TOPUP_PROVIDER_UNKNOWN',
        `支付通道未注册：${resolved.provider}（已知：${providerIds().join(' / ')}）`,
      )
    }
    this.provider = provider
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    const db = openTopupDatabase(resolveDataPath(this.ctx, this.config.dataPath))
    this.store = new TopupStore(db)
    this.ready = true

    // 启动先扫一遍过期订单，避免「重启前就该过期」的订单一直显示待确认。
    this.expireDue()
    this.sweepTimer = setInterval(() => {
      try {
        this.expireDue()
      } catch (error) {
        this.logger.warn(`过期订单清扫失败：${describeError(error)}`)
      }
    }, EXPIRE_SWEEP_MS)
    this.sweepTimer.unref()

    this.logger.info(
      `充值订单插件已装载：存储 ${this.config.dataPath ?? ':memory:'}；` +
        `支付通道 ${this.provider.id}（${this.provider.online ? '在线' : '仅人工确认'}）；` +
        `金额范围 ¥${this.config.minAmountYuan} ~ ¥${this.config.maxAmountYuan}；` +
        `有效期 ${this.config.expiresMinutes} 分钟；管理面写者 ${this.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (this.adminPlugins.length === 0) {
      this.logger.warn('adminPlugins 为空：当前没有任何插件可以确认到账 / 取消订单')
    }

    // 注册即副作用：插件卸载时定时器与数据库连接一起回收（AGENTS.md D5）。
    this.ctx.effect(() => () => this.close(), 'topup.store')

    yield () => {
      this.ready = false
    }
  }

  // ───────────────────────────────── 用户面 ─────────────────────────────────

  /**
   * 创建订单：先向 provider 要「怎么付」的说明，再落一行 `pending`。
   *
   * provider 失败时**不落订单**（不留下一个没有支付说明的待确认单）。
   * 订单号撞车（并发创建）换号重试，靠 `order_no` 主键收敛。
   */
  async createOrder(input: CreateTopupOrderInput): Promise<CreateTopupOrderResult> {
    this.assertReady()
    const store = this.requireStore()
    const userId = normalizeUserId(input?.userId)
    const amountMicro = this.normalizeAmount(input?.amountYuan)
    const provider = this.providerFor(input?.provider)
    const note = normalizeNote(input?.note)

    const now = new Date()
    const createdAt = now.toISOString()
    const expiresAt = new Date(now.getTime() + this.config.expiresMinutes * 60_000).toISOString()

    for (let attempt = 0; attempt < ORDER_NO_RETRY; attempt += 1) {
      const orderNo = newOrderNo(now)
      const ref: PaymentOrderRef = {
        orderNo,
        userId,
        amountMicro,
        currency: 'CNY',
        createdAt,
        expiresAt,
      }
      let charge: ChargeResult
      try {
        charge = await provider.createCharge(ref)
      } catch (error) {
        this.logger.warn(`支付通道 ${provider.id} 创建支付失败：${describeError(error)}`)
        throw new TopupError('TOPUP_PROVIDER_FAILED', `创建支付失败：${describeError(error)}`)
      }

      const order: NewOrder = {
        orderNo,
        userId,
        amountMicro,
        provider: provider.id,
        instructions: charge.instructions,
        note,
        createdAt,
        expiresAt,
      }
      try {
        store.insert(order)
      } catch (error) {
        if (isUniqueViolation(error)) continue
        throw new TopupError('TOPUP_STORE_FAILED', `订单写入失败：${describeError(error)}`)
      }
      if (charge.providerOrderId !== null) {
        store.setProviderOrderId(orderNo, charge.providerOrderId, now.toISOString())
      }
      this.logger.info(`充值订单已创建：${orderNo} 用户 #${userId} ¥${formatMicrosAsYuan(amountMicro)}`)
      return { order: this.viewOf(orderNo) }
    }
    throw new TopupError('TOPUP_STORE_FAILED', '订单号连续撞车：请稍后重试')
  }

  listMine(userId: number, limit?: number): TopupOrderPage {
    this.assertReady()
    const uid = normalizeUserId(userId)
    const take = clampLimit(limit, TOPUP_LIST_DEFAULT_LIMIT, TOPUP_LIST_MAX_LIMIT)
    // 顺手把到期的 pending 刷成 expired：页面看到的「还能不能付」与数据库一致。
    this.expireDue()
    const store = this.requireStore()
    const items = store.listForUser(uid, take, 0).map((row) => toView(row, this.labelOf(row.provider)))
    return { items, total: store.countForUser(uid) }
  }

  /** 单笔（只能看自己的）：不存在与不是自己的都回 `TOPUP_ORDER_NOT_FOUND`，不泄露存在性。 */
  getMine(userId: number, orderNo: string): TopupOrderView {
    this.assertReady()
    const uid = normalizeUserId(userId)
    const key = normalizeOrderNo(orderNo)
    const row = this.requireStore().find(key)
    if (row === undefined || Number(row.user_id) !== uid) {
      throw new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
    }
    return toView(row, this.labelOf(row.provider))
  }

  /** 取消自己的 pending 订单；已取消是幂等成功，已到账 / 已过期明确拒绝。 */
  cancelMine(userId: number, orderNo: string): TopupOrderView {
    this.assertReady()
    const uid = normalizeUserId(userId)
    const key = normalizeOrderNo(orderNo)
    const store = this.requireStore()
    const row = store.find(key)
    if (row === undefined || Number(row.user_id) !== uid) {
      throw new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
    }
    if (row.status === 'pending') {
      if (store.cancelForUser(uid, key, new Date().toISOString())) {
        this.logger.info(`充值订单已由用户取消：${key}`)
        return this.viewOf(key)
      }
      return this.requireViewAfterRace(key)
    }
    if (row.status === 'canceled') return this.viewOf(key)
    throw this.stateError(key, row.status)
  }

  // ───────────────────────────────── 管理面 ─────────────────────────────────

  list(actor: string, query: TopupOrderQuery = {}): TopupOrderPage {
    this.assertAdmin(actor)
    const store = this.requireStore()
    const filter: { status?: TopupOrderStatus; userId?: number; fromMs?: number; toMs?: number } = {}
    if (query.status !== undefined) {
      if (!isOrderStatus(query.status)) {
        throw new TopupError('TOPUP_INPUT_INVALID', `未知的订单状态：${String(query.status)}`)
      }
      filter.status = query.status
    }
    if (query.userId !== undefined) filter.userId = normalizeUserId(query.userId)
    if (query.fromMs !== undefined) filter.fromMs = normalizeMs(query.fromMs, 'fromMs')
    if (query.toMs !== undefined) filter.toMs = normalizeMs(query.toMs, 'toMs')
    const limit = clampLimit(query.limit, TOPUP_LIST_DEFAULT_LIMIT, TOPUP_LIST_MAX_LIMIT)
    const offset = clampOffset(query.offset)
    this.expireDue()
    return {
      items: store.list(filter, limit, offset).map((row) => toView(row, this.labelOf(row.provider))),
      total: store.count(filter),
    }
  }

  /**
   * 人工确认到账（管理员）。
   *
   * 幂等：订单已经是 `paid` 时直接返回 `credited: false`，**不会再加一次钱**；
   * 并发确认靠 `pending → paid` 的 CAS，只有一个调用能拿到 `credited: true`。
   * 加余额失败把订单退回 `pending` 并明确报错（钱没到账，可以重试）。
   */
  async confirmPaid(actor: string, orderNo: string): Promise<ConfirmTopupResult> {
    this.assertAdmin(actor)
    const key = normalizeOrderNo(orderNo)
    const store = this.requireStore()
    const row = store.find(key)
    if (row === undefined) throw new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
    if (row.status === 'paid') {
      return { order: this.viewOf(key), credited: false }
    }
    if (row.status !== 'pending') throw this.stateError(key, row.status)

    const now = new Date().toISOString()
    if (row.expires_at <= now) {
      this.expireDue()
      throw new TopupError('TOPUP_ORDER_STATE', `订单已过期（${row.expires_at}），不能确认到账`)
    }
    const userId = Number(row.user_id)
    const amountMicro = row.amount_micro
    if (!store.claimPaid(key, now)) {
      // 并发：另一个确认抢到了，或者刚好过期 / 被取消。
      const latest = store.find(key)
      if (latest !== undefined && latest.status === 'paid') {
        return { order: this.viewOf(key), credited: false }
      }
      throw latest === undefined
        ? new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
        : this.stateError(key, latest.status)
    }

    try {
      await this.ctx.user.adjustBalance(
        TOPUP_ACTOR,
        userId,
        amountMicro,
        `充值到账 ${key}`,
      )
    } catch (error) {
      // 钱没到账：把订单退回 pending，允许再次确认（不会重复加钱）。
      store.releasePaid(key, new Date().toISOString())
      this.logger.warn(`充值订单 ${key} 加余额失败，已退回待确认：${describeError(error)}`)
      throw new TopupError(
        'TOPUP_BALANCE_FAILED',
        `加余额失败，订单已退回待确认：${describeError(error)}`,
      )
    }

    this.logger.info(
      `充值订单已到账：${key} 用户 #${userId} ¥${formatMicrosAsYuan(amountMicro)}（操作方 ${actor}）`,
    )
    return { order: this.viewOf(key), credited: true }
  }

  /** 取消订单（管理员）：pending → canceled；已取消幂等，已到账 / 已过期明确拒绝。 */
  cancel(actor: string, orderNo: string): TopupOrderView {
    this.assertAdmin(actor)
    const key = normalizeOrderNo(orderNo)
    const store = this.requireStore()
    const row = store.find(key)
    if (row === undefined) throw new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
    if (row.status === 'pending') {
      if (store.cancel(key, new Date().toISOString())) {
        this.logger.info(`充值订单已由 ${actor} 取消：${key}`)
        return this.viewOf(key)
      }
      return this.requireViewAfterRace(key)
    }
    if (row.status === 'canceled') return this.viewOf(key)
    throw this.stateError(key, row.status)
  }

  stats(actor: string, nowMs: number = Date.now()): TopupStats {
    this.assertAdmin(actor)
    this.expireDue(nowMs)
    return this.requireStore().stats(nowMs)
  }

  /** 充值选项：金额范围 / 通道 / 说明都来自本插件，页面与 API 共用一份事实。 */
  options(): TopupOptions {
    return {
      currency: 'CNY',
      providerId: this.provider.id,
      providerLabel: this.provider.label,
      online: this.provider.online,
      minAmountMicros: BigInt(this.config.minAmountYuan) * MICROS_PER_YUAN,
      maxAmountMicros: BigInt(this.config.maxAmountYuan) * MICROS_PER_YUAN,
      expiresMinutes: this.config.expiresMinutes,
      notice: this.provider.online
        ? '在线支付已接入，支付完成后自动到账。'
        : '当前仅支持人工确认到账：下单后请联系管理员线下转账，管理员确认后余额自动增加；不会自动到账。',
    }
  }

  /** 把到期的 pending 订单刷成 expired（定时器 / 列表 / 确认前都会调用，幂等）。 */
  expireDue(nowMs: number = Date.now()): number {
    const store = this.store
    if (store === undefined) return 0
    const expired = store.expireDue(new Date(nowMs).toISOString())
    if (expired > 0) this.logger.info(`已把 ${expired} 笔到期充值订单标记为 expired`)
    return expired
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private normalizeAmount(value: unknown): bigint {
    const micros = parseYuanToMicros(value)
    const minMicros = BigInt(this.config.minAmountYuan) * MICROS_PER_YUAN
    const maxMicros = BigInt(this.config.maxAmountYuan) * MICROS_PER_YUAN
    if (micros < minMicros || micros > maxMicros) {
      throw new TopupError(
        'TOPUP_AMOUNT_OUT_OF_RANGE',
        `充值金额必须在 ¥${this.config.minAmountYuan} ~ ¥${this.config.maxAmountYuan} 之间`,
      )
    }
    return micros
  }

  private providerFor(requested: string | undefined): PaymentProvider {
    if (requested === undefined) return this.provider
    const normalized = typeof requested === 'string' ? requested.trim() : ''
    if (normalized === this.provider.id) return this.provider
    if (findProvider(normalized) !== undefined) {
      throw new TopupError(
        'TOPUP_PROVIDER_UNKNOWN',
        `支付通道 ${normalized} 未启用（当前只启用 ${this.provider.id}）`,
      )
    }
    throw new TopupError('TOPUP_PROVIDER_UNKNOWN', `未知的支付通道：${JSON.stringify(requested)}`)
  }

  private labelOf(providerId: string): string {
    const provider = findProvider(providerId)
    return provider?.label ?? providerId
  }

  private viewOf(orderNo: string): TopupOrderView {
    const row = this.requireStore().find(orderNo)
    if (row === undefined) throw new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
    return toView(row, this.labelOf(row.provider))
  }

  /** CAS 失败后重新读一次：拿到最新状态，避免「已经到账却报冲突」。 */
  private requireViewAfterRace(orderNo: string): TopupOrderView {
    const row = this.requireStore().find(orderNo)
    if (row === undefined) throw new TopupError('TOPUP_ORDER_NOT_FOUND', '没有这笔充值订单')
    if (row.status === 'paid' || row.status === 'canceled') return toView(row, this.labelOf(row.provider))
    throw this.stateError(orderNo, row.status)
  }

  private stateError(orderNo: string, status: string): TopupError {
    const text =
      status === 'paid'
        ? '订单已到账，不能取消'
        : status === 'expired'
          ? '订单已过期，不能操作'
          : status === 'canceled'
            ? '订单已取消'
            : `订单当前状态 ${status}，不能执行该操作`
    return new TopupError('TOPUP_ORDER_STATE', `订单 ${orderNo}：${text}`)
  }

  private assertAdmin(actor: string): void {
    const name = typeof actor === 'string' ? actor.trim() : ''
    if (name === '' || !this.adminPlugins.includes(name)) {
      throw new TopupError(
        'TOPUP_ACTOR_FORBIDDEN',
        `插件 ${name || '(空)'} 不在充值订单管理白名单里（当前：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }

  private requireStore(): TopupStore {
    if (this.store === undefined) throw new TopupError('TOPUP_NOT_READY', '充值订单插件尚未装载完成')
    return this.store
  }

  private assertReady(): void {
    if (!this.ready) throw new TopupError('TOPUP_NOT_READY', '充值订单插件尚未装载完成')
  }

  private close(): void {
    this.ready = false
    if (this.sweepTimer !== undefined) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = undefined
    }
    const store = this.store
    this.store = undefined
    store?.close()
  }
}

// ───────────────────────────────── 纯函数 ─────────────────────────────────

/** 订单号：`T` + UTC 时间戳（秒）+ 8 位十六进制随机；给人看、也便于按时间排。 */
function newOrderNo(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  return `T${stamp}${randomBytes(4).toString('hex').toUpperCase()}`
}

function normalizeUserId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TopupError('TOPUP_INPUT_INVALID', `用户 id 不合法：${String(value)}`)
  }
  return value
}

function normalizeOrderNo(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^T[0-9]{14}[0-9A-F]{8}$/.test(text)) {
    throw new TopupError('TOPUP_INPUT_INVALID', '订单号格式不合法')
  }
  return text
}

function normalizeNote(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') {
    throw new TopupError('TOPUP_INPUT_INVALID', '备注必须是字符串')
  }
  const text = value.trim()
  if (text === '') return null
  if (text.length > TOPUP_NOTE_MAX_LENGTH) {
    throw new TopupError('TOPUP_INPUT_INVALID', `备注最长 ${TOPUP_NOTE_MAX_LENGTH} 个字符`)
  }
  // 控制字符会污染页面与日志；换行统一成空格。
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
}

function normalizeMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TopupError('TOPUP_INPUT_INVALID', `${field} 必须是非负毫秒时间戳`)
  }
  return Math.trunc(value)
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}

function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(Math.max(Math.trunc(value), 0), 1_000_000)
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('UNIQUE constraint failed')
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === '' || path === ':memory:' || isAbsolute(path)) {
    return path === '' ? undefined : path
  }
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}
