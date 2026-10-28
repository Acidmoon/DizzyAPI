/**
 * 金额换算：元（十进制字符串）↔ 整数微元。
 *
 * 1 元 = 1_000_000 微元；全程 BigInt，**不经过浮点**（AGENTS.md §2.4.3）。
 * 订单金额只信任这里解析出来的整数微元，绝不用 `Number` / `parseFloat`。
 */
import { TopupError } from './errors.ts'

export const MICROS_PER_YUAN = 1_000_000n

/** 最多 15 位整数 + 最多 6 位小数（与定金 / 对账需要的精度一致）。 */
const YUAN_PATTERN = /^(\d{1,15})(?:\.(\d{1,6}))?$/

/** 「元」字符串 → 整数微元。空串 / 负数 / 科学计数法 / 超长小数一律明确失败。 */
export function parseYuanToMicros(value: unknown): bigint {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') {
    throw new TopupError('TOPUP_AMOUNT_INVALID', '金额不能为空（单位：元，最多 6 位小数）')
  }
  const match = YUAN_PATTERN.exec(text)
  if (match === null) {
    throw new TopupError(
      'TOPUP_AMOUNT_INVALID',
      `金额必须是形如 "10" / "99.5" 的非负十进制数（最多 6 位小数），收到 ${JSON.stringify(value)}`,
    )
  }
  const whole = BigInt(match[1] as string)
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'))
  const micros = whole * MICROS_PER_YUAN + fraction
  if (micros <= 0n) {
    throw new TopupError('TOPUP_AMOUNT_INVALID', '金额必须大于 0')
  }
  return micros
}

/** 整数微元 → 「元」字符串（去尾零）；只用于展示与错误文案。 */
export function formatMicrosAsYuan(micros: bigint): string {
  const negative = micros < 0n
  const abs = negative ? -micros : micros
  const whole = abs / MICROS_PER_YUAN
  const fraction = (abs % MICROS_PER_YUAN).toString().padStart(6, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole.toString()}${fraction === '' ? '' : `.${fraction}`}`
}
