/**
 * 模型广场插件的稳定错误码。
 *
 * 这个插件是**只读聚合**，正常路径几乎不抛错；错误只在「查询条件不合法」与
 * 「配置非法」时出现。HTTP 层按 code 分支。
 */
export type ModelHubErrorCode =
  /** 查询条件不合法（过滤值不是约定的枚举值）。 */
  | 'MODELHUB_QUERY_INVALID'
  /** 插件配置不合法。 */
  | 'MODELHUB_CONFIG_INVALID'

export class ModelHubError extends Error {
  readonly code: ModelHubErrorCode

  constructor(code: ModelHubErrorCode, message: string) {
    super(message)
    this.name = 'ModelHubError'
    this.code = code
  }
}

export function isModelHubError(value: unknown): value is ModelHubError {
  return value instanceof ModelHubError
}
