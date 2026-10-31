/**
 * 模型可用性探测的稳定错误码。
 *
 * 与 `modelhub` / `account-health` 的写法一致：错误码给机器分支，message 给人排障。
 * **文案里绝不出现探测 key 明文、上游响应正文或任何秘密。**
 */
export type ModelProbeErrorCode =
  /** 配置非法（构造期抛出，插件的装载会被拒绝）。 */
  | 'MODEL_PROBE_CONFIG_INVALID'
  /** 插件还没装载完成 / 已卸载。 */
  | 'MODEL_PROBE_NOT_READY'
  /** 调用方不在 `adminPlugins` 白名单里。 */
  | 'MODEL_PROBE_ACTOR_FORBIDDEN'
  /** 调用方没声明自己的插件名（actor 为空）。 */
  | 'MODEL_PROBE_ACTOR_REQUIRED'
  /** 探测所需的某个服务不可用（apiKey / credentials / modelhub / timer）。 */
  | 'MODEL_PROBE_DEPENDENCY_UNAVAILABLE'
  /** 探测 key 既没有现成的、也创建不出来。 */
  | 'MODEL_PROBE_KEY_UNAVAILABLE'
  /** 探测 key 的明文不在 credentials 里（被人删了，或还没创建过）。 */
  | 'MODEL_PROBE_KEY_SECRET_MISSING'
  /** 探测库读写失败。 */
  | 'MODEL_PROBE_STORE_CORRUPT'
  /** 查询参数不合法（模型名空 / 超大 / 点数越界）。 */
  | 'MODEL_PROBE_QUERY_INVALID'

export class ModelProbeError extends Error {
  readonly code: ModelProbeErrorCode

  constructor(code: ModelProbeErrorCode, message: string) {
    super(message)
    this.name = 'ModelProbeError'
    this.code = code
  }
}

export function isModelProbeError(value: unknown): value is ModelProbeError {
  return value instanceof ModelProbeError
}
