/**
 * 日期选择：原生 `<input type="date">` 的**值格式**保留，**日历浮层**换成 flatpickr。
 *
 * 为什么不能自己用 CSS 改造：日历浮层由浏览器绘制，CSS 碰不到，样式完全不可控。
 *
 * 设计取舍与 `select.ts` 一致——**渐进增强**：
 * - 有 JS：flatpickr 接管，弹出我们自绘的日历；
 * - 无 JS：它仍然是原生 `<input type="date">`，浏览器自带日历照样能用，表单照样提交。
 *
 * 值格式固定 `YYYY-MM-DD`（原生 date 与 flatpickr 默认都吃这个），
 * 所以服务端读表单时不用区分「有没有 JS」。
 */
import { escapeAttr } from './escape.ts'

export interface DatePickerOptions {
  /** `name` 属性：表单提交时的字段名。 */
  readonly name: string
  /** `id`：要和 `<label for>` 对应的那个。 */
  readonly id?: string
  /** 当前值，`YYYY-MM-DD`。 */
  readonly value?: string
  /** 额外 class（拼在 `.input` 后面）。 */
  readonly className?: string
  /** 无障碍说明。 */
  readonly ariaLabel?: string
}

/**
 * 渲染一个「会升级成 flatpickr」的日期输入。
 *
 * 输出的是**合法且可用的**原生 `<input type="date">`，只是多了 `data-flatpickr`：
 * - 有 JS：`CLIENT_JS` 里的初始化代码用 flatpickr 接管；
 * - 无 JS：浏览器原生日期选择器，功能不丢。
 */
export function renderDatePicker(options: DatePickerOptions): string {
  const cls = options.className === undefined ? 'input' : `input ${options.className}`
  const id = options.id === undefined ? '' : ` id="${escapeAttr(options.id)}"`
  const aria = options.ariaLabel === undefined ? '' : ` aria-label="${escapeAttr(options.ariaLabel)}"`
  const value = options.value === undefined || options.value === '' ? '' : ` value="${escapeAttr(options.value)}"`
  return `<input class="${escapeAttr(cls)}"${id} type="date" name="${escapeAttr(options.name)}"${value} data-flatpickr${aria}>`
}
