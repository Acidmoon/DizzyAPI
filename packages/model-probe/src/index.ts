/**
 * 模型可用性探测插件（@dizzyapi/plugin-model-probe）。
 *
 * 服务名 `modelProbe`：定时走**真网关**对每个模型发一条最小请求，按模型记录探测历史
 * （`data/model-probe.db`，只有本插件写）。它只提供**事实**与派生健康度，
 * **不判「模型不可用」**——那个判定归 `modelhub`，它读本插件的只读视图。
 *
 * 探测请求计费（走真链路），所以探测 key 归属用户的余额会成为探测的硬前提；
 * 余额不足时本插件记 `probe-error` 并把「探测已停摆」挂到 `status()` 上，
 * **绝不**把它算成模型 `failed`（假红比不监测更糟）。
 */
import { ModelProbeService } from './service.ts'

declare module 'cordis' {
  interface Context {
    modelProbe: ModelProbeService
  }

  interface Events {
    /** 跑完一轮探测（不含任何秘密：只有计数）。 */
    'model-probe/pass'(probed: number, failed: number, probeErrors: number): void
  }
}

export { ModelProbeService } from './service.ts'
export { MODEL_PROBE_ACTOR, PROBE_KEY_NAME, PROBE_KEY_NAME_PREFIX } from './service.ts'
export { deriveHealth, passIsUntrustworthy } from './health.ts'
export { extractErrorCode, runProbe } from './probe-client.ts'
export { ensureProbeKey } from './probe-key.ts'
export { openModelProbeDatabase, MODEL_PROBE_SCHEMA, dayOf } from './db.ts'
export { ModelProbeStore } from './store.ts'
export { ModelProbeError, isModelProbeError, type ModelProbeErrorCode } from './errors.ts'
export {
  MODEL_PROBE_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  MODEL_PROBE_CONFIG_SCHEMA as Config,
  MODEL_PROBE_DEFAULTS,
  validateModelProbeConfig,
  type ModelProbeConfig,
  type ResolvedModelProbeConfig,
} from './config.ts'
export type {
  ModelProbeBlockedReason,
  ModelProbeDailyRollup,
  ModelProbeHealth,
  ModelProbeHistory,
  ModelProbePass,
  ModelProbeSample,
  ModelProbeSampleRow,
  ModelProbeServiceLike,
  ModelProbeState,
  ModelProbeStatus,
} from './types.ts'

export default ModelProbeService
