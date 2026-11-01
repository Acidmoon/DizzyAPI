/** 客户端指纹档案的稳定错误码。 */
export type ClientMaskErrorCode =
  /** 配置非法（启动即失败，不静默降级）。 */
  | 'CLIENT_MASK_CONFIG_INVALID'
  /** 档案 id 不存在。 */
  | 'CLIENT_MASK_PROFILE_UNKNOWN'
  /** 入参不合法（头名 / 头值 / UA / id）。 */
  | 'CLIENT_MASK_INPUT_INVALID'
  /** 调用方不在 `adminPlugins` 白名单里。 */
  | 'CLIENT_MASK_ACTOR_FORBIDDEN'
  /** 插件还没装载完 / 已卸载。 */
  | 'CLIENT_MASK_NOT_READY'

export class ClientMaskError extends Error {
  readonly code: ClientMaskErrorCode

  constructor(code: ClientMaskErrorCode, message: string) {
    super(message)
    this.name = 'ClientMaskError'
    this.code = code
  }
}

export function isClientMaskError(value: unknown): value is ClientMaskError {
  return value instanceof ClientMaskError
}
