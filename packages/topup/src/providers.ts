/**
 * 支付通道 seam：**只留接口，本批不接任何真实渠道**。
 *
 * 设计要点：
 * - `createCharge` 只负责「这一单怎么付」；它返回的 `instructions` 是给用户看的人话。
 * - `verifyCallback` 是给未来渠道回调用的（验签 + 金额核对）。**本批所有 provider 都不实现**，
 *   也不挂任何回调 HTTP 路由——没有验签的回调路由等于把加余额的接口暴露给公网。
 * - 接真实渠道时要补的东西写在 `verifyCallback` 的注释里：验签、金额与订单核对、
 *   幂等（provider 可能重复回调）、失败重试策略，以及渠道密钥只能放 `credentials`。
 *
 * 配置里出现未知 provider id **必须明确失败**（fail-closed），不许静默回落到 manual。
 */
import { formatMicrosAsYuan } from './money.ts'

/** 创建支付时给 provider 的只读订单视图（不含任何用户资料）。 */
export interface PaymentOrderRef {
  readonly orderNo: string
  readonly userId: number
  readonly amountMicro: bigint
  readonly currency: 'CNY'
  readonly createdAt: string
  readonly expiresAt: string
}

/** provider 返回的支付信息。`providerOrderId` 只有真实渠道才有。 */
export interface ChargeResult {
  readonly providerOrderId: string | null
  /** 给用户看的人话（例如「请联系管理员线下转账」）；页面会原样展示。 */
  readonly instructions: string
}

/** 渠道回调的入参（本批不实现，接渠道时补）。 */
export interface PaymentCallbackInput {
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** 渠道回调的验签结果。`paid=false` 表示「验签通过但还没有支付成功」。 */
export interface PaymentCallbackResult {
  readonly providerOrderId: string
  readonly paid: boolean
  /** 渠道声明的金额；回调方必须与订单金额比对，不一致要拒绝（防止改价）。 */
  readonly amountMicro?: bigint
}

/** 一个支付通道。本批只有 `manual`（纯人工确认，不联网）。 */
export interface PaymentProvider {
  readonly id: string
  readonly label: string
  /** 是否真的接了在线渠道；`false` = 只能人工确认到账。 */
  readonly online: boolean
  createCharge(order: PaymentOrderRef): Promise<ChargeResult>
  /**
   * 回调验签。**本批不实现**：所有 provider 都留空，也没有回调路由。
   *
   * 接真实渠道时必须做：
   * 1. 用渠道密钥（放 `credentials`，绝不进 `app.yml` / 日志）验签；
   * 2. 校验 `providerOrderId` 对应的订单、金额与状态（防改价 / 防重放）；
   * 3. 幂等：渠道会重复回调，`topup` 侧靠 `pending → paid` 的 CAS 只会加一次钱；
   * 4. 校验失败必须明确拒绝并记告警，不许「先加钱再说」。
   */
  verifyCallback?(input: PaymentCallbackInput): Promise<PaymentCallbackResult>
}

/** 人工确认：订单创建后告诉用户「线下转账 + 管理员确认」。不联网、不碰秘密。 */
const manualProvider: PaymentProvider = {
  id: 'manual',
  label: '人工确认（线下转账）',
  online: false,
  async createCharge(order) {
    return {
      providerOrderId: null,
      instructions:
        `本平台尚未接入在线支付，不会自动到账。请线下联系管理员转账 ` +
        `¥${formatMicrosAsYuan(order.amountMicro)}，并在转账备注里写明单号 ${order.orderNo}；` +
        `管理员核对后为你确认到账（单号 ${order.expiresAt.slice(0, 16).replace('T', ' ')} UTC 前有效）。`,
    }
  },
}

/** 已注册的支付通道；新增渠道 = 往这里加一个实现（同时补 `verifyCallback` 与回调路由）。 */
export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = [manualProvider]

/** 已知 provider id（配置校验用；未知 id 必须让插件装载失败）。 */
export function providerIds(): readonly string[] {
  return PAYMENT_PROVIDERS.map((provider) => provider.id)
}

export function findProvider(id: string): PaymentProvider | undefined {
  return PAYMENT_PROVIDERS.find((provider) => provider.id === id)
}
