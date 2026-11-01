/**
 * 客户端指纹档案插件（@dizzyapi/plugin-client-mask）。
 *
 * 服务名 `clientMask`：管理「上游请求要伪装成哪个客户端」的那批头（opencode / codex /
 * claude-cli / browser / 自定义），并把「账号挂的档案」解析成一小段可以推给 Go 的头。
 *
 * **它不注入请求**：真正贴头发生在 Go 的 `modules/transport`（TS 侧不知道请求体，
 * 算不出 `{{session}}`）。数据流：本插件（档案）→ `account-priority`（按账号解析、随快照推）
 * → `internal/accounts`（只读缓存）→ `modules/transport`（展开模板、贴头、保护鉴权头）。
 *
 * 秘密纪律：档案里**只有头名与头值模板**，不存任何秘密；`credentials` 仍是秘密的唯一去处。
 */
import { ClientMaskService } from './service.ts'

declare module 'cordis' {
  interface Context {
    clientMask: ClientMaskService
  }

  interface Events {
    /** 某个档案被改动（id 不是秘密）。 */
    'client-mask/updated'(id: string): void
  }
}

export { ClientMaskService } from './service.ts'
export type { ClientProfileInput } from './service.ts'
export { ClientMaskError, isClientMaskError, type ClientMaskErrorCode } from './errors.ts'
export {
  CLIENT_MASK_CONFIG_SCHEMA,
  CLIENT_MASK_CONFIG_SCHEMA as Config,
  CLIENT_MASK_DEFAULTS,
  CLIENT_MASK_FIELDS,
  resolveClientMaskConfig,
  type ClientMaskConfig,
  type ResolvedClientMaskConfig,
} from './config.ts'
export { PRESET_IDS, isPresetId, presetProfile, presetProfiles, type PresetId } from './presets.ts'
export {
  ALLOWED_PLACEHOLDERS,
  MAX_HEADERS_PER_PROFILE,
  PROTECTED_HEADERS,
  PLACEHOLDER_SESSION,
  PLACEHOLDER_TIMESTAMP,
  PLACEHOLDER_UUID,
  placeholdersIn,
  validateHeaderName,
  validateHeaderValue,
  validateProfileId,
  validateUserAgent,
} from './template.ts'
export { CLIENT_MASK_STORE_VERSION, createClientMaskStore, mergeProfiles } from './store.ts'
export type {
  ClientHeader,
  ClientMaskStatus,
  ClientProfile,
  ClientProfilePatch,
  ResolvedClientMask,
} from './types.ts'

export default ClientMaskService
