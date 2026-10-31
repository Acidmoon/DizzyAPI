/**
 * 用户侧页面共用的**纯逻辑**：状态标签、金额展示、时间文案。
 *
 * 为什么单独成文件（而不是塞进页面组件）：
 * - 这些是**契约翻译**（服务端的英文状态码 → 中文标签），要能被 node 测试逐字断言；
 * - `.tsx` 里写纯函数会拖 React 进类型检查，根仓库的 `tsc` 没有 DOM lib。
 *
 * 金额口径：**一律走 `@/lib/api` 的 `formatMicrosYuan` / `formatCentsYuan`**（整数微元，
 * 字符串上做除法，不经浮点）。本文件**不自己算钱**，只决定「哪个字段用哪个函数」。
 */

/** 充值订单状态 → 中文（服务端 `topupOrderOf()` 的 `status`）。 */
export const TOPUP_STATUS_LABELS: Readonly<Record<string, string>> = {
  pending: '待确认',
  paid: '已到账',
  canceled: '已取消',
  expired: '已过期',
}

/** 充值订单状态 → 徽标色（`default` / `secondary` / `destructive` / `outline`）。 */
export const TOPUP_STATUS_VARIANTS: Readonly<Record<string, 'default' | 'secondary' | 'destructive' | 'outline'>> = {
  pending: 'secondary',
  paid: 'default',
  canceled: 'outline',
  expired: 'destructive',
}

/** 充值订单状态 → 人话解释（给「为什么还没到账」那一栏）。 */
export const TOPUP_STATUS_HINTS: Readonly<Record<string, string>> = {
  pending: '订单已创建，等待管理员核对转账后确认到账。尚未接入在线支付，不会自动到账。',
  paid: '已确认到账，金额已加进余额。',
  canceled: '订单已取消，无法再确认到账。',
  expired: '订单已过期，需要重新下单。',
}

/** 模型可用性 → 中文。 */
export const AVAILABILITY_LABELS: Readonly<Record<string, string>> = {
  available: '可用',
  unavailable: '不可用',
}

/**
 * 模型不可用的原因码 → 中文。
 *
 * 服务端 `modelhub` 给的 `reason` 是稳定英文码，`detail` 已经是人话。
 * 这里给常见几个码的中文标签；**未知码直接显示原文**（别假装认识）。
 */
export const MODEL_REASON_LABELS: Readonly<Record<string, string>> = {
  no_account: '没有账号提供这个模型',
  disabled: '提供该模型的账号已停用',
  no_credential: '账号凭据未配置',
  credential_expired: '账号凭据已过期',
  unhealthy: '提供该模型的账号健康检查不通过',
  protocol_mismatch: '账号协议不匹配',
  no_price: '管理员尚未为该模型定价',
}

/** 兑换失败的稳定码 → 中文提示（服务端 `REDEEM_CODE_*`）。 */
export const REDEEM_ERROR_LABELS: Readonly<Record<string, string>> = {
  REDEEM_CODE_NOT_FOUND: '兑换码不存在',
  REDEEM_CODE_USED: '兑换码已被使用',
  REDEEM_CODE_DISABLED: '兑换码已被停用',
  REDEEM_CODE_EXPIRED: '兑换码已过期',
  REDEEM_CODE_REDEEMING: '兑换码正在兑换中，请稍后再试',
  REDEEM_FAILED: '兑换失败',
}

/** 兑换码错误码 → 人话（服务端不把码本身放进消息里，前端也不回显用户输入）。 */
export function redeemErrorMessage(code: string, fallback: string): string {
  return REDEEM_ERROR_LABELS[code] ?? fallback
}

/** 未知状态码 → 显示原文（不猜、不吞）。 */
export function statusLabel(table: Readonly<Record<string, string>>, status: string): string {
  return table[status] ?? status
}

/**
 * ISO 时间 → 本地时区 `2026-10-30 13:36`。
 *
 * 用 `Intl.DateTimeFormat` 而不是手写 `slice`：手动切 ISO 串得到的是 **UTC**，
 * 会让 UTC+8 的用户看到差 8 小时的时间。
 */
export function formatLocalDateTime(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? ''
  const hour = pick('hour') === '24' ? '00' : pick('hour')
  return `${pick('year')}-${pick('month')}-${pick('day')} ${hour}:${pick('minute')}`
}

/**
 * 「元」的小数金额 → 微元（**字符串拆分，不经浮点**）。
 *
 * 服务端的充值接口收的是「元」的十进制字符串（`amountYuan`），最多 6 位小数。
 * 这里只做**校验 + 归一化**（去掉多余的小数位、补到 6 位），**不做任何算术**。
 *
 * 非法输入抛错（调用方给表单就地提示），不返回 0 ——「0 元」是合法输入，不能混。
 */
export function normalizeYuanInput(input: string): string {
  const text = input.trim()
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(text)
  if (match === null) throw new Error('金额格式不对：最多 12 位整数、6 位小数')
  const whole = match[1] as string
  const fraction = (match[2] ?? '').padEnd(6, '0')
  const micros = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  return micros === '' ? '0' : micros
}

/** 微元 → 「元」的下单输入框回填（保留 6 位，去掉尾零）。 */
export function microsToYuanInput(micros: string): string {
  const negative = micros.startsWith('-')
  const digits = negative ? micros.slice(1) : micros
  if (!/^\d+$/.test(digits)) return ''
  const padded = digits.padStart(7, '0')
  const whole = padded.slice(0, padded.length - 6)
  const fraction = padded.slice(padded.length - 6).replace(/0+$/, '')
  const body = fraction === '' ? whole : `${whole}.${fraction}`
  return negative ? `-${body}` : body
}
