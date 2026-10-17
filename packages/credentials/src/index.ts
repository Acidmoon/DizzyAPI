/**
 * 凭据插件（@dizzyapi/plugin-credentials）。
 *
 * 服务名是 `credentials`：秘密的唯一写者，管理面只回报「配没配」。
 * 依赖方（如 mailer）在配置里只持有**引用名**，投递时才用 `resolve` 取值，
 * 因此轮换密码不需要重启，下一次使用就是新值。
 *
 * 它是能力型插件（AGENTS.md D16）：不进描述符、不进 LLM 请求链路，
 * 只受 app.yml 的启用 / 禁用控制。
 */
import { CredentialsService } from './service.ts'

declare module 'cordis' {
  interface Context {
    credentials: CredentialsService
  }

  interface Events {
    /** 某个引用名的值变了（写入或删除）。消费者可据此刷新自己缓存的东西。 */
    'credentials/reference-updated'(ref: string): void
  }
}

export { CredentialsService }
export { CredentialsError, isCredentialsError, type CredentialsErrorCode } from './errors.ts'
export { isRef, normalizeRef, REF_MAX_LENGTH } from './ref.ts'
export {
  CREDENTIALS_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  CREDENTIALS_CONFIG_SCHEMA as Config,
  validateCredentialsConfig,
  type CredentialsConfig,
  type ResolvedCredentialsConfig,
} from './config.ts'
export {
  createCredentialsStore,
  credentialsCodec,
  emptySnapshot,
  SNAPSHOT_VERSION,
  type CredentialRecord,
  type CredentialsSnapshot,
} from './store.ts'
export { type CredentialDescription } from './service.ts'

export default CredentialsService
