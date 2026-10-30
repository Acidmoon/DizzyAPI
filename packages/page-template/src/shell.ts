/**
 * 通用组件：卡片 / 过滤行 / 图表卡 / 表格 / 表单 / 提示条 / 登录卡 / 状态标签。
 *
 * 结构与类名**照搬** deepseek-usage 的像素级实现，只把业务数据参数化：
 * 同一份 `assets.ts` 的 CSS（THEME_VARS + PAGE_CSS）配同一套 DOM，
 * 换页面时只换内容，不重做视觉。
 *
 * 侧栏与主列外壳**不在这里**：它们是 `sidebar.ts`（第 4 批加 boost 与拖动契约后
 * 顶过 400 行软上限，拆开）。组件是「一页里的零件」，外壳是「页面之间的骨架」，
 * 两者改动理由不同，放一起会互相牵制。
 */
import { escapeAttr, escapeText } from './escape.ts'
import { iconCaret, iconDots, iconInfo } from './icons.ts'

export interface PageHeaderOptions {
  readonly title: string
  /** 标题下的一行说明；可以带 `iconInfo` 的提示图标。 */
  readonly note?: string
}

/** 指标 / 余额卡。 */
export interface StatCard {
  readonly label: string
  readonly value: string
  /** 数值单位，例如 `CNY`。 */
  readonly unit?: string
  /** 标题后是否带信息图标。 */
  readonly info?: boolean
  /** 右下角动作按钮。 */
  readonly action?: { readonly label: string; readonly href: string }
}

export interface FilterPillItem {
  readonly label: string
  readonly href: string
  readonly selected?: boolean
}

export interface FilterPill {
  /** 胶囊左侧的字段名，例如「时间维度」。 */
  readonly label: string
  /** 当前值的显示文本。 */
  readonly value: string
  readonly items: readonly FilterPillItem[]
}

export interface ChartCardOptions {
  readonly title: string
  /** 标题旁的合计值。 */
  readonly total?: string
  /** 右上角分段控件；`selected` 表示当前项。 */
  readonly segments?: readonly FilterPillItem[]
  /** `renderStackedBarChart` / `renderAreaLineChart` 的结果。 */
  readonly chart: string
}

export interface ModelBlockItem {
  readonly label: string
  readonly value: string
  readonly chart: string
}

export interface ModelBlock {
  readonly title: string
  readonly items: readonly ModelBlockItem[]
}

/** 页面标题与说明行。 */
export function renderPageHeader(options: PageHeaderOptions): string {
  const note = options.note === undefined
    ? ''
    : `<p class="page-note"><span>${escapeText(options.note)}</span>${iconInfo()}</p>`
  return `<h1 class="page-title" role="heading" aria-level="1">${escapeText(options.title)}</h1>
${note}`
}

/**
 * 指标 / 余额卡。
 *
 * `balances` 是首屏的大卡（带动作按钮），`metrics` 是三列指标卡；
 * 两者的卡片 DOM 相同，只是容器类名不同。
 */
export function renderStatCards(cards: readonly StatCard[], layout: 'balances' | 'metrics' = 'metrics'): string {
  const blocks = cards.map((card) => {
    const info = card.info === true ? iconInfo() : ''
    const unit = card.unit === undefined ? '' : `<span class="value-unit">${escapeText(card.unit)}</span>`
    const action = card.action === undefined
      ? ''
      : `<a class="btn" href="${escapeAttr(card.action.href)}">${escapeText(card.action.label)}</a>`
    return `<div class="card">
<div class="card-col">
<div class="card-head"><span class="card-label">${escapeText(card.label)}</span>${info}</div>
<div class="card-value-row">
<div class="card-value"><span class="value-main">${escapeText(card.value)}</span>${unit}</div>${action}
</div>
</div>
</div>`
  }).join('\n')
  return `<div class="${layout}">
${blocks}
</div>`
}

/** 过滤行：左侧若干胶囊，右侧可选动作。 */
export function renderFilterBar(pills: readonly FilterPill[], right?: string): string {
  const pillBlocks = pills.map((pill) => {
    const items = pill.items.map((item) => {
      const selected = item.selected === true
      return `<a class="menu-item" role="option" aria-selected="${selected}" href="${escapeAttr(item.href)}">${escapeText(item.label)}</a>`
    }).join('')
    return `<span class="pill-wrap">
<button class="pill" type="button" aria-expanded="false" aria-haspopup="listbox">
<span class="pill-label">${escapeText(pill.label)}</span><span class="pill-sep"></span>
<span class="pill-value">${escapeText(pill.value)}</span>${iconCaret()}
</button>
<span class="menu" role="listbox">${items}</span>
</span>`
  }).join('\n')
  const rightBlock = right === undefined
    ? ''
    : `<div class="filter-right">${right}</div>`
  return `<div class="filters">
<div class="filter-group">
${pillBlocks}
</div>
${rightBlock}
</div>`
}

/** 图表卡：标题 + 合计 + 分段控件 + 图。 */
export function renderChartCard(options: ChartCardOptions): string {
  const total = options.total === undefined
    ? ''
    : `<span class="chart-total">${escapeText(options.total)}</span>`
  const segments = options.segments === undefined || options.segments.length === 0
    ? ''
    : `<div class="segmented" role="tablist">
${options.segments.map((item) => `<a class="seg-item" role="tab" aria-selected="${item.selected === true}" href="${escapeAttr(item.href)}">${escapeText(item.label)}</a>`).join('')}
</div>`
  return `<div class="chart-card">
<div class="chart-head">
<div class="chart-titles">
<span class="chart-title">${escapeText(options.title)}</span>${total}
</div>
${segments}
</div>
<div class="plot">
${options.chart}
</div>
</div>`
}

/** 模型分块：每个模型一张卡，卡内可放若干小图。 */
export function renderModelGrid(blocks: readonly ModelBlock[]): string {
  if (blocks.length === 0) return renderEmpty('当前范围内没有数据。')
  const rendered = blocks.map((block) => {
    const items = block.items.map((item) => `<div class="mini">
<div class="mini-head"><span class="mini-label">${escapeText(item.label)}</span><span class="mini-value">${escapeText(item.value)}</span></div>
<div class="mini-plot">${item.chart}</div>
</div>`).join('\n')
    return `<section class="model">
<h2 class="model-name">${escapeText(block.title)}</h2>
<div class="model-grid">
${items}
</div>
</section>`
  }).join('\n')
  return `<div class="models">${rendered}</div>`
}

/** 空状态。 */
export function renderEmpty(text: string): string {
  return `<div class="empty">${escapeText(text)}</div>`
}

/** 导出按钮（放在 `renderFilterBar` 的 `right` 里）。 */
export function renderExportButton(href: string, label = '导出'): string {
  return `<a class="btn" data-export href="${escapeAttr(href)}">${escapeText(label)}</a>`
}

/** 图标按钮（例如「更多」）。 */
export function renderIconButton(label: string): string {
  return `<button class="icon-btn" type="button" aria-label="${escapeAttr(label)}">${iconDots()}</button>`
}

/** 表格列。 */
export interface TableColumn {
  readonly label: string
  readonly align?: 'left' | 'right'
}

/** 表格：单元格内容由调用方渲染好，模板只负责转义属性与外壳。 */
export function renderTable(options: {
  readonly columns: readonly TableColumn[]
  /** 每行是已渲染的单元格 HTML；数量必须与列一致。 */
  readonly rows: readonly (readonly string[])[]
  readonly empty?: string
}): string {
  const head = options.columns
    .map((column) => `<th${column.align === 'right' ? ' class="num"' : ''}>${escapeText(column.label)}</th>`)
    .join('')
  const body = options.rows.length === 0
    ? `<tr class="empty-row"><td colspan="${options.columns.length}">${escapeText(options.empty ?? '没有数据')}</td></tr>`
    : options.rows.map((cells) => {
      const tds = cells
        .map((cell, index) => `<td${options.columns[index]?.align === 'right' ? ' class="num"' : ''}>${cell}</td>`)
        .join('')
      return `<tr>${tds}</tr>`
    }).join('\n')
  return `<div class="panel"><table class="table">
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table></div>`
}

/** 提示条。 */
export function renderNotice(options: {
  readonly kind: 'ok' | 'err' | 'info'
  readonly text: string
}): string {
  const cls = options.kind === 'ok' ? 'notice ok' : options.kind === 'err' ? 'notice err' : 'notice'
  return `<div class="${cls}" role="status">${escapeText(options.text)}</div>`
}

/** 表单字段。 */
export function renderField(options: {
  readonly label: string
  readonly name: string
  readonly type?: string
  readonly value?: string
  readonly placeholder?: string
  readonly hint?: string
  readonly required?: boolean
  readonly autocomplete?: string
}): string {
  const type = options.type ?? 'text'
  const required = options.required === true ? ' required' : ''
  const hint = options.hint === undefined ? '' : `<span class="hint">${escapeText(options.hint)}</span>`
  return `<div class="field">
<label for="f-${escapeAttr(options.name)}">${escapeText(options.label)}</label>
<input class="input" id="f-${escapeAttr(options.name)}" name="${escapeAttr(options.name)}" type="${escapeAttr(type)}"${required} value="${escapeAttr(options.value ?? '')}"${options.placeholder === undefined ? '' : ` placeholder="${escapeAttr(options.placeholder)}"`}${options.autocomplete === undefined ? '' : ` autocomplete="${escapeAttr(options.autocomplete)}"`}>
${hint}
</div>`
}

/** 登录 / 注册页：无侧栏的居中卡片。 */
export function renderAuthPage(options: {
  readonly title: string
  readonly subtitle?: string
  readonly content: string
  readonly footer?: string
}): string {
  const subtitle = options.subtitle === undefined
    ? ''
    : `<p class="auth-sub">${escapeText(options.subtitle)}</p>`
  const footer = options.footer === undefined
    ? ''
    : `<div class="auth-foot">${options.footer}</div>`
  return `<div class="auth-wrap">
<div class="auth-card">
<h1 class="auth-title">${escapeText(options.title)}</h1>
${subtitle}
${options.content}
${footer}
</div>
</div>`
}

/** 区块标题。 */
export function renderSectionTitle(text: string): string {
  return `<h2 class="section-title">${escapeText(text)}</h2>`
}

/** 状态标签。 */
export function renderBadge(text: string, kind?: 'ok' | 'warn' | 'err'): string {
  const cls = kind === undefined ? 'badge' : `badge ${kind}`
  return `<span class="${cls}">${escapeText(text)}</span>`
}
