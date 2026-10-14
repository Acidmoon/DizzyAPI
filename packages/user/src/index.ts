/**
 * 用户插件（@dizzyapi/plugin-user）。
 *
 * 服务名是 `user`：消费者用 `ctx.inject(['user'], (ctx) => { ... })` 拿到它。
 * 插件被禁用或卸载时，服务与其存储一起回收（AGENTS.md D5）。
 */
import { UserService } from './service.ts'

declare module 'cordis' {
  interface Context {
    user: UserService
  }
}

export { UserService }
export { UserError, isUserError, type UserErrorCode } from './errors.ts'
export {
  BALANCE_MINOR_UNITS_PER_YUAN,
  USER_NAME_MAX_LENGTH,
  USER_STATUSES,
  type Balance,
  type BalanceEntry,
  type User,
  type UserId,
  type UserQuery,
  type UserStatus,
} from './model.ts'
export {
  USER_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  USER_CONFIG_SCHEMA as Config,
  resolveUserConfig,
  validateUserConfig,
  type ResolvedUserConfig,
  type UserConfig,
} from './schema.ts'
export {
  emptySnapshot,
  jsonFileStore,
  memoryStore,
  type UserSnapshot,
  type UserStore,
} from './store.ts'
export { type CreateUserInput } from './service.ts'

export default UserService
