/**
 * 充值订单的对外形状。
 *
 * 三条事实：
 * - **金额一律 bigint 整数微元**（1 元 = 1_000_000 微元），全程不经过浮点。
 * - 订单只有本插件写；**加余额只经 `user.adjustBalance(...)`**（user 是余额唯一写者）。
 * - 状态是稳定英文字符串：`pending` / `paid` / `canceled` / `expired`。
 */

/** 订单状态机：pending → paid / canceled / expired；paid 是终态（钱已到账）。 */
export type TopupOrderStatus = 'pending' | 'paid' | 'canceled' | 'expired'

/** 一条充值订单（管理面与用户面共用；不含任何支付凭据）。 */
export interface TopupOrderView {
  readonly orderNo: string
  readonly userId: number
  /** 订单金额（整数微元）。 */
  readonly amountMicro: bigint
  readonly status: TopupOrderStatus
  readonly provider: string
  readonly providerLabel: string
  /** 真实渠道才会有的单号；人工确认时为 null。 */
  readonly providerOrderId: string | null
  /** 创建时 provider 给出的人话说明（例如线下转账指引）。 */
  readonly instructions: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly paidAt: string | null
  readonly canceledAt: string | null
}

export interface CreateTopupOrderInput {
  readonly userId: number
  /** 金额（元，十进制字符串，最多 6 位小数）。 */
  readonly amountYuan: unknown
  readonly provider?: string
  readonly note?: string | null
}

export interface CreateTopupOrderResult {
  readonly order: TopupOrderView
}

/** 确认到账的结果：`credited=false` 表示这笔订单此前已经到账（幂等命中）。 */
export interface ConfirmTopupResult {
  readonly order: TopupOrderView
  readonly credited: boolean
}

export interface TopupOrderQuery {
  readonly status?: TopupOrderStatus
  readonly userId?: number
  /** 按创建时间过滤（毫秒时间戳，左闭右开）。 */
  readonly fromMs?: number
  readonly toMs?: number
  readonly limit?: number
  readonly offset?: number
}

export interface TopupOrderPage {
  readonly items: readonly TopupOrderView[]
  readonly total: number
}

export interface TopupStats {
  /** 今日（UTC）已到账笔数与金额。 */
  readonly todayPaidCount: number
  readonly todayPaidMicros: bigint
  readonly totalPaidCount: number
  readonly totalPaidMicros: bigint
  /** 当前待确认（pending）的笔数。 */
  readonly pendingCount: number
  /** 当前已过期（expired）的笔数。 */
  readonly expiredCount: number
}

/** 充值选项（用户页 / `/api/topup/options` 直接用）。 */
export interface TopupOptions {
  readonly currency: 'CNY'
  readonly providerId: string
  readonly providerLabel: string
  readonly online: boolean
  readonly minAmountMicros: bigint
  readonly maxAmountMicros: bigint
  readonly expiresMinutes: number
  readonly notice: string
}

/** 本插件对外的服务面。 */
export interface TopupServiceLike {
  createOrder(input: CreateTopupOrderInput): Promise<CreateTopupOrderResult>
  listMine(userId: number, limit?: number): TopupOrderPage
  getMine(userId: number, orderNo: string): TopupOrderView
  cancelMine(userId: number, orderNo: string): TopupOrderView
  list(actor: string, query?: TopupOrderQuery): TopupOrderPage
  confirmPaid(actor: string, orderNo: string): Promise<ConfirmTopupResult>
  cancel(actor: string, orderNo: string): TopupOrderView
  stats(actor: string, nowMs?: number): TopupStats
  options(): TopupOptions
}

/** 加余额时的调用方名字；同时必须出现在 `user.balanceWriters` 白名单里。 */
export const TOPUP_ACTOR = '@dizzyapi/plugin-topup'

export const TOPUP_LIST_DEFAULT_LIMIT = 20
export const TOPUP_LIST_MAX_LIMIT = 200

/** 备注上限（订单备注只给人看，不参与任何逻辑）。 */
export const TOPUP_NOTE_MAX_LENGTH = 200
