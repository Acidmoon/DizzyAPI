/**
 * 把「探测事实」翻成模型广场的**探测视图**。
 *
 * 分工是这次批次的硬边界：
 * - `modelProbe` 只出**事实**：最近若干条样本、连续失败条数、最近成功时刻。
 * - **判定「不可用」在这里**（`modelhub`）：用本插件自己的 `probeFailureThreshold`
 *   去比 `consecutiveFailures`，决定 `health` 是 `down` 还是 `degraded`。
 *
 * 为什么不直接用 `modelProbe` 给的 `health`：那个是探测插件自己的派生视图，
 * 用它的阈值算出来的。判定权归 modelhub 的话，阈值就得是 modelhub 的配置 ——
 * 否则「改 modelhub 的阈值」不会生效，改了探测插件的阈值反而会偷偷影响广场。
 *
 * 另一条纪律：**探测停摆时不判死**。`probe-error`（余额不足 / key 失效 / 连不上网关）
 * 不是模型的失败，这类样本不进 `consecutiveFailures`（探测插件已经这么算了），
 * 所以这里天然不会把它当 `down`。但整轮探测停摆时，`probed: false` 之前留下的
 * 旧样本也不该再被当「现在挂了」—— 停摆时一律降级成 `unknown`。
 */
import type {
  ModelProbeHealth,
  ModelProbePointView,
  ModelProbeView,
} from './types.ts'

/**
 * 探测服务 `status()` 里本插件用到的那几个字段。
 *
 * **不 import `@dizzyapi/plugin-model-probe` 的类型**：插件之间只依赖结构面
 * （AGENTS.md §2.2「不直接 import 另一个插件的实现」）。这里按实际用到的字段声明，
 * 探测插件多给的字段自然被忽略；它少给关键字段时下面的 `probeSeam()` 会拒绝。
 */
export interface ModelProbeStatusSeam {
  readonly enabled: boolean
  readonly running: boolean
  readonly probeKeyConfigured: boolean
  readonly blockedReason: string | null
  readonly blockedDetail: string | null
  readonly lastPassAt: string | null
}

/** 探测历史里本插件用到的那几个字段。 */
export interface ModelProbeHistorySeam {
  readonly model: string
  readonly points: readonly {
    readonly status: string
    readonly latencyMs: number
    readonly httpStatus: number | null
    readonly errorCode: string | null
    readonly testedAtMs: number
  }[]
  readonly consecutiveFailures: number
  readonly lastOkAtMs: number | null
  readonly lastTestedAtMs: number | null
}

/** 探测服务暴露的只读结构面（不 import 实现类）。 */
export interface ModelProbeSeam {
  histories(limit?: number): readonly ModelProbeHistorySeam[]
  status(): ModelProbeStatusSeam
}

/** 一次 catalog() 查询里，探测带给目录的全部事实（算一次，全表复用）。 */
export interface ProbeFacts {
  /** 探测是否在正常工作（停摆 = false）。 */
  readonly healthy: boolean
  /** 模型名 → 探测视图（已按本插件的阈值判好 health）。 */
  readonly byModel: ReadonlyMap<string, ModelProbeView>
  /** 给页面的探测总体状态。 */
  readonly summary: {
    readonly enabled: boolean
    readonly running: boolean
    readonly blockedReason: string | null
    readonly blockedDetail: string | null
    readonly lastPassAt: string | null
    readonly failureThreshold: number
    readonly downCount: number
  }
}

/** 没接探测服务时的空事实：目录照常出，探测相关字段全为「没探过」。 */
export const NO_PROBE_FACTS: ProbeFacts = {
  healthy: false,
  byModel: new Map(),
  summary: {
    enabled: false,
    running: false,
    blockedReason: null,
    blockedDetail: null,
    lastPassAt: null,
    failureThreshold: 0,
    downCount: 0,
  },
}

export interface ProbeFactsInput {
  readonly probe: ModelProbeSeam
  /** 目录里要出现的历史点数（`probeHistoryPoints`）。 */
  readonly historyPoints: number
  /** 本插件判「不可用」的阈值（`probeFailureThreshold`）。 */
  readonly failureThreshold: number
}

/**
 * 取一次探测事实。**失败只降级不抛**：探测插件出问题不该让整个模型广场挂掉。
 * （`catalog()` 的调用方是 `/api/models`，它 200 返回一份「没有探测数据」的目录，
 * 比 503 更有用。）
 */
export function collectProbeFacts(input: ProbeFactsInput): ProbeFacts {
  const { probe, historyPoints, failureThreshold } = input
  let status: ModelProbeStatusSeam
  try {
    status = probe.status()
  } catch {
    return NO_PROBE_FACTS
  }

  // **停摆时不做任何「挂着」的判断**：留旧样本会让人以为「这个模型刚刚挂了」，
  // 而真实情况是「探测根本没在跑」。停摆时全部给 unknown。
  const stalled = status.blockedReason !== null
  const healthy = !stalled && status.probeKeyConfigured

  const byModel = new Map<string, ModelProbeView>()
  if (status.enabled) {
    let histories: ReturnType<ModelProbeSeam['histories']> = []
    try {
      histories = probe.histories(historyPoints)
    } catch {
      // 读不到历史就只出「没探过」，不抛。
      histories = []
    }
    for (const history of histories) {
      byModel.set(history.model, probeViewOf(history, { stalled, failureThreshold }))
    }
  }

  let downCount = 0
  for (const view of byModel.values()) if (view.health === 'down') downCount += 1

  return {
    healthy,
    byModel,
    summary: {
      enabled: status.enabled,
      running: status.running,
      blockedReason: status.blockedReason,
      blockedDetail: status.blockedDetail,
      lastPassAt: status.lastPassAt,
      failureThreshold,
      downCount,
    },
  }
}

/**
 * 单个模型的探测视图。
 *
 * `consecutiveFailures` 是**探测插件给的纯事实**（连续几条 `failed`）；
 * 「够不够判死」由这里的 `failureThreshold` 决定。
 */
export function probeViewOf(
  history: {
    readonly points: readonly {
      readonly status: string
      readonly latencyMs: number
      readonly httpStatus: number | null
      readonly errorCode: string | null
      readonly testedAtMs: number
    }[]
    readonly consecutiveFailures: number
    readonly lastOkAtMs: number | null
    readonly lastTestedAtMs: number | null
  },
  options: { readonly stalled: boolean; readonly failureThreshold: number },
): ModelProbeView {
  const points: ModelProbePointView[] = history.points.map((point) => ({
    status: normalizePointStatus(point.status),
    latencyMs: point.latencyMs,
    httpStatus: point.httpStatus,
    errorCode: point.errorCode,
    testedAtMs: point.testedAtMs,
  }))

  const probed = points.length > 0
  const health = judgeHealth({
    points,
    consecutiveFailures: history.consecutiveFailures,
    stalled: options.stalled,
    failureThreshold: options.failureThreshold,
  })

  return {
    probed,
    health,
    consecutiveFailures: history.consecutiveFailures,
    lastOkAtMs: history.lastOkAtMs,
    lastTestedAtMs: history.lastTestedAtMs,
    points,
  }
}

/**
 * 判定规则（与探测插件的派生视图**独立**，阈值来自 modelhub 的配置）：
 * - 停摆 / 没探过 → `unknown`（什么都不能断言）；
 * - **最新一条是 `probe-error` → `unknown`**（探测自己没测出来，不能算模型挂了）；
 * - 连续 `failed` ≥ 阈值 → `down`；
 * - 最新 `ok` → `up`；最新 `degraded`，或 `failed` 未达阈值 → `degraded`。
 *
 * 顺序有意义：`probe-error` 的判断必须在阈值判断**之前**。探测插件算
 * `consecutiveFailures` 时本来就会让 `probe-error` 打断计数，所以正常数据下两者不冲突；
 * 但这里要能扛住「上游实现算错了 / 旧库里的脏数据」——只要最新一条是探测侧错误，
 * 就绝不给 `down`。
 */
export function judgeHealth(input: {
  readonly points: readonly ModelProbePointView[]
  readonly consecutiveFailures: number
  readonly stalled: boolean
  readonly failureThreshold: number
}): ModelProbeHealth {
  if (input.stalled) return 'unknown'
  if (input.points.length === 0) return 'unknown'

  const latest = input.points[0]
  if (latest.status === 'probe-error') return 'unknown'

  if (input.consecutiveFailures >= Math.max(1, input.failureThreshold)) return 'down'
  if (latest.status === 'ok') return 'up'
  return 'degraded'
}

/** 探测状态是四个稳定串；脏数据一律折成 `failed`（不能把读不出来的当成好的）。 */
function normalizePointStatus(value: string): ModelProbePointView['status'] {
  if (value === 'ok' || value === 'degraded' || value === 'failed' || value === 'probe-error') return value
  return 'failed'
}
