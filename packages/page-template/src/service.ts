/**
 * 页面模板服务（cordis 服务名 `pageTemplate`）。
 *
 * 它是**纯渲染能力**：不起 HTTP、不读写存储、不依赖别的插件。
 * 页面插件经服务拿同一套设计 token、组件与图表，避免每个页面重抄一遍
 * 像素级实现（AGENTS.md 2.2：插件间只通过服务接口通信）。
 */
import { Service, type Context } from 'cordis'
import { CLIENT_JS, PAGE_CSS, THEME_VARS } from './assets.ts'
import {
  COST_KEY_COLORS,
  COST_THEME,
  MINI_THEME,
  renderAreaLineChart,
  renderStackedBarChart,
  type ChartOptions,
  type ChartTheme,
} from './charts.ts'
import { escapeAttr, escapeText } from './escape.ts'
import { renderConfirmDialog, type ConfirmDialogOptions } from './confirm.ts'
import { renderSelect, renderSelectShell, type SelectOptions, type SelectShellOptions } from './select.ts'
import { renderDatePicker, type DatePickerOptions } from './date-picker.ts'
import { dialogOpenAttr, renderModal, type ModalOptions } from './modal.ts'
import {
  VENDOR_ASSET_PREFIX,
  VENDOR_SCRIPT_ORDER,
  readVendorFile,
  vendorCss,
  type VendorFile,
} from './vendor.ts'
import {
  AXIS_LABEL_GAP,
  DARK_TOKENS,
  FONT_ROLES,
  FONT_STACK,
  METRICS,
  axisPaddingLeft,
  estimateAxisLabelWidth,
  formatAxisDate,
  formatCents,
  formatCompact,
  formatThousands,
} from './tokens.ts'
import {
  renderAuthPage,
  renderBadge,
  renderChartCard,
  renderEmpty,
  renderExportButton,
  renderField,
  renderFilterBar,
  renderIconButton,
  renderModelGrid,
  renderNotice,
  renderPageHeader,
  renderSectionTitle,
  renderStatCards,
  renderTable,
  type ChartCardOptions,
  type FieldOptions,
  type FilterPill,
  type FilterPillItem,
  type ModelBlock,
  type ModelBlockItem,
  type PageHeaderOptions,
  type StatCard,
  type TableColumn,
} from './shell.ts'
import {
  renderShell,
  renderSidebar,
  type BrandOptions,
  type NavIconName,
  type NavItem,
  type ShellOptions,
  type UserOptions,
} from './sidebar.ts'
import { renderDocument, type DocumentOptions } from './document.ts'
import { tooltipAttr } from './tooltip.ts'

export class PageTemplateService extends Service {
  static inject: readonly string[] = []
  static catalog = { capabilities: ['page-template'], events: [], bridge: [] } as const

  /** 设计 token（深色主题实测值）。 */
  readonly tokens = DARK_TOKENS
  /** 尺寸与节奏。 */
  readonly metrics = METRICS
  /** 字体栈。 */
  readonly fontStack = FONT_STACK

  /** 样式与客户端脚本：页面插件可以自挂资源路由，也可以整份内联。 */
  readonly styles = {
    themeVars: THEME_VARS,
    pageCss: PAGE_CSS,
    clientJs: CLIENT_JS,
  } as const

  /** 图表主题：主图橙黄、按 API Key 分组六色、模型小图蓝系。 */
  readonly chartThemes = {
    cost: COST_THEME,
    costByKey: COST_KEY_COLORS,
    mini: MINI_THEME,
  } as const

  constructor(ctx: Context) {
    super(ctx, 'pageTemplate')
  }

  renderDocument(options: DocumentOptions): string {
    return renderDocument(options)
  }

  renderShell(options: ShellOptions): string {
    return renderShell(options)
  }

  renderSidebar(options: ShellOptions): string {
    return renderSidebar(options)
  }

  renderPageHeader(options: PageHeaderOptions): string {
    return renderPageHeader(options)
  }

  renderStatCards(cards: readonly StatCard[], layout: 'balances' | 'metrics' = 'metrics'): string {
    return renderStatCards(cards, layout)
  }

  renderFilterBar(pills: readonly FilterPill[], right?: string): string {
    return renderFilterBar(pills, right)
  }

  renderChartCard(options: ChartCardOptions): string {
    return renderChartCard(options)
  }

  renderModelGrid(blocks: readonly ModelBlock[]): string {
    return renderModelGrid(blocks)
  }

  renderEmpty(text: string): string {
    return renderEmpty(text)
  }

  renderExportButton(href: string, label?: string): string {
    return renderExportButton(href, label)
  }

  renderIconButton(label: string): string {
    return renderIconButton(label)
  }

  renderTable(options: {
    readonly columns: readonly TableColumn[]
    readonly rows: readonly (readonly string[])[]
    readonly empty?: string
  }): string {
    return renderTable(options)
  }

  renderNotice(options: {
    readonly kind: 'ok' | 'err' | 'info'
    readonly text: string
    readonly field?: string
  }): string {
    return renderNotice(options)
  }

  renderField(options: FieldOptions): string {
    return renderField(options)
  }

  renderAuthPage(options: {
    readonly title: string
    readonly subtitle?: string
    readonly content: string
    readonly footer?: string
  }): string {
    return renderAuthPage(options)
  }

  renderSectionTitle(text: string): string {
    return renderSectionTitle(text)
  }

  renderBadge(text: string, kind?: 'ok' | 'warn' | 'err'): string {
    return renderBadge(text, kind)
  }

  renderStackedBarChart(
    data: readonly { readonly date: string; readonly series: Readonly<Record<string, number>> }[],
    groups: readonly string[],
    theme: ChartTheme = COST_THEME,
    unit: 'currency' | 'count' = 'count',
    key?: string,
    options: ChartOptions = {},
  ): string {
    return renderStackedBarChart(data, groups, theme, unit, key, options)
  }

  renderAreaLineChart(
    data: readonly { readonly date: string; readonly value: number }[],
    theme: ChartTheme = MINI_THEME,
    unit: 'currency' | 'count' = 'count',
    key?: string,
    options: ChartOptions = {},
  ): string {
    return renderAreaLineChart(data, theme, unit, key, options)
  }

  escapeText(value: string): string {
    return escapeText(value)
  }

  escapeAttr(value: string): string {
    return escapeAttr(value)
  }

  formatCents(cents: number): string {
    return formatCents(cents)
  }

  formatThousands(value: number): string {
    return formatThousands(value)
  }

  formatCompact(value: number): string {
    return formatCompact(value)
  }

  formatAxisDate(iso: string): string {
    return formatAxisDate(iso)
  }

  /** 轴标签宽度估算：按实际字号派生（默认轴文字口径 = caption 档）。 */
  estimateAxisLabelWidth(text: string, fontSize: number = FONT_ROLES.caption.size): number {
    return estimateAxisLabelWidth(text, fontSize)
  }

  /** 绘图区左内边距：由最宽刻度与字号算出（`charts.ts` 两处共用这一份）。 */
  axisPaddingLeft(widestTick: string, fontSize: number = FONT_ROLES.caption.size): number {
    return axisPaddingLeft(widestTick, fontSize)
  }

  readonly axisLabelGap = AXIS_LABEL_GAP

  // ── vendor（第三方前端库）──────────────────────────────────────
  // page-template 原先没有任何「发字节」的能力；控件库要能被浏览器加载，
  // 就得有个 seam。形态照 font-smiley 的 file()：给名字、拿字节，
  // 名字必须命中白名单（见 vendor.ts），不接受任意路径。

  /** `/assets/vendor/*` 的 URL 前缀。 */
  readonly vendorAssetPrefix = VENDOR_ASSET_PREFIX

  /** 白名单内的 vendor 文件；名字不在白名单返回 undefined（调用方按 404 处理）。 */
  vendorFile(name: string): VendorFile | undefined {
    return readVendorFile(name)
  }

  /** vendor CSS 合并文本（拼进 `/assets/app.css`）。 */
  vendorCss(): string {
    return vendorCss()
  }

  /** 页面 `<script src>` 里 vendor 部分应有的顺序（`app.js` 由调用方接在最后）。 */
  readonly vendorScriptOrder = VENDOR_SCRIPT_ORDER

  /** 确认框的 `<dialog>` 壳（`renderDocument` 已自动带上，这里给需要定制文案时用）。 */
  renderConfirmDialog(options?: ConfirmDialogOptions): string {
    return renderConfirmDialog(options)
  }

  // ── 控件（渐进增强）──────────────────────────────────────────────
  // 输出的是**可用的原生元素** + `data-*` 钩子；有 JS 时升级成自绘浮层，
  // 无 JS 时原生控件照常可用。原生控件的浮层由浏览器绘制、CSS 碰不到，
  // 所以下拉与日历只能这样换（owner 第 3 条）。

  /** 下拉：`<select data-tom-select>`（选项给数组）。 */
  renderSelect(options: SelectOptions): string {
    return renderSelect(options)
  }

  /** 下拉：`<select data-tom-select>`（选项已是 HTML，用于动态拼接的场景）。 */
  renderSelectShell(options: SelectShellOptions): string {
    return renderSelectShell(options)
  }

  /** 日期：`<input type="date" data-flatpickr>`。 */
  renderDatePicker(options: DatePickerOptions): string {
    return renderDatePicker(options)
  }

  /** 弹窗外壳（原生 `<dialog>` + 自绘外观）。 */
  renderModal(options: ModalOptions): string {
    return renderModal(options)
  }

  /** 打开某个弹窗的属性片段（前面带一个空格，直接拼进触发元素）。 */
  dialogOpenAttr(id: string): string {
    return dialogOpenAttr(id)
  }

  /**
   * 悬浮提示：`data-tooltip` 属性片段（前面带一个空格）。
   *
   * 浮层是自绘的（`client-tooltip.ts` + Floating UI 定位），替掉浏览器原生 `title`。
   * 无 JS 时属性无副作用；需要「无 JS 也有提示」的元素自己再留一份 `<title>`，
   * 脚本接管时会把它们摘掉。
   */
  tooltipAttr(text: string): string {
    return tooltipAttr(text)
  }
}

export type {
  BrandOptions,
  ChartCardOptions,
  ChartTheme,
  DocumentOptions,
  FilterPill,
  FilterPillItem,
  ModelBlock,
  ModelBlockItem,
  NavIconName,
  NavItem,
  PageHeaderOptions,
  ShellOptions,
  StatCard,
  TableColumn,
  UserOptions,
}
