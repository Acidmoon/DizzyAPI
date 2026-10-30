/**
 * 前端 API 客户端的**唯一对外入口**。
 *
 * 页面**只从这里 import**，不自己 `fetch('/api/...')`——那样会漏掉
 * `X-Requested-With` 头（403）、漏掉错误信封解析、漏掉 401 跳转。
 *
 * 用法：
 * ```ts
 * import { api, keys, usage } from "@/lib/api";
 *
 * const list = await keys.listKeys(api);
 * const page = await usage.fetchUsage(api, { range: "7d" });
 * ```
 */
export {
  ApiClient,
  ApiError,
  API_REQUEST_HEADER_NAME,
  API_REQUEST_HEADER_VALUE,
  DEFAULT_TIMEOUT_MS,
  api,
  buildQuery,
  type ApiClientOptions,
  type RequestOptions,
} from './client.ts'

export {
  errorMessage,
  authErrorMessage,
  enqueue,
  mutate,
  type MutationOptions,
  type MutationStrategy,
} from './mutations.ts'

export {
  CENTS_PER_YUAN,
  MICROS_PER_YUAN,
  formatCentsYuan,
  formatCount,
  formatMicrosYuan,
  formatMicrosYuanFixed,
  yuanToMicros,
} from './money.ts'

export * from './types.ts'

// ── 端点（按域命名空间导出，避免两个域的同名函数打架）──
export * as auth from './endpoints/auth.ts'
export * as keys from './endpoints/keys.ts'
export * as usage from './endpoints/usage.ts'
export * as pricing from './endpoints/pricing.ts'
export * as redeem from './endpoints/redeem.ts'
export * as topup from './endpoints/topup.ts'
export * as profile from './endpoints/profile.ts'
export * as adminUsers from './endpoints/adminUsers.ts'
export * as adminOps from './endpoints/adminOps.ts'
export * as adminCommerce from './endpoints/adminCommerce.ts'
