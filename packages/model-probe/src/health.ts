/**
 * 从「最近若干条样本」派生一个模型的健康度。**纯函数，不碰存储。**
 *
 * 派生规则（`failureThreshold` 是唯一可调项）：
 * - 最近一条是 `probe-error` → `unknown`。**探测自己没测出来，就什么都不能断言。**
 *   这一条是假红的最后一道闸：如果探测 key 失效、用户没钱，页面上应该是「未知」而不是「挂了」。
 * - 连续 `failed` 达到 `failureThreshold` → `down`。
 * - 最近一条 `degraded`，或最近这批里有 `degraded` 但没到 `down` → `degraded`。
 * - 最近一条 `ok` → `up`。
 * - 一条样本都没有 → `unknown`。
 *
 * 「连续失败」的定义：从最新往回数，连续的 `failed`。
 * `ok` / `degraded` 打断它；`probe-error` 也打断它（那不是模型的失败）。
 */
import type { ModelProbeHealth, ModelProbeSampleRow } from './types.ts'

export interface DerivedHealth {
  readonly health: ModelProbeHealth
  readonly consecutiveFailures: number
  readonly lastOkAtMs: number | null
  readonly lastTestedAtMs: number | null
}

export function deriveHealth(
  /** 最新在前的样本序列。 */
  points: readonly ModelProbeSampleRow[],
  failureThreshold: number,
): DerivedHealth {
  if (points.length === 0) {
    return { health: 'unknown', consecutiveFailures: 0, lastOkAtMs: null, lastTestedAtMs: null }
  }

  const latest = points[0]

  let consecutiveFailures = 0
  for (const point of points) {
    if (point.status !== 'failed') break
    consecutiveFailures += 1
  }

  const lastOk = points.find((point) => point.status === 'ok' || point.status === 'degraded')

  if (consecutiveFailures >= failureThreshold) {
    return {
      health: 'down',
      consecutiveFailures,
      lastOkAtMs: lastOk?.testedAtMs ?? null,
      lastTestedAtMs: latest.testedAtMs,
    }
  }

  // 最新一条是探测自身的问题：不下任何结论。
  if (latest.status === 'probe-error') {
    return {
      health: 'unknown',
      consecutiveFailures,
      lastOkAtMs: lastOk?.testedAtMs ?? null,
      lastTestedAtMs: latest.testedAtMs,
    }
  }
  if (latest.status === 'ok') {
    return {
      health: 'up',
      consecutiveFailures,
      // 最新一条本身就是 ok，不必依赖 lastOk（TS 也无法从上面的 find 收窄）。
      lastOkAtMs: latest.testedAtMs,
      lastTestedAtMs: latest.testedAtMs,
    }
  }
  if (latest.status === 'degraded') {
    return {
      health: 'degraded',
      consecutiveFailures,
      lastOkAtMs: latest.testedAtMs,
      lastTestedAtMs: latest.testedAtMs,
    }
  }
  // 最新是 failed 但还没到阈值：先按 degraded 报（还在抖，不判死）。
  return {
    health: 'degraded',
    consecutiveFailures,
    lastOkAtMs: lastOk?.testedAtMs ?? null,
    lastTestedAtMs: latest.testedAtMs,
  }
}

/**
 * 这一轮的样本是否整体不可信。
 *
 * 判据：`probe-error` 占多数。单个模型偶发一次探测侧错误不算 ——
 * 但如果整轮一半以上都是 `probe-error`，那多半是探测 key / 余额 / 网关的问题，
 * 这一轮**不能**拿来更新「某个模型挂了」的印象。
 */
export function passIsUntrustworthy(probeErrors: number, probed: number): boolean {
  if (probed === 0) return false
  return probeErrors * 2 > probed
}
