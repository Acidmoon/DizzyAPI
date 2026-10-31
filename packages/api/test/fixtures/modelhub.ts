/**
 * 模型广场夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 *
 * `withProbe` 用来验**纯增量**：默认 `false`（响应里没有 `probe` 键，与改造前逐字一致），
 * 置 `true` 才带上探测字段。
 */
import type {
  ModelCatalogLike,
  ModelHubPort,
} from '../../src/types.ts'
import type { ModelProbeLike, ModelProbeSummaryLike } from '../../src/views/catalog.ts'
import { DomainError } from './support.ts'

/** 带探测字段的目录形状（与 `views/catalog.ts` 的交叉类型一致）。 */
type CatalogWithProbe = ModelCatalogLike & { probe?: ModelProbeSummaryLike }
/** 带探测字段的条目。 */
type EntryWithProbe = ModelCatalogLike['available'][number] & { probe?: ModelProbeLike }
type UnavailableWithProbe = ModelCatalogLike['unavailable'][number] & { probe?: ModelProbeLike }

function probeOf(): ModelProbeLike {
  return {
    probed: true,
    health: 'degraded',
    consecutiveFailures: 1,
    lastOkAtMs: 1_700_000_000_000,
    lastTestedAtMs: 1_700_000_100_000,
    points: [
      {
        status: 'failed',
        latencyMs: 2_400,
        httpStatus: 503,
        errorCode: 'MODEL_NOT_SERVED',
        testedAtMs: 1_700_000_100_000,
      },
      {
        status: 'ok',
        latencyMs: 180,
        httpStatus: 200,
        errorCode: null,
        testedAtMs: 1_700_000_000_000,
      },
    ],
  }
}

function probeSummaryOf(): ModelProbeSummaryLike {
  return {
    enabled: true,
    running: false,
    blockedReason: null,
    blockedDetail: null,
    lastPassAt: '2026-10-31T00:00:00.000Z',
    failureThreshold: 3,
    downCount: 0,
  }
}

/** 模型广场服务的假实现：只覆盖 HTTP 层要观察的行为。 */
export class FakeModelHub implements ModelHubPort {
  readonly calls: { readonly query?: unknown }[] = []
  /** 设置后 catalog 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined
  /** 置 true 才带探测字段（默认不带，用来钉「既有形状不变」）。 */
  withProbe = false
  /** 置非 null 时把探测停摆原因塞进汇总（验页面能看见的那条）。 */
  blockedReason: string | null = null
  blockedDetail: string | null = null

  catalog(query?: {
    readonly search?: string
    readonly availability?: 'all' | 'available' | 'unavailable'
    readonly priced?: 'all' | 'priced' | 'unpriced'
  }): ModelCatalogLike {
    this.calls.push({ query })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：目录查询失败')

    const price = {
      model: 'deepseek-chat',
      inputPerMillion: '2',
      outputPerMillion: '8',
      cacheReadPerMillion: '0.5',
      cacheWritePerMillion: '0',
      currency: 'CNY',
      updatedAt: '2026-10-19T00:00:00.000Z',
    }

    const available: EntryWithProbe = {
      model: 'deepseek-chat',
      priced: true,
      price,
      accountCount: 3,
      healthyAccountCount: 2,
      protocols: ['openai-chat'],
      upstreamModels: ['deepseek-chat-2026'],
      mapped: true,
    }
    const unavailable: UnavailableWithProbe = {
      model: 'deepseek-reasoner',
      reason: 'no_healthy_account',
      detail: '提供这个模型的账号当前都不可用（停用、凭据缺失或健康检查未通过）',
      accountCount: 1,
      price: null,
      priced: false,
    }

    const catalog: CatalogWithProbe = {
      available: [available],
      unavailable: [unavailable],
      summary: {
        total: 2,
        availableCount: 1,
        unavailableCount: 1,
        pricedCount: 1,
        accountCount: 4,
      },
    }

    if (this.withProbe) {
      available.probe = probeOf()
      catalog.probe = {
        ...probeSummaryOf(),
        blockedReason: this.blockedReason,
        blockedDetail: this.blockedDetail,
      }
    }
    return catalog
  }
}
