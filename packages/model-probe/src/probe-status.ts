/**
 * `status()` 的视图映射：把服务内部字段拼成对外状态（**只读、纯函数**）。
 *
 * 抽出来是为了 §5.6 的文件粒度：`service.ts` 贴着 500 行硬上限，而这段是「把字段摆平」
 * 的机械活儿，没有编排逻辑。顺带一个好处：这里能一眼审完「对外到底暴露了什么」——
 * **只有 `probeKeyConfigured`（配没配）与引用名，绝没有明文**。
 */
import type { ResolvedModelProbeConfig } from './config.ts'
import type { ModelProbeBlockedReason, ModelProbePass, ModelProbeState } from './types.ts'

export interface ProbeStateInput {
  readonly config: ResolvedModelProbeConfig
  /** 探测 key 的明文在不在 `credentials` 里（**只给布尔，不给值**）。 */
  readonly probeKeyConfigured: boolean
  readonly probeKeyId: string | null
  readonly probeKeyName: string | null
  readonly running: boolean
  readonly lastPass: ModelProbePass | null
  readonly lastPassAt: string | null
  readonly blockedReason: ModelProbeBlockedReason | null
  readonly blockedDetail: string | null
  readonly samples: number
  readonly lastPrunedAt: string | null
}

export function probeStateOf(input: ProbeStateInput): ModelProbeState {
  const { config } = input
  return {
    enabled: config.enabled,
    intervalMs: config.intervalMs,
    timeoutMs: config.timeoutMs,
    degradedThresholdMs: config.degradedThresholdMs,
    maxConcurrent: config.maxConcurrent,
    failureThreshold: config.failureThreshold,
    historyPoints: config.historyPoints,
    retentionDays: config.retentionDays,
    probeModels: config.probeModels,
    gatewayBaseUrl: config.gatewayBaseUrl,
    probeUserId: config.probeUserId,
    probeKeyRef: config.probeKeyRef,
    probeKeyConfigured: input.probeKeyConfigured,
    probeKeyId: input.probeKeyId,
    probeKeyName: input.probeKeyName,
    running: input.running,
    lastPass: input.lastPass,
    lastPassAt: input.lastPassAt,
    blockedReason: input.blockedReason,
    blockedDetail: input.blockedDetail,
    samples: input.samples,
    lastPrunedAt: input.lastPrunedAt,
  }
}
