/**
 * 下拉选择：原生 `<select>` 的**语义**保留，**浮层**换成 Tom Select。
 *
 * 为什么不能自己用 CSS 改造原生 `<select>`：下拉浮层由**浏览器绘制**，
 * CSS 完全碰不到（`<select>` 只受控于 `appearance` 这类有限属性）。
 * 要自绘浮层只有一个办法——把选择逻辑搬到 DOM 里，这正是 Tom Select 干的事。
 *
 * 设计取舍：**继续输出 `<select>` 元素**，只是加 `data-tom-select` 钩子。
 * 理由是表单还能正常工作——JS 没跑（或被 CSP 拦、加载失败）时，
 * 浏览器原生下拉照样能用，表单照样能提交。这是渐进增强，不是替换。
 */
import { escapeAttr, escapeText } from './escape.ts'

export interface SelectOption {
  readonly value: string
  readonly label: string
  /** 选中态。 */
  readonly selected?: boolean
}

export interface SelectOptions {
  /** `name` 属性：表单提交时的字段名。 */
  readonly name: string
  /** `id`：要和 `<label for>` 对应的那个。 */
  readonly id?: string
  readonly options: readonly SelectOption[]
  /** 首项占位（空值），例如「全部动作」。 */
  readonly placeholder?: string
  /** 允许留空（默认 true——筛选器一般都要能清空）。 */
  readonly allowEmpty?: boolean
  /** 额外 class（拼在 `.input` 后面）。 */
  readonly className?: string
  /** 无障碍说明。 */
  readonly ariaLabel?: string
}

/** 渲染一个 `<option>`（内部使用；选项文本一律转义）。 */
function renderOption(option: SelectOption): string {
  const selected = option.selected === true ? ' selected' : ''
  return `<option value="${escapeAttr(option.value)}"${selected}>${escapeText(option.label)}</option>`
}

/**
 * 便捷封装：选项用数组给。
 *
 * `allowEmpty` 为真且没给 `placeholder` 时，首项留空（`value=""`）——
 * 筛选器的「全部」通常就靠它。
 */
export function renderSelect(options: SelectOptions): string {
  const allowEmpty = options.allowEmpty !== false
  const parts: string[] = []
  if (allowEmpty) {
    const label = options.placeholder ?? ''
    const empty = renderOption({ value: '', label, selected: !options.options.some((o) => o.selected === true) })
    parts.push(empty)
  }
  for (const option of options.options) parts.push(renderOption(option))
  return renderSelectShell({
    name: options.name,
    ...(options.id === undefined ? {} : { id: options.id }),
    optionsHtml: parts.join(''),
    ...(options.className === undefined ? {} : { className: options.className }),
    ...(options.ariaLabel === undefined ? {} : { ariaLabel: options.ariaLabel }),
  })
}

export interface SelectShellOptions {
  readonly name: string
  readonly id?: string
  /** 已经渲染好的 `<option>` 序列化 HTML。 */
  readonly optionsHtml: string
  readonly className?: string
  readonly ariaLabel?: string
}

/**
 * 底层封装：接受**已经渲染好的** `<option>` 列表。
 *
 * 用在选项由别处拼出来的地方（例如审计页的 `actionOptions`、账号页的批量动作）。
 * 上层 `renderSelect` 是它的便捷包装。
 */
export function renderSelectShell(options: SelectShellOptions): string {
  const cls = options.className === undefined ? 'input' : `input ${options.className}`
  const id = options.id === undefined ? '' : ` id="${escapeAttr(options.id)}"`
  const aria = options.ariaLabel === undefined ? '' : ` aria-label="${escapeAttr(options.ariaLabel)}"`
  return `<select class="${escapeAttr(cls)}"${id} name="${escapeAttr(options.name)}" data-tom-select${aria}>${options.optionsHtml}</select>`
}
