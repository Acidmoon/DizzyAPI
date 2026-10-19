/**
 * 用户插件（@dizzyapi/plugin-user）。
 *
 * 服务名是 `user`：消费者用 `ctx.inject(['user'], (ctx) => { ... })` 拿到它。
 * 插件被禁用或卸载时，服务与其存储一起回收（AGENTS.md D5）。
 */
import { UserService } from './service.ts'
import type { UserChangedEvent } from './model.ts'

declare module 'cordis' {
  interface Context {
    user: UserService
  }

  interface Events {
    /**
     * 用户写入成功后发出。通知性质，不承载正确性；载荷不含密码 / 邮箱 / 令牌。
     * 供 api-key 快照刷新等消费者使用（例如 banned / removed 后重新推送 key 视图）。
     */
    'user/changed'(payload: UserChangedEvent): void
  }
}

export { UserService }
export { UserError, isUserError, type UserErrorCode } from './errors.ts'
export {
  BALANCE_MINOR_UNITS_PER_YUAN,
  USER_AVATAR_DATA_MAX_BYTES,
  USER_AVATAR_URL_MAX_LENGTH,
  USER_NAME_MAX_LENGTH,
  USER_ROLES,
  USER_STATUSES,
  type Balance,
  type BalanceEntry,
  type User,
  type UserChangedAction,
  type UserChangedEvent,
  type UserChangedField,
  type UserId,
  type UserProfilePatch,
  type UserQuery,
  type UserRole,
  type UserStatus,
} from './model.ts'
export {
  USER_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  USER_CONFIG_SCHEMA as Config,
  validateUserConfig,
  type ResolvedUserConfig,
  type UserConfig,
} from './schema.ts'
export {
  createUserStore,
  emptySnapshot,
  snapshotCodec,
  SNAPSHOT_VERSION,
  type UserSnapshot,
} from './store.ts'
export {
  UserDatabase,
  type InsertUserInput,
  type LegacyUserImport,
  type UserRowPatch,
} from './db.ts'
export { type CreateUserInput } from './service.ts'

export default UserService
