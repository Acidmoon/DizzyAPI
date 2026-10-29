/**
 * views/common.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { BALANCE_MINOR_UNITS_PER_CENT } from '../config.ts'


/** 最小单位 → 整数分。1 分 = 10_000 个最小单位；超出安全整数时夹到边界。 */
export function centsOf(balance: bigint): number {
  const cents = balance / BALANCE_MINOR_UNITS_PER_CENT
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER
  if (cents < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER
  return Number(cents)
}


export function dateOf(value: Date): string {
  return value.toISOString().slice(0, 10)
}


/**
 * 整数微元 → 整数分（1 分 = 10_000 微元）。先做 BigInt 除法再转 number，
 * 避免 `Number(costMicros) / 10_000` 丢精度；解析失败按 0。
 */
export function costCentsOf(costMicros: string): number {
  try {
    return Number(BigInt(costMicros) / 10_000n)
  } catch {
    return 0
  }
}
