/**
 * 金额与数量的格式化（**整数微元，不经浮点**）。
 *
 * 纪律：余额 / 费用在服务端与接口里都是**整数最小单位**（微元，
 * 1 元 = 1_000_000 微元）的**十进制字符串**。前端要显示成「元」时，
 * **不许用 `Number(micros) / 1_000_000`**——那是浮点，微元级的大数会丢精度。
 *
 * 这里的做法是**在字符串上做除法**：
 * 整数部分 = 前 6 位，小数部分 = 后 6 位（不足补 0），全程不经过 `Number`。
 *
 * 「分」这个单位只用于**服务端已经算好的粗口径**（`balanceCents` / `costCents`），
 * 那些是 `number` 且本来就是整数，所以直接格式化即可。
 */

/** 1 元 = 1_000_000 微元。 */
export const MICROS_PER_YUAN = 1_000_000
/** 1 元 = 100 分。 */
export const CENTS_PER_YUAN = 100

/**
 * 微元（十进制字符串）→「元」（两位小数的字符串）。
 *
 * 例：`"1137940000"` → `"1137.94"`；`"5"` → `"0.000005"`（不足两位补零，不四舍五入——
 * **宁可显示多一点位，也不要丢钱**；要固定两位时用 `formatMicrosYuan`）。
 */
export function formatMicrosYuan(micros: string): string {
  const negative = micros.startsWith('-')
  const digits = negative ? micros.slice(1) : micros
  if (!/^\d+$/.test(digits)) return micros
  const padded = digits.padStart(7, '0')
  const whole = padded.slice(0, padded.length - 6)
  const fraction = padded.slice(padded.length - 6)
  const trimmed = fraction.replace(/0+$/, '')
  const body = trimmed === '' ? whole : `${whole}.${trimmed}`
  return negative ? `-${body}` : body
}

/**
 * 微元（十进制字符串）→「¥1,137.94」这样**固定两位小数**的展示串。
 *
 * 小数部分**截断**（不四舍五入）：显示上宁可少一分，也不要把「1.999999 元」显示成
 * 「2.00 元」——金额对不上账比难看更麻烦。要看完整精度用 `formatMicrosYuan`。
 * 因此 |微元| < 10000 的小额在这里会显示成 `¥0.00`，这是刻意的。
 */
export function formatMicrosYuanFixed(micros: string): string {
  const negative = micros.startsWith('-')
  const digits = negative ? micros.slice(1) : micros
  if (!/^\d+$/.test(digits)) return micros
  const padded = digits.padStart(7, '0')
  const whole = Number(padded.slice(0, padded.length - 6)).toLocaleString('en-US')
  const fraction = padded.slice(padded.length - 6).slice(0, 2)
  return `${negative ? '-' : ''}¥${whole}.${fraction}`
}

/**
 * 分（整数）→「¥1,137.94」。
 *
 * 分本来就是整数（不是浮点），所以这里用 `Number` 是安全的；
 * 但**不要**拿它去换算微元——那是两套口径。
 */
export function formatCentsYuan(cents: number): string {
  const negative = cents < 0
  const absolute = Math.abs(Math.trunc(cents))
  const whole = Math.trunc(absolute / CENTS_PER_YUAN).toLocaleString('en-US')
  const fraction = String(absolute % CENTS_PER_YUAN).padStart(2, '0')
  return `${negative ? '-' : ''}¥${whole}.${fraction}`
}

/**
 * 「元」的十进制字符串 → 微元的十进制字符串（**字符串拆分，不经浮点**）。
 *
 * 例：`"1137.94"` → `"1137940000"`。前端**只在展示时**用它，绝不用来算账。
 */
export function yuanToMicros(yuan: string): string {
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(yuan.trim())
  if (match === null) throw new Error('金额格式不对')
  const whole = match[1] as string
  const fraction = (match[2] ?? '').padEnd(6, '0')
  // 去掉前导零（`0.000001` 元 → `1` 微元，不是 `0000001`）：服务端收十进制整数字符串，
  // 前导零不会出错，但会让「同一笔钱两种写法」，比对 / 去重时是坑。
  return `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
}

/**
 * 数字列的展示（千分位）。
 *
 * 数字本身是 `number`（请求数、token 数），用 `toLocaleString` 没问题；
 * **金额不要走这里**——金额走上面的微元 / 分专用函数。
 */
export function formatCount(value: number): string {
  return Math.trunc(value).toLocaleString('en-US')
}
