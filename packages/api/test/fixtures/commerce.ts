/**
 * 兑换码 / 结算 / 充值夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  BillingPort,
  RedeemBatchLike,
  RedeemCodeLike,
  RedeemDeletionResultLike,
  RedeemPort,
  RedeemResultLike,
  RedeemStatsLike,
  RedemptionLike,
  SettlePageLike,
  SettleRecordLike,
  SettleSummaryLike,
  TopupOptionsLike,
  TopupOrderLike,
  TopupOrderPageLike,
  TopupPort,
  TopupStatsLike,
  ConfirmTopupResultLike,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

/**
 * 兑换码服务（`redeem`）的假实现。
 *
 * 只覆盖 HTTP 层需要观察的事：金额是 bigint 微元、明文只出现在 createBatch 的返回里、
 * 状态类拒绝走稳定 code。它不模拟事务与幂等（那是 redeem 插件自己的测试）。
 */
export class FakeRedeem implements RedeemPort {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly batches = new Map<string, RedeemBatchLike>()
  readonly codes = new Map<string, RedeemCodeLike>()
  /** 设置后 redeemCode 抛出带这个 code 的 DomainError，用于断言错误码 → 状态码。 */
  failRedeem: string | undefined

  async redeemCode(input: { userId: number; code: string }): Promise<RedeemResultLike> {
    this.calls.push({ method: 'redeemCode', args: [input] })
    if (this.failRedeem !== undefined) {
      throw new DomainError(this.failRedeem, '测试拒绝：兑换码不可用')
    }
    return { amount: 5_000_000n, balance: 12_345_678n, batchName: '测试批次' }
  }

  async listMyRedemptions(userId: number, limit?: number): Promise<readonly RedemptionLike[]> {
    this.calls.push({ method: 'listMyRedemptions', args: [userId, limit] })
    return [
      {
        codeId: 'code-1',
        codeMask: '****A3F7',
        amountMicro: 5_000_000n,
        batchName: '测试批次',
        redeemedAt: '2026-10-19T12:00:00.000Z',
      },
    ]
  }

  async createBatch(
    actor: string,
    input: {
      name: string
      amountMicro: bigint
      count: number
      expiresAt?: string | null
      notes?: string | null
    },
  ): Promise<{ batch: RedeemBatchLike; codes: readonly string[] }> {
    this.calls.push({ method: 'createBatch', args: [actor, input] })
    const id = `batch-${this.batches.size + 1}`
    const batch: RedeemBatchLike = {
      id,
      name: input.name,
      kind: 'balance',
      amountMicro: input.amountMicro,
      total: input.count,
      notes: input.notes ?? null,
      createdBy: actor,
      createdAt: '2026-10-19T12:00:00.000Z',
      expiresAt: input.expiresAt ?? null,
      codeCount: input.count,
      usedCount: 0,
    }
    this.batches.set(id, batch)
    const codes: string[] = []
    for (let index = 0; index < input.count; index += 1) {
      const plain = `ABCD-EFGH-JKMN-PQRS-TVWX-${String(index + 1).padStart(4, '0')}`
      codes.push(plain)
      const codeId = `code-${this.codes.size + 1}`
      this.codes.set(codeId, {
        id: codeId,
        batchId: id,
        batchName: batch.name,
        codeMask: `****${plain.slice(-4)}`,
        kind: 'balance',
        amountMicro: input.amountMicro,
        status: 'enabled',
        createdAt: batch.createdAt,
        expiresAt: batch.expiresAt,
        reservedAt: null,
        reservedBy: null,
        redeemedAt: null,
        redeemedBy: null,
        disabledBy: null,
        disabledAt: null,
      })
    }
    return { batch, codes }
  }

  async listBatches(
    _actor: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<readonly RedeemBatchLike[]> {
    this.calls.push({ method: 'listBatches', args: [query] })
    const all = [...this.batches.values()]
    return all.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? all.length))
  }

  async getBatch(_actor: string, batchId: string): Promise<RedeemBatchLike> {
    this.calls.push({ method: 'getBatch', args: [batchId] })
    const batch = this.batches.get(batchId)
    if (batch === undefined) throw new DomainError('REDEEM_NOT_FOUND', '批次不存在')
    return batch
  }

  async listCodes(
    _actor: string,
    query: { batchId?: string; status?: string; keyword?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: readonly RedeemCodeLike[]; total: number }> {
    this.calls.push({ method: 'listCodes', args: [query] })
    let items = [...this.codes.values()]
    if (query.batchId !== undefined) items = items.filter((code) => code.batchId === query.batchId)
    if (query.status === 'used' || query.status === 'enabled' || query.status === 'disabled' || query.status === 'redeeming') {
      items = items.filter((code) => code.status === query.status)
    }
    if (query.keyword !== undefined) {
      items = items.filter((code) => code.codeMask.includes(query.keyword as string))
    }
    return { items: items.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)), total: items.length }
  }

  async setCodeStatus(
    _actor: string,
    codeId: string,
    status: 'enabled' | 'disabled',
  ): Promise<RedeemCodeLike> {
    this.calls.push({ method: 'setCodeStatus', args: [codeId, status] })
    const code = this.codes.get(codeId)
    if (code === undefined) throw new DomainError('REDEEM_NOT_FOUND', '兑换码不存在')
    const updated: RedeemCodeLike = { ...code, status }
    this.codes.set(codeId, updated)
    return updated
  }

  async deleteCodes(_actor: string, ids: readonly string[]): Promise<RedeemDeletionResultLike> {
    this.calls.push({ method: 'deleteCodes', args: [ids] })
    const rejected = ids
      .filter((id) => this.codes.get(id)?.status === 'used')
      .map((id) => ({ id, reason: 'REDEEM_CODE_USED' }))
    let deleted = 0
    for (const id of ids) {
      if (rejected.some((item) => item.id === id)) continue
      if (this.codes.delete(id)) deleted += 1
    }
    return { deleted, rejected }
  }

  async resolveRedeeming(
    _actor: string,
    codeId: string,
    outcome: 'used' | 'enabled',
  ): Promise<RedeemCodeLike> {
    this.calls.push({ method: 'resolveRedeeming', args: [codeId, outcome] })
    const code = this.codes.get(codeId)
    if (code === undefined) throw new DomainError('REDEEM_NOT_FOUND', '兑换码不存在')
    const updated: RedeemCodeLike = {
      ...code,
      status: outcome,
      reservedAt: null,
      redeemedAt: outcome === 'used' ? '2026-10-19T12:00:00.000Z' : null,
    }
    this.codes.set(codeId, updated)
    return updated
  }

  async stats(_actor: string): Promise<RedeemStatsLike> {
    const all = [...this.codes.values()]
    const countOf = (status: string): number => all.filter((code) => code.status === status).length
    return {
      batches: this.batches.size,
      codes: all.length,
      enabled: countOf('enabled'),
      disabled: countOf('disabled'),
      redeeming: countOf('redeeming'),
      used: countOf('used'),
      expired: 0,
      redeemedAmountMicro: all
        .filter((code) => code.status === 'used')
        .reduce((sum, code) => sum + code.amountMicro, 0n),
    }
  }
}

/** 结算服务（`billing`）的假实现：只读面，金额是 bigint 微元。 */
export class FakeBilling implements BillingPort {
  readonly calls: { method: string; args: readonly unknown[] }[] = []
  /** 设置后 list / summary 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined

  private readonly record: SettleRecordLike = {
    reqId: 'req-1',
    userId: 2,
    accountId: 'account-1',
    model: 'deepseek-chat',
    day: '2026-10-19',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: 1_750_000n,
    overdrawn: false,
    balanceAfter: 8_250_000n,
    status: 'settled',
    note: null,
    attempts: 1,
    startedAt: '2026-10-19T11:00:00.000Z',
    claimedAt: '2026-10-19T11:00:02.000Z',
    settledAt: '2026-10-19T11:00:02.000Z',
    createdAt: '2026-10-19T11:00:02.000Z',
    updatedAt: '2026-10-19T11:00:02.000Z',
  }

  list(
    _actor: string,
    query: { readonly status?: string; readonly limit?: number; readonly offset?: number } = {},
  ): SettlePageLike {
    this.calls.push({ method: 'list', args: [query] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：结算读失败')
    const items = query.status === 'problem' ? [] : [this.record]
    return { items, total: items.length }
  }

  summary(_actor: string, nowMs?: number): SettleSummaryLike {
    this.calls.push({ method: 'summary', args: [nowMs] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：结算读失败')
    return {
      totals: {
        records: 1,
        settled: 1,
        noPrice: 0,
        noUser: 0,
        failed: 0,
        review: 0,
        settling: 0,
        overdrawn: 0,
        chargedMicros: 1_750_000n,
        todayChargedMicros: 1_750_000n,
      },
      daily: [{ date: '2026-10-19', records: 1, settled: 1, chargedMicros: 1_750_000n }],
      models: [{ model: 'deepseek-chat', records: 1, chargedMicros: 1_750_000n }],
    }
  }
}

/** 充值订单服务（`topup`）的假实现：只覆盖 HTTP 层要观察的行为。 */
export class FakeTopup implements TopupPort {
  readonly calls: { method: string; args: readonly unknown[] }[] = []
  /** 设置后 createOrder / confirmPaid 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined
  confirmCredited = true

  private readonly order: TopupOrderLike = {
    orderNo: 'T20261019110000ABCD1234',
    userId: 2,
    amountMicro: 100_000_000n,
    status: 'pending',
    provider: 'manual',
    providerLabel: '人工确认（线下转账）',
    providerOrderId: null,
    instructions: '请联系管理员线下转账，并在备注里写明单号；管理员确认后到账。',
    note: '对公转账',
    createdAt: '2026-10-19T11:00:00.000Z',
    expiresAt: '2026-10-19T11:30:00.000Z',
    paidAt: null,
    canceledAt: null,
  }

  options(): TopupOptionsLike {
    return {
      currency: 'CNY',
      providerId: 'manual',
      providerLabel: '人工确认（线下转账）',
      online: false,
      minAmountMicros: 1_000_000n,
      maxAmountMicros: 10_000_000_000n,
      expiresMinutes: 30,
      notice: '当前仅支持人工确认到账，不会自动到账。',
    }
  }

  async createOrder(input: {
    readonly userId: number
    readonly amountYuan: unknown
  }): Promise<{ readonly order: TopupOrderLike }> {
    this.calls.push({ method: 'createOrder', args: [input] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：创建订单失败')
    return { order: this.order }
  }

  listMine(userId: number, limit?: number): TopupOrderPageLike {
    this.calls.push({ method: 'listMine', args: [userId, limit] })
    return { items: [this.order], total: 1 }
  }

  getMine(userId: number, orderNo: string): TopupOrderLike {
    this.calls.push({ method: 'getMine', args: [userId, orderNo] })
    return this.order
  }

  cancelMine(userId: number, orderNo: string): TopupOrderLike {
    this.calls.push({ method: 'cancelMine', args: [userId, orderNo] })
    return { ...this.order, status: 'canceled', canceledAt: '2026-10-19T11:05:00.000Z' }
  }

  list(
    _actor: string,
    query: {
      readonly status?: string
      readonly userId?: number
      readonly fromMs?: number
      readonly toMs?: number
      readonly limit?: number
      readonly offset?: number
    } = {},
  ): TopupOrderPageLike {
    this.calls.push({ method: 'list', args: [query] })
    return { items: [this.order], total: 1 }
  }

  async confirmPaid(actor: string, orderNo: string): Promise<ConfirmTopupResultLike> {
    this.calls.push({ method: 'confirmPaid', args: [actor, orderNo] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：确认到账失败')
    return {
      order: this.confirmCredited ? this.order : { ...this.order, status: 'paid' },
      credited: this.confirmCredited,
    }
  }

  cancel(actor: string, orderNo: string): TopupOrderLike {
    this.calls.push({ method: 'cancel', args: [actor, orderNo] })
    return { ...this.order, status: 'canceled', canceledAt: '2026-10-19T11:05:00.000Z' }
  }

  stats(_actor: string, nowMs?: number): TopupStatsLike {
    this.calls.push({ method: 'stats', args: [nowMs] })
    return {
      todayPaidCount: 1,
      todayPaidMicros: 100_000_000n,
      totalPaidCount: 2,
      totalPaidMicros: 300_000_000n,
      pendingCount: 3,
      expiredCount: 4,
    }
  }
}
