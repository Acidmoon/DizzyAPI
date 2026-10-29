/**
 * 自绘确认框：替代 `window.confirm()`。
 *
 * 为什么必须换：`window.confirm` 是浏览器画的原生模态框——
 * 样式**完全不可控**（CSS 碰不到），而且它阻塞整个页面直到用户点按钮。
 * owner 的第 3 条要求「所有弹窗与 hover 提示不用浏览器默认控件」。
 *
 * 做法：原生 `<dialog>` 元素（它**没有默认外观**，只提供焦点陷阱 / ESC / backdrop，
 * 这些容易写错的东西交给浏览器），外观与文案全自绘。
 *
 * 为什么单独一个文件：这个控件有「服务端渲染的壳」+「客户端的行为」两面，
 * 塞进 `shell.ts`（外壳渲染）或 `assets.ts`（客户端脚本）都会让那个文件
 * 同时承担两种职责。它是**一个控件**，所以自己一个文件。
 */
import { escapeAttr, escapeText } from './escape.ts'

/** 确认框的 DOM id：客户端脚本按 id 找元素。 */
export const CONFIRM_DIALOG_ID = 'dizzy-confirm'

export interface ConfirmDialogOptions {
  /** 标题（可省略，默认「确认操作」）。 */
  readonly title?: string
  /** 确认按钮文案（默认「确认」）。 */
  readonly confirmLabel?: string
  /** 取消按钮文案（默认「取消」）。 */
  readonly cancelLabel?: string
}

/**
 * 确认框的 `<dialog>` 壳。
 *
 * 服务端**每个页面渲染一次**（放在文档末尾），不是每次用到才插一个——
 * 因为 `<dialog>` 需要在 DOM 里存在才能 `showModal()`。
 *
 * 内容初始为空：文案由客户端脚本在**触发时**填进去（表单上的
 * `data-confirm` 属性才是每次操作的真实文案）。
 */
export function renderConfirmDialog(options: ConfirmDialogOptions = {}): string {
  const title = options.title ?? '确认操作'
  const confirmLabel = options.confirmLabel ?? '确认'
  const cancelLabel = options.cancelLabel ?? '取消'
  return `<dialog class="dialog dialog--confirm" id="${CONFIRM_DIALOG_ID}" aria-labelledby="${CONFIRM_DIALOG_ID}-title">
<div class="dialog__body">
<h2 class="dialog__title" id="${CONFIRM_DIALOG_ID}-title">${escapeText(title)}</h2>
<p class="dialog__text" data-confirm-text></p>
</div>
<div class="dialog__actions">
<button class="btn btn--ghost" type="button" data-confirm-cancel>${escapeText(cancelLabel)}</button>
<button class="btn" type="button" data-confirm-ok>${escapeText(confirmLabel)}</button>
</div>
</dialog>`
}

/**
 * 给按钮 / 表单加「点之前先确认」的钩子。
 *
 * 用在表单上：`<form data-confirm="确定删除？">`。
 * 用在链接 / 按钮上：`<button data-confirm="确定删除？">`。
 */
export function confirmAttr(message: string): string {
  return `data-confirm="${escapeAttr(message)}"`
}
