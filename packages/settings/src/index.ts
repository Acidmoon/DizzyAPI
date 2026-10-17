/**
 * 设置插件（@dizzyapi/plugin-settings）。
 *
 * 服务名是 `settings`：运行期配置的唯一写者。`app.yml` 保持「人写的基线」，
 * 本插件独占一个覆盖文件，合并后交给目标插件自己的 schema 校验，再过
 * cordis 的 `fiber.update(…, true)` 让目标软重启，新配置立刻生效。
 *
 * 它是能力型插件（AGENTS.md D16）：不进描述符、不进 LLM 请求链路，
 * 只受 app.yml 的启用 / 禁用控制。它不认识任何具体插件——命名空间就是 entry 的 id，
 * 可写字段由各插件在 schema 上自己声明（kit 的 FieldSpec）。
 */
import { SettingsService } from './service.ts'

declare module 'cordis' {
  interface Context {
    settings: SettingsService
  }

  interface Events {
    /** 某个命名空间的覆盖变了（改了或清掉了）。 */
    'settings/updated'(ns: string): void
  }
}

export { SettingsService }
export { SettingsError, isSettingsError, type SettingsErrorCode } from './errors.ts'
export {
  SETTINGS_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  SETTINGS_CONFIG_SCHEMA as Config,
  validateSettingsConfig,
  type ResolvedSettingsConfig,
  type SettingsConfig,
} from './config.ts'
export { mergeConfig, mergePatch, isPlainObject } from './merge.ts'
export { revisionOf, stableStringify } from './revision.ts'
export {
  createSettingsStore,
  emptySnapshot,
  settingsCodec,
  SNAPSHOT_VERSION,
  type NamespaceRecord,
  type SettingsSnapshot,
} from './store.ts'
export {
  type ConfigPatch,
  type SettingsFieldView,
  type SettingsNamespaceView,
} from './service.ts'

export default SettingsService
