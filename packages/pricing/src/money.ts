/**
 * 价格换算：十进制「元」↔ 整数微元，以及按 token 数算费用。
 *
 * 全程 BigInt，不出现浮点（AGENTS.md §2.4.3：金额用整数最小单位）。
 * 1 元 = 1_000_000 微元；价格单位是「元 / 百万 token」，
 * 所以 `费用(微元) = tokens × 单价(微元/百万) ÷ 1_000_000`。
 */
import type { ModelPrice, PricingSnapshot, TokenCounts } from './types.ts'

export const MICROS_PER_YUAN = 1_000_000n
export const TOKENS_PER_PRICE_UNIT = 1_000_000n

const YUAN_PATTERN = /^\d+(?:\.\d{1,6})?$/

/** 把「元」字符串/数字解析成整数微元。非法输入抛错，绝不静默截断。 */
export function parseYuanToMicros(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`价格必须是非负有限数，收到 ${String(value)}`)
    }
    // 数字的字符串形式可能是科学计数法（1e-7），不接受。
    return parseYuanToMicros(String(value))
  }
  const text = value.trim()
  if (text === '') return 0n
  if (!YUAN_PATTERN.test(text)) {
    throw new TypeError(`价格必须是形如 "12" / "3.75" 的非负十进制数（最多 6 位小数），收到 ${JSON.stringify(value)}`)
  }
  const [whole, fraction = ''] = text.split('.')
  const micros = (fraction + '000000').slice(0, 6)
  return BigInt(whole!) * MICROS_PER_YUAN + BigInt(micros)
}

/** 规范化为十进制字符串（去掉多余的前导零与末尾零）；用于入库与回显。 */
export function normalizeYuan(value: string | number): string {
  return formatMicrosAsYuan(parseYuanToMicros(value))
}

/** 整数微元 → 十进制「元」字符串。 */
export function formatMicrosAsYuan(micros: bigint): string {
  if (micros < 0n) throw new TypeError('金额不能为负')
  const whole = micros / MICROS_PER_YUAN
  const fraction = (micros % MICROS_PER_YUAN).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`
}

/** 单价的四个分项（微元 / 百万 token）。 */
export interface PriceMicros {
  readonly input: bigint
  readonly output: bigint
  readonly cacheRead: bigint
  readonly cacheWrite: bigint
}

export function priceMicrosOf(price: ModelPrice): PriceMicros {
  return {
    input: parseYuanToMicros(price.inputPerMillion),
    output: parseYuanToMicros(price.outputPerMillion),
    cacheRead: parseYuanToMicros(price.cacheReadPerMillion),
    cacheWrite: parseYuanToMicros(price.cacheWritePerMillion),
  }
}

/**
 * 四舍五入到整数微元。
 *
 * 先累加全部分项再除一次：分项各自取整会把误差放大到 4 倍。
 */
export function quoteMicrosOfPrice(price: ModelPrice, tokens: TokenCounts): bigint {
  const unit = priceMicrosOf(price)
  const numerator =
    BigInt(Math.max(tokens.inputTokens, 0)) * unit.input +
    BigInt(Math.max(tokens.outputTokens, 0)) * unit.output +
    BigInt(Math.max(tokens.cacheReadTokens, 0)) * unit.cacheRead +
    BigInt(Math.max(tokens.cacheWriteTokens, 0)) * unit.cacheWrite
  return (numerator + TOKENS_PER_PRICE_UNIT / 2n) / TOKENS_PER_PRICE_UNIT
}

/**
 * 按快照查价并算费用：精确模型名优先，其次 `'*'` 兜底，都没有就是 0。
 *
 * 找不到价格返回 0 而不是报错：自托管网关的模型名不受控，缺价不应该让整页查询失败。
 * 调用方要区分「没配价」与「价格为 0」，用 `priceOfModel()` 判断。
 */
export function quoteMicrosOf(prices: PricingSnapshot, model: string, tokens: TokenCounts): bigint {
  const price = priceOfModel(prices, model)
  return price === null ? 0n : quoteMicrosOfPrice(price, tokens)
}

export function priceOfModel(prices: PricingSnapshot, model: string): ModelPrice | null {
  return prices.get(model) ?? prices.get('*') ?? null
}
