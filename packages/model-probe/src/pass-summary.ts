/**
 * 杂项归一化与汇总：从 `service.ts` 搬出来，让编排文件只留编排。
 */
import { ModelProbeError } from './errors.ts'
import type { ModelProbePass, ModelProbeSample } from './types.ts'

const MODEL_NAME_LIMIT = 200
const ACTOR_MAX_LENGTH = 200
/** 单次查询的点数上限；小柱状图最多 240 点，500 是留了余量。 */
const LIMIT_MAX = 500
/** 算健康度至少要看到这么多条，否则「连续失败」的判定没有意义。 */
export const HEALTH_WINDOW_MIN = 20

export function normalizeModel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelProbeError('MODEL_PROBE_QUERY_INVALID', '模型名必须是字符串')
  }
  const model = value.trim()
  if (model === '') throw new ModelProbeError('MODEL_PROBE_QUERY_INVALID', '模型名不能为空')
  if (model.length > MODEL_NAME_LIMIT) {
    throw new ModelProbeError('MODEL_PROBE_QUERY_INVALID', `模型名最长 ${MODEL_NAME_LIMIT} 个字符`)
  }
  return model
}

export function normalizeLimit(value: unknown, fallback: number): number {
  if (value === undefined) return Math.max(HEALTH_WINDOW_MIN, fallback)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > LIMIT_MAX) {
    throw new ModelProbeError('MODEL_PROBE_QUERY_INVALID', `limit 必须是 1..${LIMIT_MAX} 的整数`)
  }
  return value
}

export function normalizeActor(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ModelProbeError('MODEL_PROBE_ACTOR_REQUIRED', '调用方必须声明自己的插件名')
  }
  const name = value.trim()
  if (name.length > ACTOR_MAX_LENGTH) {
    throw new ModelProbeError('MODEL_PROBE_ACTOR_REQUIRED', `插件名最长 ${ACTOR_MAX_LENGTH} 个字符`)
  }
  return name
}

/** 把一轮的样本收成计数。`probed` 用实际结果条数，不用目标数（中途卸载时两者会差）。 */
export function summarize(results: readonly ModelProbeSample[], models: readonly string[]): ModelProbePass {
  let ok = 0
  let degraded = 0
  let failed = 0
  let probeErrors = 0
  for (const sample of results) {
    if (sample.status === 'ok') ok += 1
    else if (sample.status === 'degraded') degraded += 1
    else if (sample.status === 'failed') failed += 1
    else probeErrors += 1
  }
  return { probed: results.length, ok, degraded, failed, probeErrors, models, skippedReason: null }
}

/** 一条请求都没发的那种「轮次」：`skippedReason` 说明为什么。 */
export function emptyPass(reason: string): ModelProbePass {
  return { probed: 0, ok: 0, degraded: 0, failed: 0, probeErrors: 0, models: [], skippedReason: reason }
}
