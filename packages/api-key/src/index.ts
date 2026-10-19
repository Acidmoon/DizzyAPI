/**
 * API key 插件（@dizzyapi/plugin-api-key）。
 *
 * 服务名是 `apiKey`：消费者用 `ctx.inject(['apiKey'], (ctx) => { ... })` 拿到它。
 * 它是用户 API key 的唯一写者，存储是 SQLite；插件被禁用或卸载时，
 * 服务与数据库连接一起回收（AGENTS.md D5）。
 */
import { ApiKeyService } from './service.ts'
import type { ApiKeyChangedEvent } from './types.ts'

declare module 'cordis' {
  interface Context {
    apiKey: ApiKeyService
  }

  interface Events {
    /** 某个用户的 API key 被创建 / 修改 / 轮换 / 删除；载荷不含 secret。 */
    'api-key/changed'(event: ApiKeyChangedEvent): void
  }
}

export { ApiKeyService }
export { ApiKeyError, isApiKeyError, type ApiKeyErrorCode } from './errors.ts'
export {
  API_KEY_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  API_KEY_CONFIG_SCHEMA as Config,
  API_KEY_DEFAULTS,
  validateApiKeyConfig,
  type ApiKeyConfig,
  type ResolvedApiKeyConfig,
} from './config.ts'
export {
  bumpGeneration,
  constantTimeHexEqual,
  formatFullKey,
  generateSecret,
  generateTrackingId,
  hashApiKey,
  immediateTransaction,
  maskKey,
  newKeyId,
  openApiKeyDatabase,
  parseApiKey,
  readGeneration,
  toView,
  type ApiKeyRow,
} from './db.ts'
export {
  API_KEY_MAX_KEYS_PER_USER_DEFAULT,
  API_KEY_MAX_KEYS_PER_USER_MAX,
  API_KEY_MAX_KEYS_PER_USER_MIN,
  API_KEY_NAME_MAX_LENGTH,
  API_KEY_PREFIX,
  API_KEY_PROFILE,
  API_KEY_SECRET_LENGTH,
  API_KEY_TRACKING_LENGTH,
  type ApiKeyAction,
  type ApiKeyChangedEvent,
  type ApiKeySnapshot,
  type ApiKeySnapshotKey,
  type ApiKeyStatus,
  type ApiKeyVerified,
  type ApiKeyView,
} from './types.ts'
export {
  type CreateApiKeyInput,
  type CreateApiKeyResult,
  type RemoveApiKeyResult,
  type RotateApiKeyResult,
  type UpdateApiKeyPatch,
} from './service.ts'

export default ApiKeyService
