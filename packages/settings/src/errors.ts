/**
 * 设置插件的错误码。
 *
 * 每个失败都有一个稳定的机器可读 code：调用方据 code 分支，人据 message 排障。
 * 特别注意 TARGET_* 那三个：目标缺失或被禁用时**必须显式失败**，不许静默跳过——
 * 静默跳过等于让一份没人应用的配置看起来「已生效」。
 */
export type SettingsErrorCode =
  | 'SETTINGS_ACTOR_REQUIRED'
  | 'SETTINGS_ACTOR_FORBIDDEN'
  | 'SETTINGS_NS_UNKNOWN'
  | 'SETTINGS_TARGET_MISSING'
  | 'SETTINGS_TARGET_DISABLED'
  | 'SETTINGS_TARGET_INACTIVE'
  | 'SETTINGS_FIELD_UNKNOWN'
  | 'SETTINGS_FIELD_NOT_WRITABLE'
  | 'SETTINGS_VALUE_INVALID'
  | 'SETTINGS_CONFLICT'
  | 'SETTINGS_STORE_CORRUPT'
  | 'SETTINGS_STORE_UNREADABLE'
  | 'SETTINGS_STORE_UNWRITABLE'

export class SettingsError extends Error {
  readonly code: SettingsErrorCode

  constructor(code: SettingsErrorCode, message: string) {
    super(message)
    this.name = 'SettingsError'
    this.code = code
  }
}

export function isSettingsError(value: unknown): value is SettingsError {
  return value instanceof SettingsError
}
