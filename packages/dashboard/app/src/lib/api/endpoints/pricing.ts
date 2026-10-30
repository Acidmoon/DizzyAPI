/**
 * 模型广场与价格表端点。
 *
 * **用户侧的「只读价格表」直接用 `GET /api/pricing`**：它要会话（任何登录用户），
 * 出参是 `{ items: [{ model, inputPerMillion, outputPerMillion, ... }] }`，
 * 金额是十进制字符串（**不是浮点**），前端只格式化、不做算术。
 *
 * `PUT` / `DELETE /api/pricing/:model` 是管理员写接口，不给用户侧用。
 */
import type { ApiClient } from '../client.ts'
import type { ModelCatalogView, ModelPriceView, PricingListView } from '../types.ts'

/** `GET /api/pricing`：读价格表（任何登录用户）。 */
export function fetchPricing(client: ApiClient): Promise<PricingListView> {
  return client.request<PricingListView>('/api/pricing')
}

/** `GET /api/pricing/:model`：单个模型的价格（没有则 404）。 */
export function fetchModelPrice(client: ApiClient, model: string): Promise<ModelPriceView> {
  return client.request<ModelPriceView>(`/api/pricing/${encodeURIComponent(model)}`)
}

/** 模型广场的筛选条件。 */
export interface ModelFilters {
  /** 按模型名子串过滤（不区分大小写）。 */
  readonly search?: string
  /** 可用性过滤。 */
  readonly availability?: 'all' | 'available' | 'unavailable'
  /** 是否配价过滤。 */
  readonly priced?: 'all' | 'priced' | 'unpriced'
}

/** `GET /api/models`：模型广场目录（价格 + 可用性 + 覆盖账号数）。 */
export function fetchModels(client: ApiClient, filters: ModelFilters = {}): Promise<ModelCatalogView> {
  return client.request<ModelCatalogView>('/api/models', { query: { ...filters } })
}

/** `PUT /api/pricing/:model`：写价格（**管理员**）。金额收十进制字符串或数字。 */
export function setModelPrice(
  client: ApiClient,
  model: string,
  input: {
    readonly inputPerMillion: string | number
    readonly outputPerMillion: string | number
    readonly cacheReadPerMillion?: string | number
    readonly cacheWritePerMillion?: string | number
  },
): Promise<ModelPriceView> {
  return client.request<ModelPriceView>(`/api/pricing/${encodeURIComponent(model)}`, {
    method: 'PUT',
    body: input,
  })
}

/** `DELETE /api/pricing/:model`：删价格（**管理员**）。 */
export function deleteModelPrice(
  client: ApiClient,
  model: string,
): Promise<{ readonly removed: boolean }> {
  return client.request<{ readonly removed: boolean }>(
    `/api/pricing/${encodeURIComponent(model)}`,
    { method: 'DELETE' },
  )
}
