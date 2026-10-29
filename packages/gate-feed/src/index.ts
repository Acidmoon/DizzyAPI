/**
 * 闸门快照推送插件（@dizzyapi/plugin-gate-feed）。
 *
 * 服务名 `gateFeed`：心跳式把「价格表」与「每个 key 的累计消费」推给 Go 的
 * 定价闸门 / key-gate。它自己不存数据、不做判断，也不拥有控制桥。
 */
import { GateFeedService } from './service.ts'

declare module 'cordis' {
  interface Context {
    gateFeed: GateFeedService
  }

  interface Events {
    /** Go 侧确认缓存了一版价格快照 / key 消费快照（不含明细）。 */
    'gate-feed/pushed'(pricing: number, keys: number): void
    /** 闸门快照推送失败（已按节流写日志）。 */
    'gate-feed/error'(code: string, message: string): void
  }
}

export { GateFeedService } from './service.ts'
export {
  type GateFeedStatus,
  type KeySpendEntryPayload,
  type KeySpendSnapshotPayload,
  type PriceEntryPayload,
  type PricingSnapshotPayload,
} from './types.ts'
export { GateFeedError, isGateFeedError, type GateFeedErrorCode } from './errors.ts'
export {
  GATE_FEED_CONFIG_SCHEMA,
  /** cordis 读取的配置 schema；校验不过就不构造插件。 */
  GATE_FEED_CONFIG_SCHEMA as Config,
  GATE_FEED_DEFAULTS,
  validateGateFeedConfig,
  type GateFeedConfig,
  type ResolvedGateFeedConfig,
} from './config.ts'

export default GateFeedService
