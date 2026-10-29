/**
 * 模型广场插件（@dizzyapi/plugin-modelhub）。
 *
 * 服务名是 `modelhub`：消费方用 `ctx.inject(['modelhub'], (ctx) => { ... })` 拿到它。
 * 它是**纯只读聚合**：不落盘、不写任何数据，只把 `pricing` 的价格表与账号声明的
 * `models` / `modelMap` / 协议 / 健康度拼成「我们卖什么」。
 *
 * 它不 inject 任何服务（价格与账号都在运行期解析），所以被单独禁用时只影响
 * `/api/models` 与 `/console/models` 两个入口，其他插件照常。
 */
import { ModelHubService } from './service.ts'
import { MODELHUB_CONFIG_SCHEMA, validateModelHubConfig } from './config.ts'

declare module 'cordis' {
  interface Context {
    modelhub: ModelHubService
  }
}

export { ModelHubService }
export { ModelHubError, isModelHubError, type ModelHubErrorCode } from './errors.ts'
export {
  MODELHUB_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  MODELHUB_CONFIG_SCHEMA as Config,
  validateModelHubConfig,
  type ModelHubConfig,
  type ResolvedModelHubConfig,
} from './config.ts'
export type {
  ModelCatalog,
  ModelCatalogQuery,
  ModelCatalogSummary,
  ModelEntry,
  ModelHubServiceLike,
  ModelPriceView,
  ModelUnavailableEntry,
  ModelUnavailableReason,
} from './types.ts'

export default ModelHubService
