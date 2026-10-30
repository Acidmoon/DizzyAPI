/**
 * 充值订单端点（用户侧）。
 *
 * **本批没有在线支付**：下单后订单是 `pending`，服务端回 `instructions`
 * （人工转账说明），要管理员确认才到账。所以「创建订单」成功后前端**不要**
 * 显示「充值成功」，只显示「订单已创建，等待确认」。
 *
 * 金额是「元」的十进制字符串（服务端换算成整数微元）；响应里的金额是「分」。
 */
import type { ApiClient } from '../client.ts'
import type { TopupCreateView, TopupOptionsView, TopupOrderView } from '../types.ts'

/** `GET /api/topup/options`：下单参数（最小 / 最大金额、有效期、说明）。 */
export function fetchTopupOptions(client: ApiClient): Promise<TopupOptionsView> {
  return client.request<TopupOptionsView>('/api/topup/options')
}

/** `GET /api/topup/orders`：我的订单。 */
export function fetchMyOrders(
  client: ApiClient,
  options: { readonly limit?: number } = {},
): Promise<{ readonly items: readonly TopupOrderView[]; readonly total: number }> {
  return client.request<{ readonly items: readonly TopupOrderView[]; readonly total: number }>(
    '/api/topup/orders',
    { query: { limit: options.limit } },
  )
}

/** `GET /api/topup/orders/:orderNo`：单个订单。 */
export function fetchOrder(client: ApiClient, orderNo: string): Promise<TopupOrderView> {
  return client.request<TopupOrderView>(`/api/topup/orders/${encodeURIComponent(orderNo)}`)
}

/**
 * `POST /api/topup/orders`：下单。
 *
 * `amountYuan` 是「元」的十进制字符串（最多 6 位小数，服务端字符串换算不经浮点）。
 */
export function createOrder(
  client: ApiClient,
  input: {
    readonly amountYuan: string
    readonly provider?: string
    readonly note?: string | null
  },
): Promise<TopupCreateView> {
  return client.request<TopupCreateView>('/api/topup/orders', { method: 'POST', body: input })
}

/** `POST /api/topup/orders/:orderNo/cancel`：取消自己的订单。 */
export function cancelOrder(client: ApiClient, orderNo: string): Promise<TopupOrderView> {
  return client.request<TopupOrderView>(
    `/api/topup/orders/${encodeURIComponent(orderNo)}/cancel`,
    { method: 'POST' },
  )
}
