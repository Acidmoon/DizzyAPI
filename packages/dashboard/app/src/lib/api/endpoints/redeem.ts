/**
 * 兑换码端点（用户侧）。
 *
 * 兑换失败是**状态类拒绝**（409）：未知 / 已用 / 停用 / 过期 / 兑换中，
 * 错误信封里的 `code` 是 `REDEEM_CODE_*`，前端按 code 给不同文案。
 * **码本身不出现在错误消息里**（服务端纪律），前端也不要把用户输入的码写进日志。
 */
import type { ApiClient } from '../client.ts'
import type { RedeemResultView, RedemptionView } from '../types.ts'

/** `GET /api/redeem`：我的兑换记录。 */
export function fetchMyRedemptions(
  client: ApiClient,
  options: { readonly limit?: number } = {},
): Promise<{ readonly items: readonly RedemptionView[] }> {
  return client.request<{ readonly items: readonly RedemptionView[] }>('/api/redeem', {
    query: { limit: options.limit },
  })
}

/** `POST /api/redeem`：兑换一个码，金额进余额。 */
export function redeem(
  client: ApiClient,
  input: { readonly code: string },
): Promise<RedeemResultView> {
  return client.request<RedeemResultView>('/api/redeem', { method: 'POST', body: input })
}
