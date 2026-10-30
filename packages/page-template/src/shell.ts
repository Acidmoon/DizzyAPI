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
  // 不再挂 `role="heading" aria-level="1"`：`<h1>` 本来就是一级标题，
  // 重复声明 ARIA 只会多一个可能与真实层级不符的源（语义标签优先于 ARIA）。
  return `<h1 class="page-title">${escapeText(options.title)}</h1>
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
    // `scope="col"`：读屏念单元格时会带上列名（否则只念「¥12.00」，不说是哪一列）。
    .map((column) => `<th scope="col"${column.align === 'right' ? ' class="num"' : ''}>${escapeText(column.label)}</th>`)
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
  /**
   * 这条错误属于哪个字段（表单 `name`）。
   *
   * 给了就写进 `data-field`：客户端脚本会把这条提示**搬到那个字段下方**
   * （`client-feedback.ts` 的 relocateNotice），所以「哪个字段错了」不必让
   * 每个页面各自渲染一遍就地错误——服务端只说事实，摆放交给一层统一的脚本。
   * 没有脚本时它仍是一条正常的页顶提示，信息不丢。
   */
  readonly field?: string
}): string {
  const cls = options.kind === 'ok' ? 'notice ok' : options.kind === 'err' ? 'notice err' : 'notice'
  // 失败用 `role="alert"`（读屏会打断当前朗读、立刻念出来——失败必须被听见）；
  // 成功 / 说明用 `role="status"`（礼貌播报，不打断）。
  // `tabindex="-1"` 让脚本能把焦点移过来（失败后键盘用户不该自己去页顶找原因）。
  const fieldAttr = options.field === undefined ? '' : ` data-field="${escapeAttr(options.field)}"`
  if (options.kind === 'err') {
    return `<div class="${cls}" role="alert" tabindex="-1"${fieldAttr}>${escapeText(options.text)}</div>`
  }
  return `<div class="${cls}" role="status" aria-live="polite">${escapeText(options.text)}</div>`
}

/** 表单字段。 */
export interface FieldOptions {
  readonly label: string
  readonly name: string
  readonly type?: string
  readonly value?: string
  readonly placeholder?: string
  readonly hint?: string
  readonly required?: boolean
  readonly autocomplete?: string
  /**
   * 显式元素 id。**同一页里同名字段出现多次时必须给**：默认 id 是 `f-<name>`，
   * 而弹窗化的编辑表单是「每行一个」（`admin_users` / `keys` 都是这样），
   * 同名字段一多，`<label for>` 就全部指向第一个、点标签会跳到看不见的控件上。
   */
  readonly id?: string
  /** 键盘类型（`inputmode`）；不给时按 `type` 派生。 */
  readonly inputmode?: string
  /** 拼写检查；不给时按字段语义派生（邮箱 / 验证码 / 标识符一律关掉）。 */
  readonly spellcheck?: boolean
  /** 就地错误文案：渲染在字段正下方，并挂 `aria-invalid` + `aria-describedby`。 */
  readonly error?: string
}

/** 按 `type` 派生 `inputmode`（移动端决定弹什么键盘）。 */
function inputModeOf(type: string): string | undefined {
  if (type === 'email') return 'email'
  if (type === 'number') return 'numeric'
  if (type === 'tel') return 'tel'
  if (type === 'url') return 'url'
  if (type === 'search') return 'search'
  return undefined
}

/**
 * 按字段语义决定要不要拼写检查。
 *
 * 邮箱 / 验证码 / 用户名 / 模型名 / URL 这类**标识符**开着拼写检查只会捣乱：
 * 输入法给它加下划线、移动端还可能「自动纠错」把验证码改掉。
 * 自由文本（备注、原因、活动说明）保持开启。
 */
const NO_SPELLCHECK_NAME = /(email|code|username|password|name|model|key|url|tag|label|search)/i
function spellcheckOf(name: string, type: string): boolean {
  if (type === 'email' || type === 'password' || type === 'url' || type === 'number') return false
  return !NO_SPELLCHECK_NAME.test(name)
}

/**
 * 占位符统一以「…」结尾（指南：placeholder 是**示例**，不是标签）。
 * 调用方只需要给示例本身（`例如：本地开发`），结尾的省略号在这里补，
 * 免得 30 多个调用点各写一遍、漏一个是一个。
 */
function placeholderOf(text: string | undefined): string | undefined {
  if (text === undefined || text === '') return undefined
  return text.endsWith('…') ? text : `${text}…`
}

export function renderField(options: FieldOptions): string {
  const type = options.type ?? 'text'
  const id = options.id ?? `f-${options.name}`
  const required = options.required === true ? ' required' : ''
  // 标识符类字段关掉拼写检查；调用方给的显式值优先。
  const spellcheck = options.spellcheck ?? spellcheckOf(options.name, type)
  const inputmode = options.inputmode ?? inputModeOf(type)
  // 非认证字段默认 `autocomplete="off"`：否则浏览器的密码管理器会在
  // 「上游账号 / 模型价格」这类表单上弹出「保存密码」，用户一脸问号。
  // 登录 / 注册页显式传 `username` / `current-password` / `new-password`，不受影响。
  const autocomplete = options.autocomplete ?? 'off'
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const hint = options.hint === undefined ? '' : `<span class="hint" id="${escapeAttr(hintId)}">${escapeText(options.hint)}</span>`
  const error = options.error === undefined
    ? ''
    : `<p class="field-error" id="${escapeAttr(errorId)}" role="alert">${escapeText(options.error)}</p>`
  // 说明与错误都要能被读屏念出来：hint 在前、error 在后（先原因后说明）。
  const describedBy = [
    options.hint === undefined ? '' : hintId,
    options.error === undefined ? '' : errorId,
  ].filter((item) => item !== '').join(' ')
  return `<div class="field">
<label for="${escapeAttr(id)}">${escapeText(options.label)}</label>
<input class="input" id="${escapeAttr(id)}" name="${escapeAttr(options.name)}" type="${escapeAttr(type)}"${required} value="${escapeAttr(options.value ?? '')}"${placeholderOf(options.placeholder) === undefined ? '' : ` placeholder="${escapeAttr(placeholderOf(options.placeholder) as string)}"`}${` autocomplete="${escapeAttr(autocomplete)}"`}${` spellcheck="${spellcheck ? 'true' : 'false'}"`}${inputmode === undefined ? '' : ` inputmode="${escapeAttr(inputmode)}"`}${describedBy === '' ? '' : ` aria-describedby="${escapeAttr(describedBy)}"`}${options.error === undefined ? '' : ' aria-invalid="true"'}>
${hint}
${error}
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
  // 外层用 `<main>`：登录 / 注册页没有侧栏，也就没有别的正文地标。
  // 读屏用户靠地标（landmark）跳转，全站每页都该有一个 main。
  return `<main class="auth-wrap">
<div class="auth-card">
<h1 class="auth-title">${escapeText(options.title)}</h1>
${subtitle}
${options.content}
${footer}
</div>
</main>`
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
