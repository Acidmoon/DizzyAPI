/**
 * 弹窗（Modal / Dialog）：外壳是原生 `<dialog>` + `showModal()`，外观全自绘。
 *
 * 为什么用原生 `<dialog>` 而不是自己写遮罩 div：
 * - **焦点陷阱**：`showModal()` 之后 tab 键只在弹窗内循环，浏览器负责。手写版本在
 *   Safari / 移动端都会被绕出去（`inert` 在旧 Safari 上不生效）。
 * - **ESC 关闭**、**backdrop 伪元素**（`::backdrop`）、**顶层层叠顺序**（不会被任何
 *   `z-index` 盖住）都是浏览器给的，自己实现要踩一堆坑。
 * - 原生 `<dialog>` **没有任何默认外观**（连背景都是透明的），所以「外观自绘」与
 *   「用原生控件」不冲突——它提供的只是行为。
 *
 * 服务端只输出结构，**开合交给 `CLIENT_JS` 的委托监听**：
 * `<button data-dialog-open="<id>">` 打开，`<button data-dialog-close>` 关闭，
 * 点 backdrop（`data-dialog-backdrop`）关闭。
 *
 * **无 JS 的降级**：`<dialog>` 默认 `display: none`，所以没脚本时弹窗内容不可见。
 * 因此**不要把唯一入口放进弹窗**：用弹窗承载编辑表单的页面，必须同时保留一个
 * 不依赖脚本的整页路径（详情页 / 行内表单），否则禁用 JS 的用户完全改不了数据。
 */
import { escapeAttr, escapeText } from './escape.ts'

export interface ModalOptions {
  /** 元素 id，同时是 `data-dialog-open` 的目标。一页里多个弹窗时必须各自唯一。 */
  readonly id: string
  /** 标题，进 `<h2>` 并被 `aria-labelledby` 引用。 */
  readonly title: string
  /** 正文 HTML（调用方负责转义；这里原样输出）。 */
  readonly bodyHtml: string
  /** 底部操作区 HTML（一般是 `<button>` / `<a class="btn">`）。 */
  readonly footerHtml?: string
  /** 宽度档：默认 440px；`wide` 560px；`full` 720px（表格类内容用）。 */
  readonly size?: 'default' | 'wide' | 'full'
  /** 额外 class（拼在 `.dialog` 后面）。 */
  readonly className?: string
}

/** 弹窗的结构化 CSS（由 `web` 拼进 `/assets/app.css`）。 */
export const MODAL_CSS = `
/* ── 弹窗（原生 <dialog>，外观自绘）────────────────────────────────────
 * 原生 <dialog> 只提供行为（焦点陷阱 / ESC / ::backdrop / 顶层），外观全在这里。
 * 位置用 inset + margin auto 而不是 left/top：后者在 <dialog> 上不能居中。 */
.dialog--modal {
  border: 1px solid var(--border-l3);
  border-radius: 16px;
  background: var(--bg-layer-3);
  color: var(--label-primary);
  padding: 0;
  max-width: 440px;
  width: calc(100% - 32px);
  max-height: calc(100vh - 64px);
  /* 不能 hidden：弹窗里的日期日历是 dialog 的子元素（为了跟着进顶层），
   * 输入框靠下时日历会伸到 dialog 外面，hidden 会把它裁掉。
   * 圆角由 header / footer 的内边距兜住，滚动交给 .dialog__body。 */
  overflow: visible;
  box-shadow: 0 20px 56px rgba(0, 0, 0, .52);
}
.dialog--modal.dialog--wide { max-width: 560px; }
.dialog--modal.dialog--full { max-width: 720px; }
.dialog--modal::backdrop { background: rgba(0, 0, 0, .56); }

/* 头：标题 + 关闭按钮，底边一条分隔线。 */
.dialog__head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 18px 22px 14px;
  border-bottom: 1px solid var(--border-l2);
}
.dialog__head .dialog__title { margin: 0; }
.dialog__close {
  flex: none;
  width: 30px; height: 30px;
  display: inline-flex; align-items: center; justify-content: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--label-secondary);
  font-size: var(--fs-emphasis); line-height: 1;
  cursor: pointer;
}
.dialog__close:hover { background: var(--bg-layer-2); color: var(--label-primary); }
/* 焦点环用中性色：brand-primary 几乎是纯白，用在 2px 外描边上像一圈灯管。
 * 弹窗打开时浏览器会把焦点放到第一个可聚焦元素（通常就是这个关闭按钮），
 * 所以这一条是「每次打开弹窗都看得见」的样式，必须收敛。 */
.dialog__close:focus-visible { outline: 2px solid var(--label-tertiary); outline-offset: 2px; }

/* 正文：可滚动区。长表单放弹窗里时，头部与底部按钮保持静止。 */
.dialog__body--modal { padding: 20px 22px; overflow: auto; max-height: calc(100vh - 260px); }
/* 正文里的表单默认限宽 520px，弹窗里要占满。 */
.dialog__body--modal .form { max-width: none; }

/* 底部操作区：右对齐，取消在左、确认在右。 */
.dialog__actions--modal { padding: 14px 22px 18px; border-top: 1px solid var(--border-l2); }
`

/**
 * 渲染一个弹窗外壳。
 *
 * 注意：`bodyHtml` / `footerHtml` 是**原样输出**的 HTML，转义由调用方负责
 * （正文通常是整张表单，逐字段转义发生在调用方更自然）。
 */
export function renderModal(options: ModalOptions): string {
  const size = options.size === undefined || options.size === 'default' ? '' : ` dialog--${options.size}`
  const extra = options.className === undefined ? '' : ` ${options.className}`
  const id = escapeAttr(options.id)
  const titleId = `${id}-title`
  const footer =
    options.footerHtml === undefined
      ? ''
      : `<div class="dialog__actions dialog__actions--modal">${options.footerHtml}</div>`
  return `<dialog class="dialog dialog--modal${size}${escapeAttr(extra)}" id="${id}" aria-labelledby="${titleId}" data-dialog-backdrop>
<div class="dialog__head">
<h2 class="dialog__title" id="${titleId}">${escapeText(options.title)}</h2>
<button class="dialog__close" type="button" data-dialog-close aria-label="关闭">✕</button>
</div>
<div class="dialog__body dialog__body--modal">${options.bodyHtml}</div>
${footer}
</dialog>`
}

/**
 * 打开某个弹窗的属性片段，拼进任意触发元素上。
 *
 * 用法：`<button class="btn small" type="button"${t.dialogOpenAttr('key-3')}>编辑</button>`
 *
 * 返回字符串前面**带一个空格**，直接拼在属性位即可。
 */
export function dialogOpenAttr(id: string): string {
  return ` data-dialog-open="${escapeAttr(id)}"`
}
