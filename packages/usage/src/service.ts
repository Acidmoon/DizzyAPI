/**
 * 用量插件（服务名 `usage`）。
 *
 * 定位：**用量事实的唯一存储者**。Go 在请求结束时把记录放进环形缓冲，本插件定期经
 * 控制桥拉取（`usage.since`），幂等落 SQLite；查询侧按 `pricing` 服务的当前价格表
 * 在读取时算费用。
 *
 * 这一版只是契约骨架：存储与查询方法已冻结，实现随 `feat/usage-core` 落地。
 */
import { Service, type Context, type Logger } from 'cordis'
import { USAGE_CONFIG_SCHEMA, USAGE_DEFAULTS, type ResolvedUsageConfig, type UsageConfig } from './config.ts'
import type {
  UsageEntry,
  UsageListPage,
  UsageQuery,
  UsageRow,
  UsageServiceLike,
  UsageStats,
  UsageStatus,
  UsageSummary,
} from './types.ts'

const EMPTY_TOTALS = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costMicros: '0',
} as const

export class UsageService extends Service implements UsageServiceLike {
  static Config = USAGE_CONFIG_SCHEMA

  /**
   * 不 inject account-priority 与 pricing：它们被禁用时，用量服务仍应能提供历史查询
   * （D5：禁用某个插件只关闭它自己的入口）。两者都在运行期按需解析。
   */
  static inject: readonly string[] = []

  static catalog = {
    capabilities: ['usage-log', 'usage-query'],
    events: [],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: 'SQLite 用量库（token 事实，不含费用）' }],
    shapes: {
      UsageRow: {
        description: '一条请求用量；costMicros 是读取时按价格表算的',
        fields: {
          id: { type: 'integer' },
          reqId: { type: 'string' },
          userId: { type: 'integer' },
          apiKeyName: { type: 'string' },
          model: { type: 'string' },
          inputTokens: { type: 'integer' },
          outputTokens: { type: 'integer' },
          cacheReadTokens: { type: 'integer' },
          cacheWriteTokens: { type: 'integer' },
          totalTokens: { type: 'integer' },
          costMicros: { type: 'string' },
          durationMs: { type: 'integer' },
          clientIp: { type: 'string', optional: true },
          startedAt: { type: 'string' },
        },
      },
    },
  } as const

  readonly config: ResolvedUsageConfig
  private readonly logger: Logger
  private ready = false
  private polling = false

  constructor(ctx: Context, config: UsageConfig | ResolvedUsageConfig = {}) {
    super(ctx, 'usage')
    this.config = {
      dataPath: config.dataPath ?? USAGE_DEFAULTS.dataPath,
      retentionDays: config.retentionDays ?? USAGE_DEFAULTS.retentionDays,
      pollIntervalMs: config.pollIntervalMs ?? USAGE_DEFAULTS.pollIntervalMs,
      maxBatch: config.maxBatch ?? USAGE_DEFAULTS.maxBatch,
    }
    this.logger = ctx.logger('usage')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.ready = true
    this.logger.info(`用量插件已装载：存储 ${this.config.dataPath ?? ':memory:'}；保留 ${this.config.retentionDays} 天`)
    yield () => {
      this.ready = false
    }
  }

  // ───────────────────────────────── 写

  ingest(_entry: UsageEntry): void {
    this.assertReady()
    // 实现随 feat/usage-core 落地：幂等写入 + 价格快照读取在查询侧。
  }

  // ───────────────────────────────── 读

  list(_query: UsageQuery): UsageListPage {
    this.assertReady()
    return { items: [], nextCursor: null }
  }

  summary(_query: UsageQuery): UsageSummary {
    this.assertReady()
    return { totals: { ...EMPTY_TOTALS }, daily: [], models: [] }
  }

  stats(_nowMs?: number): UsageStats {
    this.assertReady()
    return {
      today: { ...EMPTY_TOTALS },
      total: { ...EMPTY_TOTALS },
      series: [],
      models: [],
      topUsers: [],
    }
  }

  exportRows(_query: UsageQuery, _limit?: number): readonly UsageRow[] {
    this.assertReady()
    return []
  }

  status(): UsageStatus {
    return {
      records: 0,
      epoch: null,
      lastSeq: 0,
      polling: this.polling,
      pricingAvailable: this.pricingSeam() !== undefined,
    }
  }

  // ───────────────────────────────── 内部

  /** 运行期解析价格服务，不 inject（D5）。 */
  private pricingSeam(): unknown {
    const impl = this.ctx.root.reflect._getImpl('pricing', false)
    if (impl === undefined) return undefined
    return impl.value
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new Error('用量插件尚未装载完成')
    }
  }
}
