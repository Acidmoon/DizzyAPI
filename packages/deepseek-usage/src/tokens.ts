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
  titleSize: 24,
  titleLineHeight: 32,
  titleMarginBottom: 8,
  /** 指标大数字：29px / 36px，500 字重，tabular-nums。 */
  metricValueSize: 29,
  metricValueLineHeight: 36,
  metricUnitSize: 16,
  metricUnitLineHeight: 24,
  labelSize: 14,
  labelLineHeight: 22,
  captionSize: 12,
  captionLineHeight: 18,
  /** 图表卡内边距：20px 20px 12px。 */
  chartCardPaddingX: 20,
  chartCardPaddingTop: 20,
  chartCardPaddingBottom: 12,
  chartCardMinHeight: 335,
  chartHeaderGap: 10,
  chartHeaderMarginBottom: 13,
  /** 分段控件：26px 高、20px 圆角、11px 字。 */
  segmentedHeight: 26,
  segmentedRadius: 20,
  segmentedFontSize: 11,
  segmentedPaddingX: 8,
  /** 模型分块：标题 16px，与上方间距 24px。 */
  modelTitleSize: 16,
  modelBlockMarginTop: 24,
  /** 侧栏底部用户行的头像 32px。 */
  avatarSize: 32,
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
 * 估算 12px 轴标签文字的像素宽度。
 *
 * 原站的绘图区左边界是跟着刻度文字宽度走的：刻度 `40` 时左边界 22、
 * 刻度 `2M` 时 22、刻度 `600M` 时 37、刻度 `2,000` 时 44.5。
 * 反推得到「字符数 × 7.5 + 7」，与原站四个数据点逐点吻合。
 *
 * @param text 刻度文本，例如 `600M`、`2,000`
 */
export function estimateAxisLabelWidth(text: string): number {
  return text.length * 7.5
}

/** 轴刻度文字与绘图区左边界之间的固定间隙（原站实测 7px）。 */
export const AXIS_LABEL_GAP = 7

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}
