/**
 * 兑换码、充值订单、结算（commerce）。
 *
 * 服务端来源：`views/commerce.ts`（`redeemResultOf` / `redemptionOf` / `redeemBatchOf` /
 * `redeemCodeOf` / `redeemStatsOf` / `topupOrderOf` / `topupOptionsOf` / `topupStatsOf` /
 * `settleRecordOf` / `settleTotalsOf` / `settleDailyOf` / `settleModelOf`）。
 *
 * **金额一律是十进制字符串**：兑换 / 充值 / 结算都把 bigint 转成字符串后发出，
 * 前端只展示与格式化，**不做算术**（要算就 `BigInt`）。
 */

// ───────────────────────────── 兑换码 ─────────────────────────────

/** `POST /api/redeem` 的响应（`redeemResultOf()`）。 */
export interface RedeemResultView {
  /** 这次兑换进账多少（整数微元）。 */
  readonly amountMinor: string
  /** 兑换后的余额（整数微元）。 */
  readonly balanceMinor: string
  /** 批次名；单张码可能没有批次名，服务端给空串。 */
  readonly batchName: string
}

/** `GET /api/redeem` 的一行：我的兑换记录（`redemptionOf()`）。**只有掩码**。 */
export interface RedemptionView {
  readonly codeId: string
  readonly codeMask: string
  readonly amountMinor: string
  readonly batchName: string | null
  readonly redeemedAt: string | null
}

/** `GET /api/admin/redeem-codes` 的一行（`redeemCodeOf()`）。**只有掩码**。 */
export interface RedeemCodeView {
  readonly id: string
  readonly batchId: string
  readonly batchName: string | null
  readonly codeMask: string
  readonly kind: string
  readonly amountMinor: string
  readonly status: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly reservedAt: string | null
  readonly reservedBy: string | null
  readonly redeemedAt: string | null
  readonly redeemedBy: string | null
  readonly disabledBy: string | null
  readonly disabledAt: string | null
}

/** `GET /api/admin/redeem-codes` 的响应。 */
export interface AdminRedeemCodesView {
  readonly items: readonly RedeemCodeView[]
  readonly total: number
}

/** `GET /api/admin/redeem-batches` 的一行（`redeemBatchOf()`）。 */
export interface RedeemBatchView {
  readonly id: string
  readonly name: string
  readonly kind: string
  readonly amountMinor: string
  readonly total: number
  readonly notes: string | null
  readonly createdBy: string
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly codeCount: number
  readonly usedCount: number
}

/** `GET /api/admin/redeem-batches` 的响应。 */
export interface AdminRedeemBatchesView {
  readonly items: readonly RedeemBatchView[]
}

/** `POST /api/admin/redeem-codes`（生成批次）的响应。**`codes` 里是明文码，只此一次。** */
export interface CreatedRedeemBatchView {
  readonly batch: RedeemBatchView
  /** 明文兑换码；**只在这一次响应里出现**，不落任何存储。 */
  readonly codes: readonly string[]
}

/** `DELETE /api/admin/redeem-codes` 的响应（批量删；已用的会被拒）。 */
export interface RedeemDeletionView {
  readonly deleted: number
  readonly rejected: readonly { readonly id: string; readonly reason: string }[]
}

/** `GET /api/admin/redeem-stats` 的响应（`redeemStatsOf()`）。 */
export interface RedeemStatsView {
  readonly batches: number
  readonly codes: number
  readonly enabled: number
  readonly disabled: number
  /** `redeeming` 是 CAS 中间态：崩溃残留要人工核查。 */
  readonly redeeming: number
  readonly used: number
  readonly expired: number
  readonly redeemedAmountMicro: string
}

// ───────────────────────────── 充值订单 ─────────────────────────────

/**
 * 一张充值订单（`topupOrderOf()`）。
 *
 * **本批没有在线支付**：订单是 `pending`，要管理员确认才到账（`provider` 是 `manual`）。
 */
export interface TopupOrderView {
  readonly orderNo: string
  readonly userId: number
  /** 订单金额（整数微元）。 */
  readonly amountMicro: string
  readonly status: string
  readonly provider: string
  readonly providerLabel: string
  readonly providerOrderId: string | null
  /** 线下转账说明（落库，不随配置漂移）。 */
  readonly instructions: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly expiresAt: string
  readonly paidAt: string | null
  readonly canceledAt: string | null
}

/** `GET /api/topup/options` 的响应（`topupOptionsOf()`）。 */
export interface TopupOptionsView {
  readonly currency: 'CNY'
  readonly providerId: string
  readonly providerLabel: string
  /** 当前通道是否在线支付；`manual` 通道是 `false`。 */
  readonly online: boolean
  readonly minAmountMicros: string
  readonly maxAmountMicros: string
  readonly expiresMinutes: number
  readonly notice: string
}

/** `POST /api/topup/orders` 的响应。**下单成功 ≠ 到账**，只代表订单已创建。 */
export interface TopupCreateView {
  readonly order: TopupOrderView
  readonly instructions: string | null
}

/** `GET /api/topup/orders` 的响应（用户自己的订单）。 */
export interface TopupOrderListView {
  readonly items: readonly TopupOrderView[]
  readonly total: number
}

/** `GET /api/admin/topup-orders` 的响应。 */
export type AdminTopupOrderListView = TopupOrderListView

/** `GET /api/admin/topup-orders/stats` 的响应（`topupStatsOf()`）。 */
export interface TopupStatsView {
  readonly todayPaidCount: number
  readonly todayPaidMicros: string
  readonly totalPaidCount: number
  readonly totalPaidMicros: string
  readonly pendingCount: number
  readonly expiredCount: number
}

/** `POST /api/admin/topup-orders/:orderNo/confirm` 的响应。 */
export interface ConfirmTopupView {
  readonly order: TopupOrderView
  /** 这次是否**真的**加了钱；重复确认是 `false`（幂等）。 */
  readonly credited: boolean
}

// ───────────────────────────── 结算（只读） ─────────────────────────────

/** 一条结算记录（`settleRecordOf()`）。 */
export interface SettleRecordView {
  readonly reqId: string
  readonly userId: number
  readonly accountId: string
  readonly model: string
  readonly day: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly costMicro: string
  /** 扣完为负 = 后付费透支。 */
  readonly overdrawn: boolean
  readonly balanceAfter: string | null
  readonly status: string
  readonly note: string | null
  readonly attempts: number
  readonly startedAt: string
  readonly claimedAt: string | null
  readonly settledAt: string | null
  readonly updatedAt: string
}

/** 结算汇总（`settleTotalsOf()`）。 */
export interface SettleTotalsView {
  readonly records: number
  readonly settled: number
  readonly noPrice: number
  readonly noUser: number
  readonly failed: number
  /** 判不出该不该扣：人工核查，**宁可少收一笔也不重复扣**。 */
  readonly review: number
  readonly settling: number
  readonly overdrawn: number
  readonly chargedMicros: string
  readonly todayChargedMicros: string
}

/** 按天结算（`settleDailyOf()`）。 */
export interface SettleDailyView {
  readonly date: string
  readonly records: number
  readonly settled: number
  readonly chargedMicros: string
}

/** 按模型结算（`settleModelOf()`）。 */
export interface SettleModelView {
  readonly model: string
  readonly records: number
  readonly chargedMicros: string
}

/** `GET /api/admin/billing` 的响应。 */
export interface AdminBillingView {
  readonly totals: SettleTotalsView
  readonly daily: readonly SettleDailyView[]
  readonly models: readonly SettleModelView[]
  readonly records: {
    readonly items: readonly SettleRecordView[]
    readonly total: number
  }
  readonly generatedAt: string
}
