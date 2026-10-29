/**
 * views/commerce.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import type { RedeemBatchLike, RedeemCodeLike, RedeemResultLike, RedeemStatsLike, RedemptionLike, SettleDailyLike, SettleModelLike, SettleRecordLike, SettleTotalsLike, TopupOptionsLike, TopupOrderLike, TopupStatsLike } from '../types.ts'


// ───────────────────────────────── 兑换码响应归一化 ─────────────────────────────────

/** 金额一律写成十进制字符串（浏览器用 BigInt 解析），JSON 里不出现 bigint。 */
export function redeemResultOf(result: RedeemResultLike): {
  readonly amountMinor: string
  readonly balanceMinor: string
  readonly batchName: string
} {
  return {
    amountMinor: result.amount.toString(),
    balanceMinor: result.balance.toString(),
    batchName: result.batchName,
  }
}


export function redemptionOf(item: RedemptionLike): {
  readonly codeId: string
  readonly codeMask: string
  readonly amountMinor: string
  readonly batchName: string | null
  readonly redeemedAt: string | null
} {
  return {
    codeId: item.codeId,
    codeMask: item.codeMask,
    amountMinor: item.amountMicro.toString(),
    batchName: item.batchName,
    redeemedAt: item.redeemedAt,
  }
}


export function redeemBatchOf(batch: RedeemBatchLike): Record<string, unknown> {
  return {
    id: batch.id,
    name: batch.name,
    kind: batch.kind,
    amountMinor: batch.amountMicro.toString(),
    total: batch.total,
    notes: batch.notes,
    createdBy: batch.createdBy,
    createdAt: batch.createdAt,
    expiresAt: batch.expiresAt,
    codeCount: batch.codeCount,
    usedCount: batch.usedCount,
  }
}


export function redeemCodeOf(code: RedeemCodeLike): Record<string, unknown> {
  return {
    id: code.id,
    batchId: code.batchId,
    batchName: code.batchName,
    codeMask: code.codeMask,
    kind: code.kind,
    amountMinor: code.amountMicro.toString(),
    status: code.status,
    createdAt: code.createdAt,
    expiresAt: code.expiresAt,
    reservedAt: code.reservedAt,
    reservedBy: code.reservedBy,
    redeemedAt: code.redeemedAt,
    redeemedBy: code.redeemedBy,
    disabledBy: code.disabledBy,
    disabledAt: code.disabledAt,
  }
}


export function redeemStatsOf(stats: RedeemStatsLike): Record<string, unknown> {
  return {
    batches: stats.batches,
    codes: stats.codes,
    enabled: stats.enabled,
    disabled: stats.disabled,
    redeeming: stats.redeeming,
    used: stats.used,
    expired: stats.expired,
    redeemedAmountMicro: stats.redeemedAmountMicro.toString(),
  }
}


// ───────────────────────────────── 充值订单 ─────────────────────────────────

export function topupOrderOf(order: TopupOrderLike): Record<string, unknown> {
  return {
    orderNo: order.orderNo,
    userId: order.userId,
    amountMicro: order.amountMicro.toString(),
    status: order.status,
    provider: order.provider,
    providerLabel: order.providerLabel,
    providerOrderId: order.providerOrderId,
    instructions: order.instructions,
    note: order.note,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt,
    canceledAt: order.canceledAt,
  }
}


export function topupOptionsOf(options: TopupOptionsLike): Record<string, unknown> {
  return {
    currency: options.currency,
    providerId: options.providerId,
    providerLabel: options.providerLabel,
    online: options.online,
    minAmountMicros: options.minAmountMicros.toString(),
    maxAmountMicros: options.maxAmountMicros.toString(),
    expiresMinutes: options.expiresMinutes,
    notice: options.notice,
  }
}


export function topupStatsOf(stats: TopupStatsLike): Record<string, unknown> {
  return {
    todayPaidCount: stats.todayPaidCount,
    todayPaidMicros: stats.todayPaidMicros.toString(),
    totalPaidCount: stats.totalPaidCount,
    totalPaidMicros: stats.totalPaidMicros.toString(),
    pendingCount: stats.pendingCount,
    expiredCount: stats.expiredCount,
  }
}


// ───────────────────────────────── 结算（只读） ─────────────────────────────────

export function settleRecordOf(record: SettleRecordLike): Record<string, unknown> {
  return {
    reqId: record.reqId,
    userId: record.userId,
    accountId: record.accountId,
    model: record.model,
    day: record.day,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    costMicro: record.costMicro.toString(),
    overdrawn: record.overdrawn,
    balanceAfter: record.balanceAfter === null ? null : record.balanceAfter.toString(),
    status: record.status,
    note: record.note,
    attempts: record.attempts,
    startedAt: record.startedAt,
    claimedAt: record.claimedAt,
    settledAt: record.settledAt,
    updatedAt: record.updatedAt,
  }
}


export function settleTotalsOf(totals: SettleTotalsLike): Record<string, unknown> {
  return {
    records: totals.records,
    settled: totals.settled,
    noPrice: totals.noPrice,
    noUser: totals.noUser,
    failed: totals.failed,
    review: totals.review,
    settling: totals.settling,
    overdrawn: totals.overdrawn,
    chargedMicros: totals.chargedMicros.toString(),
    todayChargedMicros: totals.todayChargedMicros.toString(),
  }
}


export function settleDailyOf(point: SettleDailyLike): Record<string, unknown> {
  return {
    date: point.date,
    records: point.records,
    settled: point.settled,
    chargedMicros: point.chargedMicros.toString(),
  }
}


export function settleModelOf(model: SettleModelLike): Record<string, unknown> {
  return {
    model: model.model,
    records: model.records,
    chargedMicros: model.chargedMicros.toString(),
  }
}
