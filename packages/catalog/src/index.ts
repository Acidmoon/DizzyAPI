/**
 * 插件能力目录（@dizzyapi/plugin-catalog）。
 *
 * 服务名是 `catalog`：从活的 cordis 插件树反射出「谁提供什么、谁接受什么」，
 * 再由插件可选的声明清单补齐反射看不到的部分（事件、桥命令、数据形状、存储用途）。
 *
 * 它是能力型插件（AGENTS.md D16）：不进描述符、不进 LLM 请求链路、不起 HTTP，
 * 只受 app.yml 的启用 / 禁用控制。禁用时服务随 effect 一起回收（D5）。
 */
import { CatalogService } from './service.ts'

declare module 'cordis' {
  interface Context {
    catalog: CatalogService
  }
}

export { CatalogService }
export { CatalogError, isCatalogError, type CatalogErrorCode } from './errors.ts'
export {
  CATALOG_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  CATALOG_CONFIG_SCHEMA as Config,
  CATALOG_DEFAULTS,
  validateCatalogConfig,
  type CatalogConfig,
  type ResolvedCatalogConfig,
} from './config.ts'
export {
  normalizeManifest,
  readAttachedManifest,
  readModuleManifest,
  type LoadedManifest,
} from './manifest.ts'
export type {
  CatalogBridgeDeclaration,
  CatalogBridgeView,
  CatalogConfigField,
  CatalogConfigView,
  CatalogCounts,
  CatalogDataShape,
  CatalogEventDeclaration,
  CatalogEventView,
  CatalogInjectView,
  CatalogManifest,
  CatalogManifestView,
  CatalogMethod,
  CatalogMethodDeclaration,
  CatalogPlugin,
  CatalogPluginKind,
  CatalogPluginState,
  CatalogQuery,
  CatalogQueryResult,
  CatalogServiceView,
  CatalogShapeField,
  CatalogSnapshot,
  CatalogSnapshotOptions,
  CatalogStorageDeclaration,
  CatalogStorageView,
} from './types.ts'

export default CatalogService
