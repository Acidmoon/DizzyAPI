/**
 * 布局修饰类：给基础类加「一点变化」用。
 *
 * 为什么单独一个文件：这些类**全部**是修饰类（`--` 后缀），用途单一——
 * 「在某个基础类上追加一点间距/尺寸/换行」，不涉及颜色、不涉及组件结构。
 * 放进 `extra-styles.ts` 会让那个文件同时装「组件样式」和「修饰类」两种东西，
 * 违反「一个文件一个职责」。
 *
 * **这些类存在的唯一理由**：站点 CSP 是 `style-src 'self'`，
 * HTML 里的 `style="…"` 会被浏览器**静默丢弃**（属性写进去了，但
 * `getComputedStyle` 拿到的还是旧值）。原先 27 处内联样式就是这么「写了但从来没生效过」，
 * 其中 9 处是 `max-width:none`（本意是「别把表单限宽 520px」），实际一直在限宽——
 * 这就是「按钮和控件粘在一起」的根因之一。
 */
const LAYOUT_CLASSES = `

/* ── 表单：宽窄 ─────────────────────────────────────────────────
 * .form 默认 max-width: 520px（窄栏）。筛选栏、编辑弹窗这类要占满主列的
 * 表单加 --wide（等价于原先被丢弃的 style="max-width:none"）。
 * .form--tight 则相反：更窄，用于登录卡里的那种小表单。 */
.form--wide { max-width: none; }
.form--tight { max-width: 380px; }

/* ── 表单：与上下内容的间距 ───────────────────────────────────────
 * .form 是 flex 列容器，gap 管的是**表单内部**各字段之间的距离；
 * 与前后内容（面板、标题）的距离是外部间距，用 margin。
 * .form--flush = 不要外部下边距（紧跟下一个元素）。 */
.form--spaced { margin-bottom: 24px; }
.form--flush { margin-bottom: 0; }

/* ── 行内控件 ────────────────────────────────────────────────────
 * .row 默认 flex-wrap，控件同行并排（align-items: flex-end 让输入框与按钮底对齐）。
 * 有些表单希望**操作区另起一行**——比如「创建 API key」：名称输入框占满宽度，
 * 按钮单独一行更好按，也不至于在窄栏里挤在一起。
 *
 * 注意：这是**局部**修饰类，不是全局规则。曾经的全局 .row > .actions { flex: 1 1 100% }
 * 会让所有页面里 .row 的按钮组都换行（管理台的筛选栏、上游账号页的批量操作…），
 * 一处改样式、全站变样，所以改成按需加类。 */
.row--stack-actions > .actions { flex: 1 1 100%; }

/* ── 行内表单 ──────────────────────────────────────────────────────
 * .form 是**纵向**列容器（gap 24px，一行一个字段），适合编辑表单。
 * 筛选栏要的是「控件横向排一行、窄了自动换行」，那是 .form--inline。
 *
 * 为什么不能继续用原来的 .inline-form（display: inline）：.input 是 width: 100%，
 * 在 inline 容器里每个控件都占满整行，视觉上等于纵向堆叠——审计页的筛选栏一直是
 * 这样堆着的（实测截图）。这里给 .input 显式宽度，让它真的排成一行。 */
.form--inline {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  max-width: none;
}
.form--inline .input { width: auto; min-width: 150px; height: 38px; }
.form--inline .input--narrow { min-width: 0; width: 110px; }
.form--inline .btn { height: 38px; }
/* Tom Select 的可见框是 .ts-control（不是 .input），高度要单独钉住，
 * 否则它按库默认的 padding 撑到 40px+，比同排的输入框高、并且会压到下面的内容。 */
.form--inline .ts-wrapper .ts-control { min-height: 38px; height: 38px; padding: 0 12px; }
.form--inline .ts-wrapper { min-width: 170px; }

/* ── 面板：内边距 ────────────────────────────────────────────────
 * .panel 默认是卡片（overflow:hidden，用于表格容器）。内容型面板
 * （放一段说明或一段代码）用 --pad 给自己的内边距。 */
.panel--pad { padding: 16px; }
.panel--pad-wide { padding: 16px 18px; }

/* ── 过滤行 ────────────────────────────────────────────────────────
 * .filters 默认 margin: 40px 0 24px。紧凑场景（页尾分页、告警条）
 * 用 --tight 收紧。 */
.filters--tight { margin-top: 12px; margin-bottom: 12px; }
.filters--wrap { flex-wrap: wrap; }

/* ── 段落与列表 ────────────────────────────────────────────────────
 * 文档正文里的段落 / 列表：原先用 style="margin:0 0 10px" 这类内联样式控制
 * 段落节奏，全部被 CSP 丢掉了，所以文档页的段落其实是浏览器默认 margin。
 * 这里给出明确的类，让节奏可控。 */
.p--tight { margin: 0 0 10px; }
.p--flush { margin: 0; }
.p--spaced { margin: 0 0 16px; }
.p--label { margin: 0 0 4px; }

/* 文档里的条目列表：左缩进 + 段间距。 */
.list--docs { margin: 0 0 16px; padding-left: 20px; }
.list--docs-tight { margin: 0 0 10px; padding-left: 20px; }

/* ── 代码块 ────────────────────────────────────────────────────────
 * 文档页的 pre 元素：可横向滚动、内边距、不要默认 margin。 */
.code--block { overflow: auto; padding: 14px 16px; margin: 0 0 16px; }
`

/** 布局修饰类的 CSS 文本。由 `web` 拼进 `/assets/app.css`。 */
export const LAYOUT_CSS = `
/* ── 模态框（原生 <dialog>，外观自绘）───────────────────────────────
 * 原生 <dialog> **没有任何默认外观**：它只提供焦点陷阱 / ESC / backdrop
 * 这些容易写错的行为，外观与文案全部由我们决定。
 * 位置用 inset + margin auto（而不是 left/top），这样能真正居中。 */
.dialog {
  border: 1px solid var(--border-l3);
  border-radius: 14px;
  background: var(--bg-layer-3);
  color: var(--label-primary);
  padding: 0;
  max-width: 440px;
  width: calc(100% - 32px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, .48);
}
.dialog::backdrop { background: rgba(0, 0, 0, .56); }
.dialog__body { padding: 22px 24px 8px; }
.dialog__title { font-size: var(--fs-emphasis); line-height: var(--lh-emphasis); font-weight: 600; margin: 0 0 8px; }
.dialog__text { font-size: var(--fs-body); line-height: var(--lh-body); color: var(--label-secondary); margin: 0; }
/* 按钮排在右下：取消在左、确认在右（危险操作确认框是主按钮）。 */
.dialog__actions {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 16px 24px 20px;
}
.btn--ghost { background: transparent; color: var(--label-primary); border: 1px solid var(--border-l2); }

/* ── 布局修饰类 ──────────────────────────────────────────────────────
 * 全部是「在某个基础类上追加一点间距 / 尺寸 / 换行」的修饰类。
 * 存在的唯一理由：站点 CSP 的 style-src 'self' 会把 HTML 里的 style="…"
 * 静默丢弃，所以这些变化必须走 class。 */
${LAYOUT_CLASSES}
`
