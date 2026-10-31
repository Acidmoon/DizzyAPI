/**
 * views/catalog.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 *
 * ## 探测字段为什么是「可选 + 就地声明」
 *
 * `ModelEntryLike` / `ModelCatalogLike`（`../types.ts`）是**既有契约**，而且那个文件
 * 已经超 §5.6 的 500 行上限、只许缩短不许加长 —— 所以探测相关的形状声明在这里，
 * 用交叉类型把它挂上去：
 *
 *     ModelEntryLike & { probe?: ModelProbeLike }
 *
 * 语义上这是**纯增量**：`modelhub` 没接探测插件时根本不输出 `probe` 键，
 * 响应与改造前逐字一致（`test/models.test.ts` 有用例钉着）。老的服务实现
 * （`ModelHubPort`）也不需要跟着改类型就能编过。
 */
import type {
  CatalogModuleView,
  GatewayHealthState,
  ModelCatalogLike,
  ModelEntryLike,
  ModelPriceLike,
  ModelUnavailableEntryLike,
} from '../types.ts'

// ───────────────────────────────── 探测（增量） ─────────────────────────────────

/** 探测健康度：`modelhub` 判的（阈值是它的配置），不是探测插件判的。 */
export type ModelProbeHealthLike = 'up' | 'degraded' | 'down' | 'unknown'

/** 小柱状图的一个点。**只有稳定原因码，没有上游响应正文。** */
export interface ModelProbePointLike {
  readonly status: string
  readonly latencyMs: number
  readonly httpStatus: number | null
  readonly errorCode: string | null
  readonly testedAtMs: number
}

/** 一个模型的探测视图。`probe` 键不存在 = 没接探测 / 没探过。 */
export interface ModelProbeLike {
  readonly probed: boolean
  readonly health: ModelProbeHealthLike
  readonly consecutiveFailures: number
  readonly lastOkAtMs: number | null
  readonly lastTestedAtMs: number | null
  readonly points: readonly ModelProbePointLike[]
}

/** 探测总体状态。**页面必须显示 `blockedReason`**：停摆不是模型故障。 */
export interface ModelProbeSummaryLike {
  readonly enabled: boolean
  readonly running: boolean
  readonly blockedReason: string | null
  readonly blockedDetail: string | null
  readonly lastPassAt: string | null
  readonly failureThreshold: number
  readonly downCount: number
}

/** 带探测字段的条目（交叉类型挂上去，不动既有契约）。 */
type EntryWithProbe = ModelEntryLike & { readonly probe?: ModelProbeLike }
type UnavailableWithProbe = ModelUnavailableEntryLike & { readonly probe?: ModelProbeLike }
type CatalogWithProbe = ModelCatalogLike & { readonly probe?: ModelProbeSummaryLike }

// ───────────────────────────────── 既有映射（行为逐字未改） ─────────────────────────────────

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

export function modelCatalogOf(catalog: CatalogWithProbe): Record<string, unknown> {
  const view: Record<string, unknown> = {
    available: catalog.available.map((entry) => modelEntryOf(entry as EntryWithProbe)),
    unavailable: catalog.unavailable.map((entry) => {
      const withProbe = entry as UnavailableWithProbe
      return {
        model: entry.model,
        reason: entry.reason,
        detail: entry.detail,
        accountCount: entry.accountCount,
        priced: entry.priced,
        price: entry.price === null ? null : modelPriceViewOf(entry.price),
        // 增量字段：服务端不给就整个键不出现。
        ...(withProbe.probe === undefined ? {} : { probe: modelProbeOf(withProbe.probe) }),
      }
    }),
    summary: {
      total: catalog.summary.total,
      availableCount: catalog.summary.availableCount,
      unavailableCount: catalog.summary.unavailableCount,
      pricedCount: catalog.summary.pricedCount,
      accountCount: catalog.summary.accountCount,
    },
  }
  if (catalog.probe !== undefined) view.probe = modelProbeSummaryOf(catalog.probe)
  return view
}


export function modelEntryOf(entry: EntryWithProbe): Record<string, unknown> {
  return {
    model: entry.model,
    priced: entry.priced,
    price: entry.price === null ? null : modelPriceViewOf(entry.price),
    accountCount: entry.accountCount,
    healthyAccountCount: entry.healthyAccountCount,
    protocols: entry.protocols,
    upstreamModels: entry.upstreamModels,
    mapped: entry.mapped,
    ...(entry.probe === undefined ? {} : { probe: modelProbeOf(entry.probe) }),
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


/** 一个模型的探测视图 → JSON。字段名逐字对应 `modelhub` 的 `ModelProbeView`。 */
export function modelProbeOf(probe: ModelProbeLike): Record<string, unknown> {
  return {
    probed: probe.probed,
    health: probe.health,
    consecutiveFailures: probe.consecutiveFailures,
    lastOkAtMs: probe.lastOkAtMs,
    lastTestedAtMs: probe.lastTestedAtMs,
    points: probe.points.map(modelProbePointOf),
  }
}


function modelProbePointOf(point: ModelProbePointLike): Record<string, unknown> {
  return {
    status: point.status,
    latencyMs: point.latencyMs,
    httpStatus: point.httpStatus,
    errorCode: point.errorCode,
    testedAtMs: point.testedAtMs,
  }
}


/** 探测总体状态 → JSON。`blockedReason` 必须原样透出：页面要靠它说「停摆不是模型挂了」。 */
export function modelProbeSummaryOf(probe: ModelProbeSummaryLike): Record<string, unknown> {
  return {
    enabled: probe.enabled,
    running: probe.running,
    blockedReason: probe.blockedReason,
    blockedDetail: probe.blockedDetail,
    lastPassAt: probe.lastPassAt,
    failureThreshold: probe.failureThreshold,
    downCount: probe.downCount,
  }
}
