/**
 * 管理员面 · 充值订单 / 兑换码端点。
 *
 * 服务端来源：`routes/admin_topup.ts`、`routes/admin_redeem.ts`。
 *
 * **一次性 secret 的纪律**：`POST /api/admin/redeem-codes` 生成兑换码批次，响应里带
 * **明文码**（`codes`）——它**只在这一次响应里出现**。前端必须只展示一次、
 * 不落 localStorage / URL / 日志。其余接口永远只给掩码（`codeMask`）。
 */
import type { ApiClient } from '../client.ts'
import type {
  AdminRedeemBatchesView,
  AdminRedeemCodesView,
  AdminTopupOrderListView,
  ConfirmTopupView,
  CreatedRedeemBatchView,
  RedeemCodeView,
  RedeemDeletionView,
  RedeemStatsView,
  TopupOrderView,
  TopupStatsView,
} from '../types.ts'

// ───────────────────────────── 充值订单 ─────────────────────────────

/** 充值订单的筛选条件（`offset` 分页，不是 keyset）。 */
export interface AdminTopupFilters {
  readonly status?: string
  readonly userId?: number
  /** 时间窗（毫秒时间戳；0 / 省略 = 不限）。 */
  readonly from?: number
  readonly to?: number
  readonly limit?: number
  readonly offset?: number
}

/** `GET /api/admin/topup-orders`：充值订单列表（管理员）。 */
export function fetchTopupOrders(
  client: ApiClient,
  filters: AdminTopupFilters = {},
): Promise<AdminTopupOrderListView> {
  return client.request<AdminTopupOrderListView>('/api/admin/topup-orders', {
    query: { ...filters },
  })
}

/** `GET /api/admin/topup-orders/stats`：充值统计（管理员）。 */
export function fetchTopupStats(client: ApiClient): Promise<TopupStatsView> {
  return client.request<TopupStatsView>('/api/admin/topup-orders/stats')
}

/**
 * `POST /api/admin/topup-orders/:orderNo/confirm`：确认到账（管理员）。
 *
 * **会真的加余额**，且是幂等的：重复确认 `credited` 为 `false`，不会再加一次。
 */
export function confirmTopupOrder(client: ApiClient, orderNo: string): Promise<ConfirmTopupView> {
  return client.request<ConfirmTopupView>(
    `/api/admin/topup-orders/${encodeURIComponent(orderNo)}/confirm`,
    { method: 'POST' },
  )
}

/** `POST /api/admin/topup-orders/:orderNo/cancel`：取消订单（管理员）。 */
export function cancelTopupOrder(client: ApiClient, orderNo: string): Promise<TopupOrderView> {
  return client.request<TopupOrderView>(
    `/api/admin/topup-orders/${encodeURIComponent(orderNo)}/cancel`,
    { method: 'POST' },
  )
}

// ───────────────────────────── 兑换码 ─────────────────────────────

/** 兑换码列表的筛选条件。 */
export interface AdminRedeemFilters {
  /** 批次 id（查询串里叫 `batch`，**不是** `batchId`）。 */
  readonly batch?: string
  readonly status?: string
  /** 按掩码尾号搜索。 */
  readonly keyword?: string
  readonly limit?: number
  readonly offset?: number
}

/** `GET /api/admin/redeem-codes`：兑换码列表（管理员，**只有掩码**）。 */
export function fetchRedeemCodes(
  client: ApiClient,
  filters: AdminRedeemFilters = {},
): Promise<AdminRedeemCodesView> {
  return client.request<AdminRedeemCodesView>('/api/admin/redeem-codes', {
    query: { ...filters },
  })
}

/** 生成兑换码批次的入参。 */
export interface CreateRedeemBatchInput {
  readonly name: string
  /** **整数微元的十进制字符串**（1 元 = 1_000_000 微元）：不能传 JSON number。 */
  readonly amountMicro: string
  /** 张数，**必填**，服务端限 1..100。 */
  readonly count: number
  readonly expiresAt?: string | null
  readonly notes?: string
}

/**
 * `POST /api/admin/redeem-codes`：生成一个兑换码批次（管理员）。
 *
 * **响应里带明文码 `codes`，只此一次。**
 */
export function createRedeemBatch(
  client: ApiClient,
  input: CreateRedeemBatchInput,
): Promise<CreatedRedeemBatchView> {
  return client.request<CreatedRedeemBatchView>('/api/admin/redeem-codes', {
    method: 'POST',
    body: input,
  })
}

/**
 * `DELETE /api/admin/redeem-codes`：批量删除兑换码（管理员；已用的会被拒）。
 *
 * 注意是 **`DELETE` + body `{ ids }`**，不是 `DELETE /:id`。
 * 响应里 `rejected` 逐条给出删不掉的原因。
 */
export function deleteRedeemCodes(
  client: ApiClient,
  ids: readonly string[],
): Promise<RedeemDeletionView> {
  return client.request<RedeemDeletionView>('/api/admin/redeem-codes', {
    method: 'DELETE',
    body: { ids },
  })
}

/**
 * `POST /api/admin/redeem-codes/status`：改兑换码状态（启用 / 停用）。
 *
 * 走 `POST` + body（不是 PATCH），body 是 `{ id, status }`。
 */
export function setRedeemCodeStatus(
  client: ApiClient,
  input: { readonly id: string; readonly status: 'enabled' | 'disabled' },
): Promise<RedeemCodeView> {
  return client.request<RedeemCodeView>('/api/admin/redeem-codes/status', {
    method: 'POST',
    body: input,
  })
}

/**
 * `POST /api/admin/redeem-codes/resolve`：人工核查 `redeeming` 残留。
 *
 * `outcome` 是 `used`（标记为已用）或 `enabled`（退回可用）——这一步决定
 * 「这张码还能不能再加钱」，属高危写操作，服务端成功 / 失败都留审计。
 */
export function resolveRedeemCode(
  client: ApiClient,
  input: { readonly id: string; readonly outcome: 'used' | 'enabled' },
): Promise<RedeemCodeView> {
  return client.request<RedeemCodeView>('/api/admin/redeem-codes/resolve', {
    method: 'POST',
    body: input,
  })
}

/** `GET /api/admin/redeem-batches`：兑换码批次列表（管理员）。 */
export function fetchRedeemBatches(client: ApiClient): Promise<AdminRedeemBatchesView> {
  return client.request<AdminRedeemBatchesView>('/api/admin/redeem-batches')
}

/** `GET /api/admin/redeem-batches/:id`：单个批次（管理员）。 */
export function fetchRedeemBatch(client: ApiClient, id: string): Promise<unknown> {
  return client.request(`/api/admin/redeem-batches/${encodeURIComponent(id)}`)
}

/** `GET /api/admin/redeem-stats`：兑换码统计（管理员）。 */
export function fetchRedeemStats(client: ApiClient): Promise<RedeemStatsView> {
  return client.request<RedeemStatsView>('/api/admin/redeem-stats')
}
