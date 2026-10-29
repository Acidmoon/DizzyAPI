/**
 * 模板之外的补充样式：表格、表单、提示条、登录卡、分页。
 *
 * 与 `assets.ts` 的 PAGE_CSS 分开，保持像素级原文不被改动；
 * 这里只新增类名，颜色与圆角全部复用同一套 token。
 */
export const COMPONENT_CSS = `
/* ── htmx：indicator 样式（服务端输出，不是 JS 注入）─────────────
 * 为什么写在这里：htmx 默认会自己 insertAdjacentHTML 注入一段内联 <style>
 * 来实现这两个类，而被 \`style-src 'self'\` 拦掉（实测 1 条违规）。
 * 我们的做法是关掉它的注入（app.js 里 includeIndicatorStyles = false），
 * 把等价规则放进这份**服务端 CSS**——必须服务端输出：靠 JS 补的话，
 * 首屏第一次请求时 indicator 会先裸奔一下。
 * 规则与 htmx 自带的一致，另加 transition 让显隐不生硬。 */
.htmx-indicator { opacity: 0; visibility: hidden; transition: opacity 200ms ease-in; }
.htmx-request .htmx-indicator,
.htmx-request.htmx-indicator { opacity: 1; visibility: visible; }

/* ── 数据表格 ──────────────────────────────────────────────────── */
.panel { background: var(--bg-layer-1); border-radius: 16px; overflow: hidden; margin-bottom: 24px; }
.table { width: 100%; border-collapse: collapse; font-size: var(--fs-label); line-height: var(--lh-label); }
.table th {
  text-align: left; font-weight: 500; color: var(--label-tertiary);
  padding: 12px 16px; border-bottom: 1px solid var(--border-l1); white-space: nowrap;
}
.table td { padding: 12px 16px; border-bottom: 1px solid var(--border-l1); color: var(--label-secondary); }
.table tr:last-child td { border-bottom: none; }
.table tr:hover td { background: var(--bg-layer-2); }
.table .num { text-align: right; font-variant-numeric: tabular-nums; }
.table .mono { font-family: Menlo, Monaco, Consolas, monospace; font-size: var(--fs-caption); }
.table .empty-row td { color: var(--label-caption); text-align: center; padding: 32px 16px; }

/* ── 表单 ──────────────────────────────────────────────────────── */
/* 第 7 条：表单块之间 24px（原先 16px 太挤）；行内控件之间 12px 见 .row；按钮组 8px 见 .actions。 */
.form { display: flex; flex-direction: column; gap: 24px; max-width: 520px; }
/* 宽表单：替代页面里那些被 CSP 丢掉的 style="max-width:none"（见 27 处内联样式）。 */
.form--wide { max-width: none; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { font-size: var(--fs-label); line-height: var(--lh-label); color: var(--label-secondary); }
.field .hint { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--label-caption); }
.input, .select, .textarea {
  background: var(--bg-layer-2); border: 1px solid var(--border-l2); border-radius: 10px;
  color: var(--label-primary); font: inherit; font-size: var(--fs-body); line-height: var(--lh-body);
  padding: 8px 12px; height: 38px; outline: none; width: 100%;
}
.textarea { height: auto; min-height: 96px; resize: vertical; }
.input:focus, .select:focus, .textarea:focus { border-color: var(--border-l3); }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.row > .field { flex: 1 1 200px; }
/* 第 7 条：.row 里的按钮组独占一行——原先「名称输入框 + 创建按钮」挤在 520px 的同一行，
 * 而被 CSP 丢掉的 style="max-width:none" 没能把表单放宽，于是看着「粘在一起」。 */
.row > .actions { flex: 1 1 100%; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btn.danger { background: transparent; color: var(--error, #F25A5A); border: 1px solid var(--border-l2); }
.btn.small { height: 28px; min-width: 0; padding: 0 10px; font-size: var(--fs-caption); border-radius: 14px; }
.inline-form { display: inline; }

/* ── 提示条 ────────────────────────────────────────────────────── */
.notice {
  display: flex; align-items: center; gap: 8px; border-radius: 10px;
  padding: 10px 14px; font-size: var(--fs-label); line-height: var(--lh-label); margin-bottom: 20px;
  background: var(--bg-layer-2); color: var(--label-secondary);
}
.notice.ok { background: rgba(34,197,94,.12); color: var(--success); }
.notice.err { background: rgba(242,90,90,.12); color: #F25A5A; }

/* ── 登录 / 注册卡 ─────────────────────────────────────────────── */
.auth-wrap {
  min-height: 100vh; display: flex; align-items: center; justify-content: center;
  padding: 32px 20px; background: var(--bg-base);
}
.auth-card {
  width: 100%; max-width: 380px; background: var(--bg-layer-3); border-radius: 16px;
  padding: 28px 24px; display: flex; flex-direction: column; gap: 18px;
}
.auth-title { font-size: var(--fs-brand); line-height: var(--lh-brand); font-weight: 600; margin: 0; }
.auth-sub { font-size: var(--fs-label); line-height: var(--lh-label); color: var(--label-tertiary); margin: 0; }
.auth-foot { font-size: var(--fs-label); color: var(--label-tertiary); display: flex; gap: 6px; }

/* ── 标签与状态 ────────────────────────────────────────────────── */
.badge {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px;
  border-radius: 6px; font-size: var(--fs-caption); line-height: var(--lh-caption);
  background: var(--bg-layer-2); color: var(--label-secondary);
}
.badge.ok { background: rgba(34,197,94,.12); color: var(--success); }
.badge.warn { background: rgba(245,158,11,.12); color: #F59E0B; }
.badge.err { background: rgba(242,90,90,.12); color: #F25A5A; }
.muted { color: var(--label-caption); }
.mono { font-family: Menlo, Monaco, Consolas, monospace; font-size: var(--fs-caption); }
.section-title { font-size: var(--fs-emphasis); line-height: var(--lh-emphasis); font-weight: 600; margin: 0 0 12px; }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.pager { display: flex; gap: 8px; align-items: center; margin: 12px 0 24px; font-size: var(--fs-label); color: var(--label-tertiary); }
@media (max-width: 767px) {
  .grid-2 { grid-template-columns: minmax(0, 1fr); }
  .table { font-size: var(--fs-caption); }
  .table th, .table td { padding: 10px 12px; }
}
`
