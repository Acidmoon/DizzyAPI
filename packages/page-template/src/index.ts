/**
 * 页面模板（@dizzyapi/plugin-page-template）。
 *
 * 从 deepseek-usage 的像素级实现里抽出的**可复用外壳**：
 * 设计 token、侧栏、卡片、过滤行、图表与图标，结构与类名照旧。
 * 页面插件通过 `pageTemplate` 服务拿这些能力，不必再抄一遍视觉规格。
 */
import { PageTemplateService } from './service.ts'

declare module 'cordis' {
  interface Context {
    pageTemplate: PageTemplateService
  }
}

export { PageTemplateService }
export default PageTemplateService

export {
  DARK_TOKENS,
  FONT_STACK,
  METRICS,
  AXIS_LABEL_GAP,
  estimateAxisLabelWidth,
  formatAxisDate,
  formatCents,
  formatCompact,
  formatThousands,
} from './tokens.ts'

export { PAGE_CSS, THEME_VARS, CLIENT_JS } from './assets.ts'
export { COMPONENT_CSS } from './extra-styles.ts'

export { escapeAttr, escapeText } from './escape.ts'

export {
  COST_KEY_COLORS,
  COST_THEME,
  MINI_THEME,
  renderAreaLineChart,
  renderStackedBarChart,
  type ChartTheme,
} from './charts.ts'

export {
  renderChartCard,
  renderDocument,
  renderEmpty,
  renderExportButton,
  renderField,
  renderFilterBar,
  renderIconButton,
  renderModelGrid,
  renderPageHeader,
  renderAuthPage,
  renderBadge,
  renderNotice,
  renderSectionTitle,
  renderShell,
  renderSidebar,
  renderStatCards,
  renderTable,
  type BrandOptions,
  type ChartCardOptions,
  type DocumentOptions,
  type FilterPill,
  type FilterPillItem,
  type ModelBlock,
  type ModelBlockItem,
  type NavIconName,
  type NavItem,
  type PageHeaderOptions,
  type ShellOptions,
  type StatCard,
  type TableColumn,
  type UserOptions,
} from './shell.ts'
