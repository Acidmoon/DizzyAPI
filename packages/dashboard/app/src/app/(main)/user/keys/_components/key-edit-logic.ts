/**
 * API 密钥编辑弹窗与「点密钥复制」的**纯逻辑**（不 import React / Next / UI 组件）。
 *
 * 为什么单独一个文件：仓库根的 `pnpm test` 跑在**没有 React** 的环境里，
 * 直接 import `.tsx` 会在 `import * as React` 那一行就崩——可测的逻辑必须与渲染分离。
 *
 * 四条纪律（都来自 owner 的原始要求与 AGENTS.md）：
 * 1. **只发改了的字段**：服务端按字段逐项 diff；把没改的也发过去等于制造「把 X 改成 X」。
 * 2. **「不限」是 `null`，不是 `0` / 空串**：`expiresAt` / `spendingLimitMicros` /
 *    `concurrencyLimit` 三个都是 `null` = 不限，`0` 在服务端是**非法值**（明确拒绝）。
 * 3. **金额是十进制字符串微元**：`"12.5"` 元 → `"12500000"`，全程字符串切片，
 *    `Number` / 浮点一次都不用（JSON number 会丢 >2^53 的精度）。
 * 4. **过期时间是「那一整天结束前有效」**：只让用户选日期，不下发「当天零点」——
 *    Go 那边是 `now >= expiresAt` 就 401（`modules/keygate`），按零点下发等于当天一早即失效。
 */
/** 编辑弹窗的草稿：三个上限都用**字符串**承载输入框的原始文本，空串 = 不限。 */
export interface KeyEditDraft {
  readonly name: string
  readonly enabled: boolean
  /** 过期日 `YYYY-MM-DD`（本地时区）；空串 = 永不过期。 */
  readonly expiresOn: string
  /** 金额上限，按「元」填写；空串 = 不限。 */
  readonly spendingYuan: string
  /** 并发上限；空串 = 不限。 */
  readonly concurrency: string
}

/** 要提交的 patch：**只放真正改了的字段**，`null` 表示清空上限。 */
export interface KeyEditPatch {
  name?: string
  enabled?: boolean
  expiresAt?: string | null
  spendingLimitMicros?: string | null
  concurrencyLimit?: number | null
}

/**
 * 编辑弹窗要读的密钥字段。
 *
 * **故意结构化声明，不 import `@/lib/api` 的类型**：本文件要能被仓库根的
 * `tsc` 与 node 测试直接 import（根 tsconfig 没有 `@/*` 路径别名），
 * 而 `ApiKeySummaryView` 的形状本来就是这几项的子集，结构类型天然兼容。
 */
export interface KeyEditSource {
  readonly name: string
  readonly enabled: boolean
  /** ISO 8601；`null` = 永不过期。 */
  readonly expiresAt: string | null
  /** 整数微元的十进制字符串；`null` = 不限。 */
  readonly spendingLimitMicros: string | null
  /** `null` = 不限。 */
  readonly concurrencyLimit: number | null
}

/** 有符号两位填充。 */
function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * ISO 时间 → **本地时区**的 `YYYY-MM-DD`。
 *
 * 不能用 `iso.slice(0, 10)`：那取的是 UTC 日期，UTC+8 的用户会看到「昨天」。
 * `null` / 解析不出来 → 空串（= 永不过期），**不猜**。
 */
export function localDayOfIso(iso: string | null): string {
  if (iso === null || iso.trim() === '') return ''
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** `Date` → 本地时区 `YYYY-MM-DD`（日历控件选完日期后用）。 */
export function localDayTextOf(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** `YYYY-MM-DD` → **本地时区**当天零点；非法返回 `null`（含 `2026-02-30` 这类不存在的日子）。 */
export function localDayDate(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim())
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const dayOfMonth = Number(match[3])
  const date = new Date(year, month - 1, dayOfMonth, 0, 0, 0, 0)
  // `new Date(2026, 1, 30)` 会滚到 3 月 2 日；这里要的是「这个日子不存在就判非法」。
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== dayOfMonth) {
    return null
  }
  return date
}

/**
 * `YYYY-MM-DD` → **那一天结束**（本地 23:59:59.999）的 ISO 字符串。
 *
 * 非法日期返回 `null`（调用方按「非法输入」处理，不发请求）。
 */
export function endOfLocalDayIso(day: string): string | null {
  const date = localDayDate(day)
  if (date === null) return null
  date.setHours(23, 59, 59, 999)
  return date.toISOString()
}

/**
 * 「元」的十进制文本 → 微元十进制字符串（**字符串拼接，不经浮点**）。
 *
 * - `"12.5"` → `"12500000"`
 * - `"0.000001"` → `"1"`
 * - `"1"` → `"1000000"`
 * - 非法（负数 / 多于 6 位小数 / 空 / 非数字 / 超过 15 位整数）→ `null`，**不猜**。
 */
export function yuanTextToMicrosText(yuan: string): string | null {
  const trimmed = yuan.trim()
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(trimmed)
  if (match === null) return null
  const whole = match[1] as string
  const fraction = (match[2] ?? '').padEnd(6, '0')
  const combined = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  return combined === '' ? '0' : combined
}

/**
 * 微元十进制字符串 → 「元」的十进制文本（**不分组、不带单位**，直接回填输入框）。
 *
 * 回填值必须能被 {@link yuanTextToMicrosText} 原样解析回去（两位互为逆运算），
 * 所以**不能**用 `formatYuan`——那个带千分位与「元」字，粘回输入框就非法了。
 *
 * - `"12500000"` → `"12.5"`
 * - `"1000000"` → `"1"`
 * - `"1"` → `"0.000001"`
 * - 非整数字符串 → 空串（视为「不限」，不猜）。
 */
export function microsToYuanText(micros: string | null): string {
  if (micros === null) return ''
  const trimmed = micros.trim()
  if (!/^\d+$/.test(trimmed)) return ''
  const digits = trimmed.replace(/^0+(?=\d)/, '')
  const padded = digits.padStart(7, '0')
  const whole = padded.slice(0, padded.length - 6)
  const fraction = padded.slice(padded.length - 6).replace(/0+$/, '')
  return fraction === '' ? whole : `${whole}.${fraction}`
}

/** 十进制整数去前导零（`"0005"` → `"5"`），用于「改没改」的比较。 */
function canonicalDecimal(text: string): string {
  const trimmed = text.trim()
  return trimmed.replace(/^0+(?=\d)/, '')
}

/**
 * 并发上限输入 → `number | null | "invalid"`。
 *
 * - 空串 = **不限**（`null`），不是 0；
 * - 只接受正整数：`0` / 负数 / 小数 / 夹杂其它字符全算非法；
 * - 超过 `Number.MAX_SAFE_INTEGER` 也算非法（服务端存的是整数）。
 */
export function parseConcurrency(text: string): number | null | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return 'invalid'
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) return 'invalid'
  return value
}

/** 用现有密钥造草稿（三个上限回填成可读文本）。 */
export function keyEditDraftOf(source: KeyEditSource): KeyEditDraft {
  return {
    name: source.name,
    enabled: source.enabled,
    expiresOn: localDayOfIso(source.expiresAt),
    spendingYuan: microsToYuanText(source.spendingLimitMicros),
    concurrency: source.concurrencyLimit === null ? '' : String(source.concurrencyLimit),
  }
}

/**
 * 草稿的就地错误提示（`null` = 可以提交）。
 *
 * 只做**形状**校验：具体上限（例如微元上限 `Number.MAX_SAFE_INTEGER`）由服务端说了算，
 * 前端复制一份枚举值只会在服务端调整后变成「挡住合法输入」。
 */
export function keyEditError(draft: KeyEditDraft): string | null {
  if (draft.name.trim() === '') return '名称不能为空'
  if (draft.expiresOn.trim() !== '' && localDayDate(draft.expiresOn) === null) {
    return '过期日期不合法，应为 YYYY-MM-DD'
  }
  if (draft.spendingYuan.trim() !== '') {
    const micros = yuanTextToMicrosText(draft.spendingYuan)
    if (micros === null) return '金额上限要填正数，最多 6 位小数'
    if (canonicalDecimal(micros) === '0') return '金额上限要大于 0；不限就留空'
  }
  if (parseConcurrency(draft.concurrency) === 'invalid') {
    return '并发上限要留空（不限）或填正整数'
  }
  return null
}

/**
 * 算 patch：**没改的键一个都不放**；非法输入返回 `"invalid"`（调用方不发请求）。
 *
 * 「改没改」按**语义**比，不按字符串比：
 * - 过期时间比「本地日期」，所以服务端存的 `…T00:00:00.000Z` 只要落在同一天就不算改动
 *   （否则用户什么都没动、保存一下就把过期时间往后推了一整天）；
 * - 金额比去前导零后的十进制串；
 * - 并发比数字。
 */
export function keyEditPatchOf(draft: KeyEditDraft, before: KeyEditSource): KeyEditPatch | 'invalid' {
  if (keyEditError(draft) !== null) return 'invalid'

  const patch: KeyEditPatch = {}

  const name = draft.name.trim()
  if (name !== before.name) patch.name = name

  if (draft.enabled !== before.enabled) patch.enabled = draft.enabled

  const day = draft.expiresOn.trim()
  if (day !== localDayOfIso(before.expiresAt)) {
    if (day === '') {
      patch.expiresAt = null
    } else {
      const iso = endOfLocalDayIso(day)
      if (iso === null) return 'invalid'
      patch.expiresAt = iso
    }
  }

  const spending = draft.spendingYuan.trim()
  const nextMicros = spending === '' ? null : yuanTextToMicrosText(spending)
  if (nextMicros === null && spending !== '') return 'invalid'
  const beforeMicros =
    before.spendingLimitMicros === null ? null : canonicalDecimal(before.spendingLimitMicros)
  const comparableNext = nextMicros === null ? null : canonicalDecimal(nextMicros)
  if (comparableNext !== beforeMicros) patch.spendingLimitMicros = comparableNext

  const concurrency = parseConcurrency(draft.concurrency)
  if (concurrency === 'invalid') return 'invalid'
  if (concurrency !== before.concurrencyLimit) patch.concurrencyLimit = concurrency

  return patch
}

/**
 * 「点密钥那一格」要复制的目标。
 *
 * 三条硬要求：
 * 1. 复制的是**完整 `secret`**，不是 `maskedKey`（掩码复制出去等于给用户一个坏 key）；
 * 2. `secret` 为 `null`（未来的受限视图）→ **不可复制**并给出原因，绝不复制空串；
 * 3. 显示文本始终是**掩码**：完整 key 不进 DOM 文本（只经剪贴板 API 出去）。
 */
export type KeyCopyTarget =
  | { readonly copyable: true; readonly secret: string; readonly label: string }
  | { readonly copyable: false; readonly label: string; readonly reason: string }

export function keyCopyTargetOf(key: {
  readonly maskedKey: string
  readonly secret: string | null
}): KeyCopyTarget {
  if (key.secret === null || key.secret === '') {
    return {
      copyable: false,
      label: key.maskedKey,
      reason: '服务端这次没有下发完整密钥，无法复制',
    }
  }
  return { copyable: true, secret: key.secret, label: key.maskedKey }
}
