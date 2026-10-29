/**
 * DeepSeek「用量信息」页的视觉规格（从原站实测得到，不是抄来的 CSS）。
 *
 * 这些数字是**对齐依据**：原站的 CSS 变量是构建产物，类名是哈希化的
 * （`_52145b6` 这种），不能直接搬。这里把「深色主题下实际生效的值」记下来，
 * 页面按这些值重写一遍，视觉上与原站一致。
 *
 * 取值来源：原站 `8191.07cf805714.css` 的深色变量块 + 截图逐像素采样。
 */

/** 深色主题下的别名变量（`body[data-ds-dark-theme]`）。 */
export const DARK_TOKENS = {
  bgBase: '#151517',
  bgLayer1: '#232324',
  bgLayer2: '#2C2C2E',
  bgLayer3: '#353638',
  bgModulePlatform: '#353638',
  bgOverlay: '#43454A',
  bgSkeletonStart: 'rgba(255,255,255,.06)',
  bgSkeletonEnd: 'rgba(255,255,255,.08)',
  sidebarFill: '#1B1B1C',
  borderL1: 'rgba(255,255,255,.06)',
  borderL2: 'rgba(255,255,255,.12)',
  borderL3: 'rgba(255,255,255,.16)',
  labelPrimary: '#F9FAFB',
  labelSecondary: '#CFD3D6',
  labelTertiary: '#ADB2B8',
  labelCaption: '#81858C',
  brandPrimary: '#F9FAFB',
  success: '#22C55E',
  successTertiary: '#233C2C',
  successSecondary: '#4ED17E',
  info: '#679EFE',
  interactiveBgActive: 'rgba(255,255,255,.14)',
  interactiveBgHover: 'rgba(255,255,255,.08)',
  /** 侧栏菜单激活底色：`--dsw-specific-sidebar-nav-item-active`。 */
  sidebarNavActive: '#43454A',
  sidebarNavHover: '#2C2C2E',
  /** 图表主色：原站柱状图实测 `#FD8D3C`；强调段 `#FED976`。 */
  chartPrimary: '#FD8D3C',
  chartSecondary: '#FED976',
  /** 图表网格线实测 `#4E4E50`（在 `#353638` 卡片上）。 */
  chartGrid: '#4E4E50',
  /** 坐标轴文字实测 `#838484`（12px）。 */
  chartAxisText: '#838484',
} as const

/** 尺寸与节奏（来自原站 CSS 的盒模型声明）。 */
export const METRICS = {
  sidebarWidth: 260,
  sidebarPadding: 12,
  mainPaddingX: 40,
  mainPaddingY: 32,
  mainGap: 32,
  contentMaxWidth: 936,
  cardRadius: 16,
  cardPaddingX: 20,
  cardPaddingY: 16,
  cardMinHeight: 100,
  cardGap: 12,
  cardRowGap: 12,
  filterRowMarginTop: 40,
  filterRowMarginBottom: 24,
  filterPillHeight: 36,
  filterPillRadius: 18,
  filterPillPaddingX: 14,
  filterPillGap: 12,
  filterPillMinWidth: 90,
  filterPillMaxWidth: 280,
  menuItemHeight: 42,
  menuItemRadius: 14,
  menuItemPaddingX: 16,
  menuItemGap: 2,
  menuIconSize: 18,
  menuIconMarginRight: 10,
  titleMarginBottom: 8,
  /** 图表卡内边距：20px 20px 12px。 */
  chartCardPaddingX: 20,
  chartCardPaddingTop: 20,
  chartCardPaddingBottom: 12,
  chartCardMinHeight: 335,
  chartHeaderGap: 10,
  chartHeaderMarginBottom: 13,
  /** 分段控件：26px 高、20px 圆角（字见 FONT_ROLES.chip）。 */
  segmentedHeight: 26,
  segmentedRadius: 20,
  segmentedPaddingX: 8,
  /** 模型分块：与上方间距 24px（标题字见 FONT_ROLES.emphasis）。 */
  modelBlockMarginTop: 24,
  /** 侧栏底部用户行的头像 32px。 */
  avatarSize: 32,
} as const

/**
 * 字号与行高的**唯一源**。
 *
 * 为什么要这张表：字号原先在 `assets.ts` 的 `PAGE_CSS` 里硬编码 39 处、在 `METRICS` 里
 * 另抄一份，两边**从来没有引用关系**，靠手工同步——必然会漂移。现在规定：
 *
 * - 这份表是唯一源，`PAGE_CSS` 的 `:root` 里 `--fs-<role>` / `--lh-<role>` 由它派生；
 * - 用例断言「表里的 size」与「CSS 里 `--fs-<role>` 的值」逐条相等（防漂移护栏）。
 *
 * `lineHeight` 是**无单位倍数**：`1.5 × font-size`，所以用户把字号调大时行高自动跟随。
 * 若写成 px，用户选「特大」时正文 16→24px 会压在 22px 行高上 → 文字重叠。
 *
 * 档位是 2026-10-29 全站整体上调一档的结果（owner 要求「加大两号」）：
 * 原值 10/11/12/13/14/16/22/24/29 → 12/13/14/15/16/18/26/28/34。
 * `metric` 必须比 `title` 大——原先 29 对 24，若只涨标题到 28 而数值不动，层级就塌了。
 */
export const FONT_ROLES = {
  /** 徽标 / 极小字。 */
  micro: { size: 12, lineHeight: 1.4 },
  /** 分段控件、小标签。 */
  chip: { size: 13, lineHeight: 1.27 },
  /** 提示、表内小字、图表轴文字。 */
  caption: { size: 14, lineHeight: 1.5 },
  /** 字段标签、表格正文。 */
  label: { size: 15, lineHeight: 1.54 },
  /** 正文、按钮。 */
  body: { size: 16, lineHeight: 1.57 },
  /** 小标题、姓名、模型名。 */
  emphasis: { size: 18, lineHeight: 1.5 },
  /** 侧栏品牌字 / 登录页大标题。 */
  brand: { size: 26, lineHeight: 1.09 },
  /** 页面标题。 */
  title: { size: 28, lineHeight: 1.33 },
  /** 指标大数字。 */
  metric: { size: 34, lineHeight: 1.24 },
} as const

export type FontRole = keyof typeof FONT_ROLES

/**
 * 字距：**按角色分开**，不是全局一个值。
 *
 * 原因：`.side-word` 原本是 `letter-spacing: -.4px`（品牌字收紧是设计意图）。
 * 若全局加正字距，要么被它自己覆盖、要么把品牌字撑开。
 *
 * 以 em 表达，这样跟着字号一起缩放。
 */
export const LETTER_SPACING = {
  /** 正文 / 辅助 / 标题：略放宽，提升可读性（owner 要求「字间距放宽」）。 */
  normal: '0.01em',
  /** 品牌字与其他紧凑锁定：保持收紧，显得是「一个整体」。 */
  tight: '-0.02em',
} as const

/** 字体栈：原站用 `Inter` + 系统回退；不 vendor 字体文件。 */
export const FONT_STACK =
  'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'

/**
 * 数字格式化：图表轴上「800M / 1.6B / 2,500 / 5,000」这种简写。
 *
 * 原站刻度实测：`2,000` / `300M` / `600M` / `1M` / `2M`——
 * 一百万以下用千分位整数，一百万以上才折成 M/B，**没有 K 档**。
 */
export function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${trimZero(value / 1_000_000_000)}B`
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  return formatThousands(Math.round(value))
}

/** 千分位；小数值不显示小数点。 */
export function formatThousands(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 100) / 100
  const [int, frac] = Math.abs(rounded) === rounded
    ? [String(rounded), '']
    : String(rounded).split('.')
  const sign = rounded < 0 ? '-' : ''
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === '' ? `${sign}${grouped}` : `${sign}${grouped}.${frac}`
}

/** 金额：分 → `¥1,137.94`。 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const rest = abs % 100
  return `${sign}¥${formatThousands(yuan)}.${String(rest).padStart(2, '0')}`
}

/** 图表轴的日期标签：`9/23`（原站就是这种斜杠短格式）。 */
export function formatAxisDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (match === null) return iso
  return `${Number(match[2])}/${Number(match[3])}`
}

/**
 * 图表轴布局的三个魔数，集中在这里（原先散落在 `charts.ts` 两处重复的表达式里）。
 *
 * 历史：原站实测「字符数 × 7.5 + 7」是在**轴文字 12px** 下标定的，
 * 7.5 / 12 = **0.625 em/字符**。字号上调后若仍按 7.5 硬算，字宽被低估约 17%
 * → y 轴刻度会被 SVG 左边界裁掉。所以改成按字号派生。
 */
const AXIS_BASE_FONT_SIZE = 12
/** 每字符宽度（em）。`7.5 / 12`。 */
export const AXIS_CHAR_WIDTH_EM = 0.625
/** 轴刻度文字与绘图区左边界之间的间隙，按 12px 基准的像素值（会随字号缩放）。 */
export const AXIS_LABEL_GAP = 7
/** 左内边距下限（与字号无关，太窄会贴边）。 */
export const AXIS_PADDING_MIN = 22
/** 左内边距上限，按 12px 基准的像素值（会随字号缩放）。 */
export const AXIS_PADDING_MAX = 60

/**
 * 估算轴标签文字的像素宽度。
 *
 * @param text 刻度文本，例如 `600M`、`2,000`
 * @param fontSize 轴文字实际字号（已含用户字号档位缩放）
 */
export function estimateAxisLabelWidth(text: string, fontSize: number): number {
  return text.length * fontSize * AXIS_CHAR_WIDTH_EM
}

/**
 * 由最宽刻度文字算出绘图区左内边距。
 *
 * `charts.ts` 原先在两处各写了一遍 `min(60, max(22, ceil(width + 7)))`，
 * 现在收成这一份，两处共用。
 *
 * 上下限按字号同比缩放：否则用户把字号调到「特大」时，
 * 7 字符刻度（如 `800,000`）会顶到 60 的上限被裁掉——这 60 就是 12px 下的临界值。
 *
 * @param widestTick 最宽的刻度文本
 * @param fontSize 轴文字实际字号
 */
export function axisPaddingLeft(widestTick: string, fontSize: number): number {
  const scale = fontSize / AXIS_BASE_FONT_SIZE
  const needed = Math.ceil(estimateAxisLabelWidth(widestTick, fontSize) + AXIS_LABEL_GAP * scale)
  return Math.min(AXIS_PADDING_MAX * scale, Math.max(AXIS_PADDING_MIN, needed))
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}
