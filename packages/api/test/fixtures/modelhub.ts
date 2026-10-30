/**
 * 模型广场夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  ModelCatalogLike,
  ModelHubPort,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

/** 模型广场服务的假实现：只覆盖 HTTP 层要观察的行为。 */
export class FakeModelHub implements ModelHubPort {
  readonly calls: { readonly query?: unknown }[] = []
  /** 设置后 catalog 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined

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
    return {
      available: [
        {
          model: 'deepseek-chat',
          priced: true,
          price,
          accountCount: 3,
          healthyAccountCount: 2,
          protocols: ['openai-chat'],
          upstreamModels: ['deepseek-chat-2026'],
          mapped: true,
        },
      ],
      unavailable: [
        {
          model: 'deepseek-reasoner',
          reason: 'no_healthy_account',
          detail: '提供这个模型的账号当前都不可用（停用、凭据缺失或健康检查未通过）',
          accountCount: 1,
          price: null,
          priced: false,
        },
      ],
      summary: {
        total: 2,
        availableCount: 1,
        unavailableCount: 1,
        pricedCount: 1,
        accountCount: 4,
      },
    }
  }
}
