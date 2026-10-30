/**
 * 金额 / 时间 / token / 时长的**唯一**格式化源（用户侧与管理员侧共用，别在页面里各写一套）。
 *
 * 三条硬规矩，都来自 AGENTS.md 与 owner 的原始要求：
 *
 * 1. **金额是整数最小单位，禁止浮点**。1 元 = 1_000_000 微元（= 最小单位），
 *    1 分 = 10_000 微元。本文件所有除法一律走 BigInt，`Number` / `toFixed` / `/` 一次都不用，
 *    否则 0.1 + 0.2 那一类误差会直接进到用户看到的账单上。
 * 2. **未知就是未知**：`ttftMs === null` 渲染成「—（未采集）」，不是 `0 毫秒`；
 *    金额解析失败渲染成「—」，不假装是 0。
 * 3. **本文件不许 import 任何东西**（React / Next / UI 组件一个都不行）：
 *    它要能被仓库根的 `tsc` 与 node 测试直接 import（`packages/dashboard/test/format.test.ts`）。
 *
 * 展示口径：金额默认保留最多 6 位小数（微元精度），尾部零去掉但至少留 2 位，
 * 这样 `0.000161` 不会显示成 `0.00`，`1.00` 也不会显示成 `1`。
 */

/** 1 元 = 1_000_000 微元（= 最小单位；充值 / 兑换的 `amountMinor` / `amountMicro` 同口径）。 */
export const MICROS_PER_YUAN = 1_000_000n

/** 1 元 = 100 分。 */
export const CENTS_PER_YUAN = 100n

/** 金额无法解析时的占位（不是 0）。 */
export const UNKNOWN_AMOUNT = '—'

/** 未采集的占位（TTFT 旧记录就是 null）。 */
export const NOT_COLLECTED = '—（未采集）'

/** 千位分隔：只处理 `0-9`，负数与小数由调用方先拆好。 */
function groupThousands(digits: string): string {
  let out = ''
  for (let i = 0; i < digits.length; i += 1) {
    const rest = digits.length - i
    out += digits[i]
    if (rest > 1 && rest % 3 === 1) out += ','
  }
  return out
}

/** 把绝对值按 `scaleDigits` 位小数切开，再按 `decimals` 位输出（尾部零去掉，至少 2 位）。 */
function formatScaled(absolute: bigint, scaleDigits: number, decimals: number): string {
  const unit = 10n ** BigInt(scaleDigits)
  const integer = absolute / unit
  const fraction = absolute % unit
  const padded = fraction.toString().padStart(scaleDigits, '0')
  const kept = padded.slice(0, Math.min(decimals, scaleDigits))
  const trimmed = kept.replace(/0+$/, '')
  const shown = trimmed.length >= 2 ? trimmed : trimmed.padEnd(2, '0')
  return `${groupThousands(integer.toString())}.${shown}`
}

/**
 * 整数微元 → 「1,234.567890」这样的十进制字符串（不带「元」字，调用方自己拼单位）。
 *
 * - `"0"` → `"0.00"`
 * - `"161"` → `"0.000161"`（不是 `0.00`，小额消费必须看得见）
 * - `"1000000"` → `"1.00"`
 * - `"-161"` → `"-0.000161"`（余额允许为负 = 后付费）
 * - 非整数字符串（`""` / `"1.5"` / `"abc"`）→ `"—"`，不猜
 */
export function formatMicrosAsYuan(micros: string | bigint | null | undefined, decimals = 6): string {
  if (micros === null || micros === undefined) return UNKNOWN_AMOUNT
  const text = typeof micros === 'bigint' ? micros.toString() : micros.trim()
  if (!/^-?\d+$/.test(text)) return UNKNOWN_AMOUNT
  const value = BigInt(text)
  const negative = value < 0n
  const absolute = negative ? -value : value
  if (value === 0n) return formatScaled(0n, 6, decimals)
  return `${negative ? '-' : ''}${formatScaled(absolute, 6, decimals)}`
}

/**
 * 整数分（`/api/usage` 的 `balances.paidCents`、`costCents`）→ 「1,234.56」。
 *
 * `cents` 是 JS number，但这里先转 BigInt 再做除法，`Number.MAX_SAFE_INTEGER` 以内都精确。
 */
export function formatCentsAsYuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return UNKNOWN_AMOUNT
  const value = BigInt(Math.trunc(cents))
  const negative = value < 0n
  const absolute = negative ? -value : value
  return `${negative ? '-' : ''}${formatScaled(absolute, 2, 2)}`
}

/** 带单位：`1,234.56 元`。 */
export function formatYuan(micros: string | bigint | null | undefined, decimals = 6): string {
  const text = formatMicrosAsYuan(micros, decimals)
  return text === UNKNOWN_AMOUNT ? text : `${text} 元`
}

/** token 数：千位分隔，负数与小数不进（token 一定是非负整数）。 */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined || !Number.isFinite(count)) return UNKNOWN_AMOUNT
  const value = Math.trunc(count)
  const negative = value < 0
  const digits = Math.abs(value).toString()
  return `${negative ? '-' : ''}${groupThousands(digits)}`
}

/**
 * 耗时：`456 毫秒` / `1.23 秒` / `12 秒`。
 *
 * 用整数拆毫秒，不做 `ms / 1000` 的浮点除法（四舍五入进位单独处理）。
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNKNOWN_AMOUNT
  const total = Math.max(0, Math.trunc(ms))
  if (total < 1_000) return `${total} 毫秒`
  const whole = Math.trunc(total / 1_000)
  const fraction = Math.round((total % 1_000) / 10)
  if (fraction === 100) return `${whole + 1} 秒`
  const trimmed = fraction.toString().padStart(2, '0').replace(/0+$/, '')
  return trimmed === '' ? `${whole} 秒` : `${whole}.${trimmed} 秒`
}

/** 首字延迟：`null` = 未采集（旧记录），**不是** 0 毫秒。 */
export function formatTtftMs(ttftMs: number | null | undefined): string {
  if (ttftMs === null || ttftMs === undefined || !Number.isFinite(ttftMs)) return NOT_COLLECTED
  return formatDurationMs(ttftMs)
}

/** ISO 时间 → 本地时区 `2026-10-30 13:36`。`timeZone` 只为测试可复现而开放。 */
export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  }
  const parts = new Intl.DateTimeFormat('zh-CN', options).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`
}

/** ISO 时间 → 本地时区 `2026-10-30`。 */
export function formatDate(iso: string | null | undefined, timeZone?: string): string {
  const text = formatDateTime(iso, timeZone)
  return text === '—' ? text : text.slice(0, 10)
}

/**
 * 图表 X 轴标签：`2026-10-30` → `10/30`。
 *
 * 入参是 `daily[].date`（服务端口径的 `YYYY-MM-DD`，不带时区），所以**只做字符串切分**，
 * 不经过 `Date`，避免 UTC+8 下被时区换算「挪一天」。
 */
export function formatMonthDayLabel(date: string | null | undefined): string {
  if (!date) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim())
  if (match === null) return date
  return `${match[2]}/${match[3]}`
}

/** 单个时间点（`HH:mm`）与日期（`MM/DD`）共用的轴标签：有冒号就当小时点。 */
export function formatAxisLabel(date: string): string {
  if (/^\d{2}:\d{2}$/.test(date)) return date
  return formatMonthDayLabel(date)
}

/** 百分比：`0.126` → `12.6%`（给「占比」这类展示用，不用于金额）。 */
export function formatPercent(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) return UNKNOWN_AMOUNT
  const scaled = Math.round(value * 100 * 10 ** decimals)
  const negative = scaled < 0
  const absolute = Math.abs(scaled)
  const unit = 10 ** decimals
  const whole = Math.trunc(absolute / unit)
  const fraction = (absolute % unit).toString().padStart(decimals, '0').replace(/0+$/, '')
  const head = `${negative ? '-' : ''}${whole}`
  return fraction === '' ? `${head}%` : `${head}.${fraction}%`
}

/** 金额 / token 通用的紧凑数字（图表轴用）：`12345` → `1.2万`。 */
export function formatCompact(count: number): string {
  if (!Number.isFinite(count)) return UNKNOWN_AMOUNT
  const absolute = Math.abs(count)
  if (absolute < 10_000) return formatTokens(count)
  const wan = Math.round(absolute / 1_000)
  const whole = Math.trunc(wan / 10)
  const fraction = wan % 10
  const head = `${count < 0 ? '-' : ''}${whole}`
  return fraction === 0 ? `${head}万` : `${head}.${fraction}万`
}
