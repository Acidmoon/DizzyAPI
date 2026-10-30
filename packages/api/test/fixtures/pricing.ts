/**
 * 模型价格夹具。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  ModelPriceLike,
  PricingPort,
} from '../../src/types.ts'

/** 假价格表：测试可以 `pricing.prices.set(...)`。 */
export class FakePricing implements PricingPort {
  prices = new Map<string, ModelPriceLike>()

  list(): readonly ModelPriceLike[] {
    return [...this.prices.values()]
  }

  get(model: string): ModelPriceLike | null {
    return this.prices.get(model) ?? null
  }

  async set(_actor: string, model: string, input: {
    inputPerMillion: string | number
    outputPerMillion: string | number
    cacheReadPerMillion?: string | number
    cacheWritePerMillion?: string | number
  }): Promise<ModelPriceLike> {
    const price: ModelPriceLike = {
      model,
      inputPerMillion: String(input.inputPerMillion),
      outputPerMillion: String(input.outputPerMillion),
      cacheReadPerMillion: String(input.cacheReadPerMillion ?? '0'),
      cacheWritePerMillion: String(input.cacheWritePerMillion ?? '0'),
      currency: 'CNY',
      updatedAt: '2026-10-19T12:00:00.000Z',
    }
    this.prices.set(model, price)
    return price
  }

  async remove(_actor: string, model: string): Promise<boolean> {
    return this.prices.delete(model)
  }
}
