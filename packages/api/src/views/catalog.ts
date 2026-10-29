/**
 * views/catalog.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import type { CatalogModuleView, GatewayHealthState, ModelCatalogLike, ModelEntryLike, ModelPriceLike } from '../types.ts'

export function catalogState(state: string): CatalogModuleView['state'] {
  switch (state) {
    case 'active':
      return 'active'
    case 'pending':
    case 'loading':
      return 'pending'
    case 'disabled':
      return 'disabled'
    case 'failed':
      return 'failed'
    default:
      return 'unloaded'
  }
}


export function priorityState(state: string): GatewayHealthState {
  if (state === 'ready') return 'ok'
  if (state === 'dropped' || state === 'failed' || state === 'stopped') return 'down'
  return 'degraded'
}


// ───────────────────────────────── 模型广场 ─────────────────────────────────

export function modelCatalogOf(catalog: ModelCatalogLike): Record<string, unknown> {
  return {
    available: catalog.available.map(modelEntryOf),
    unavailable: catalog.unavailable.map((entry) => ({
      model: entry.model,
      reason: entry.reason,
      detail: entry.detail,
      accountCount: entry.accountCount,
      priced: entry.priced,
      price: entry.price === null ? null : modelPriceViewOf(entry.price),
    })),
    summary: {
      total: catalog.summary.total,
      availableCount: catalog.summary.availableCount,
      unavailableCount: catalog.summary.unavailableCount,
      pricedCount: catalog.summary.pricedCount,
      accountCount: catalog.summary.accountCount,
    },
  }
}


export function modelEntryOf(entry: ModelEntryLike): Record<string, unknown> {
  return {
    model: entry.model,
    priced: entry.priced,
    price: entry.price === null ? null : modelPriceViewOf(entry.price),
    accountCount: entry.accountCount,
    healthyAccountCount: entry.healthyAccountCount,
    protocols: entry.protocols,
    upstreamModels: entry.upstreamModels,
    mapped: entry.mapped,
  }
}


export function modelPriceViewOf(price: ModelPriceLike): Record<string, unknown> {
  return {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion,
    cacheWritePerMillion: price.cacheWritePerMillion,
    currency: price.currency,
    updatedAt: price.updatedAt,
  }
}
