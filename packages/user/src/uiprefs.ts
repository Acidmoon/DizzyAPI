/**
 * 界面偏好（字号档位 / 字距）：**校验与默认值的唯一源**。
 *
 * 存哪：`users.ui_preferences`（TEXT，JSON）。`user` 插件是用户数据的唯一写者，
 * 所以这个字段也归它，`web` 只经服务读、不碰库。
 *
 * 为什么存 JSON 而不是两列：这类偏好会继续长（侧栏顺序 `navOrder` 就要进来），
 * 一列 JSON 加字段不用再动 schema；但**校验必须在这里做死**——坏值一律回落默认，
 * 绝不把「用户看着像空白的页面」的原因丢给 CSS。
 *
 * 取值集合刻意很小（四档字号 / 三档字距）：这是「让用户微调」不是「做主题市场」，
 * 档位多了既难保证对比度，也没法在图表几何里全部验一遍。
 */

/** 字号档位：乘在 `--fs-*` 的基准上（`--font-scale`）。 */
export const FONT_SCALES = [0.875, 1, 1.25, 1.5] as const
export type FontScale = (typeof FONT_SCALES)[number]

/**
 * 字距档位（存 token 名，不存 em 值）。
 *
 * 为什么不在库里存 `0.01em`：那是**样式**，归 `page-template` 的 token 管；
 * 数据层只该记「用户选了哪一档」。这样调设计 token 时不用迁移旧数据。
 */
export const LETTER_SPACINGS = ['tight', 'normal', 'wide'] as const
export type LetterSpacing = (typeof LETTER_SPACINGS)[number]

export interface UiPreferences {
  readonly fontScale: FontScale
  readonly letterSpacing: LetterSpacing
  /**
   * 侧栏导航顺序：**路径数组**（`/console/usage` 这种），空表示站默认顺序。
   *
   * 只存「用户拖过的顺序」，**不存已知路径表**：`user` 插件不知道 `web` 有哪些页面
   * （那是渲染层的事，见「一个数据一个写者」）。所以这一列只做**结构校验**
   * （是字符串数组、去重、限长），「未知路径丢弃 + 缺的补到末尾」在 `web` 渲染时做——
   * 它才知道当前有哪些导航项，而且**新加一个页面时老用户的偏好必须能自动跟上**。
   */
  readonly navOrder: readonly string[]
}

/** 默认值 = 「已放大一档」的基准（正文 16px），与改动前的观感一致。 */
export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  fontScale: 1,
  letterSpacing: 'normal',
  navOrder: [],
}

const ALLOWED_KEYS = new Set(['fontScale', 'letterSpacing', 'navOrder'])

/** 侧栏顺序的上限：远大于实际导航项数，防的是「一份被写坏的 JSON 撑爆页面」。 */
const MAX_NAV_ORDER = 64
/** 单个路经的长度上限（真实路径都在 40 字节以内）。 */
const MAX_NAV_PATH = 200

/** 校验一个 `fontScale` 候选值是不是允许的档位。 */
function toFontScale(value: unknown): FontScale | undefined {
  return (FONT_SCALES as readonly number[]).includes(value as number) ? (value as FontScale) : undefined
}

function toLetterSpacing(value: unknown): LetterSpacing | undefined {
  return (LETTER_SPACINGS as readonly string[]).includes(value as string)
    ? (value as LetterSpacing)
    : undefined
}

/**
 * 侧栏顺序的结构校验：只认「短字符串数组」，去重、限长、丢掉非字符串。
 *
 * **坏值一律回落空数组**（= 站默认顺序），不抛错：顺序错了最坏是侧栏顺序不随心，
 * 抛错会让整个页面打不开。`/` 开头是唯一的结构约束——真正的「这是不是我们站的路径」
 * 由渲染层判断（它才有那份表）。
 */
function toNavOrder(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const path = item.trim()
    if (!path.startsWith('/') || path.length > MAX_NAV_PATH) continue
    if (out.includes(path)) continue
    out.push(path)
    if (out.length >= MAX_NAV_ORDER) break
  }
  return out
}

/**
 * 解析库里的原始 JSON。
 *
 * **坏数据不抛错**：老库没有这一列是 `null`、手改库可能塞进垃圾，这些都只回落默认值。
 * 抛错会让用户连页面都打不开，而「字号不是他想要的那档」是可以忍受的。
 */
export function parseUiPreferences(raw: string | null | undefined): UiPreferences {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_UI_PREFERENCES
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_UI_PREFERENCES
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_UI_PREFERENCES
  }
  const record = parsed as Record<string, unknown>
  return {
    fontScale: toFontScale(record.fontScale) ?? DEFAULT_UI_PREFERENCES.fontScale,
    letterSpacing: toLetterSpacing(record.letterSpacing) ?? DEFAULT_UI_PREFERENCES.letterSpacing,
    navOrder: toNavOrder(record.navOrder) ?? DEFAULT_UI_PREFERENCES.navOrder,
  }
}

/**
 * 校验用户提交的补丁。
 *
 * @returns 合法返回合并后的偏好；非法返回**错误信息字符串**（调用方转 400）。
 *   未知字段直接拒绝——避免悄悄多出可写字段（与 `updateProfile` 同口径）。
 */
export function normalizeUiPreferencesPatch(
  current: UiPreferences,
  patch: unknown,
): UiPreferences | string {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return '界面偏好必须是对象'
  }
  const record = patch as Record<string, unknown>
  const unknown = Object.keys(record).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) return `未知的界面偏好字段：${unknown.join(', ')}`

  let fontScale = current.fontScale
  if (record.fontScale !== undefined) {
    const parsed = toFontScale(record.fontScale)
    if (parsed === undefined) return `字号只认 ${FONT_SCALES.join(' / ')}`
    fontScale = parsed
  }

  let letterSpacing = current.letterSpacing
  if (record.letterSpacing !== undefined) {
    const parsed = toLetterSpacing(record.letterSpacing)
    if (parsed === undefined) return `字距只认 ${LETTER_SPACINGS.join(' / ')}`
    letterSpacing = parsed
  }

  let navOrder = current.navOrder
  if (record.navOrder !== undefined) {
    if (!Array.isArray(record.navOrder)) return '侧栏顺序必须是路径数组'
    navOrder = toNavOrder(record.navOrder) ?? []
  }

  return { fontScale, letterSpacing, navOrder }
}

/** 序列化成库里的那一列（键顺序固定，便于人工比对）。 */
export function serializeUiPreferences(prefs: UiPreferences): string {
  return JSON.stringify({
    fontScale: prefs.fontScale,
    letterSpacing: prefs.letterSpacing,
    navOrder: prefs.navOrder,
  })
}

/** 中文标签：页面下拉与审计摘要共用，避免两处各写一套文案。 */
export const FONT_SCALE_LABELS: Readonly<Record<FontScale, string>> = {
  0.875: '小（正文 14px）',
  1: '标准（正文 16px）',
  1.25: '大（正文 20px）',
  1.5: '特大（正文 24px）',
}

export const LETTER_SPACING_LABELS: Readonly<Record<LetterSpacing, string>> = {
  tight: '紧凑',
  normal: '标准',
  wide: '宽松',
}
