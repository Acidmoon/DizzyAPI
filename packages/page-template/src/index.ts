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
  FONT_ROLES,
  LETTER_SPACING,
  METRICS,
  AXIS_CHAR_WIDTH_EM,
  AXIS_LABEL_GAP,
  AXIS_PADDING_MAX,
  AXIS_PADDING_MIN,
  axisPaddingLeft,
  estimateAxisLabelWidth,
  formatAxisDate,
  formatCents,
  formatCompact,
  formatThousands,
  type FontRole,
} from './tokens.ts'

export { PAGE_CSS, THEME_VARS, CLIENT_JS } from './assets.ts'
export { COMPONENT_CSS } from './extra-styles.ts'
export { LAYOUT_CSS } from './layout-classes.ts'

export {
  CONFIRM_DIALOG_ID,
  confirmAttr,
  renderConfirmDialog,
  type ConfirmDialogOptions,
} from './confirm.ts'

export {
  renderSelect,
  renderSelectShell,
  type SelectOption,
  type SelectOptions,
  type SelectShellOptions,
} from './select.ts'
export { renderDatePicker, type DatePickerOptions } from './date-picker.ts'
export { MODAL_CSS, dialogOpenAttr, renderModal, type ModalOptions } from './modal.ts'
export { VENDOR_THEME_CSS } from './vendor-theme.ts'

export {
  VENDOR_ASSET_PREFIX,
  VENDOR_CSS_ORDER,
  VENDOR_SCRIPT_ORDER,
  vendorHash,
  vendorHref,
  readVendorFile,
  vendorContentType,
  vendorCss,
  type VendorFile,
  type VendorFileName,
} from './vendor.ts'

export { escapeAttr, escapeText } from './escape.ts'

export {
  COST_KEY_COLORS,
  COST_THEME,
  MINI_THEME,
  renderAreaLineChart,
  renderStackedBarChart,
  type ChartOptions,
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
