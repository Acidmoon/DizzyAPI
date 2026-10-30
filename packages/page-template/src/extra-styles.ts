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

/* ── 侧栏拖动排序（Pointer Events）────────────────────────────────
 * touch-action: none 只加在可拖项上：触屏上「按住拖动」必须由我们接管，
 * 否则浏览器会先把它当成滚动（见 client-nav-order.ts 顶部）。
 * 键鼠用户看不到区别；不可拖的底部链接（退出登录）不在此列。 */
.side-nav .side-link[data-nav-path] { touch-action: none; cursor: grab; }
.side-link--dragging {
  cursor: grabbing; position: relative; z-index: 5;
  background: var(--sidebar-nav-active); opacity: .9;
  box-shadow: 0 8px 24px rgba(0,0,0,.45);
}

/* ── 数据表格 ────────────────────────────────────────────────────
 * 用 overflow-x: auto 而不是 overflow: hidden：窄屏上宽表格（用量明细 13 列）
 * 会被 hidden **裁掉右边几列**（实测 420px：表格宽 560 > 视口 420，46 个单元格
 * 不可见）。改成可横向滚动，圆角照样裁得到，数据不会被吞。 */
.panel { background: var(--bg-layer-1); border-radius: 16px; overflow-x: auto; overflow-y: hidden; margin-bottom: 24px; }
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

/* ── 区块节奏 ────────────────────────────────────────────────────────
 * 改前：.section-title 只有下边距（0 0 12px），上边全靠前一个元素自己的
 * margin —— 图表卡后面直接贴着标题、表格后面又是另一段距离，一页一个样。
 * 现在**标题自己带上边距**（28px），前一元素的下边距与它相邻会折叠，
 * 所以「上一块 → 标题」永远是 28px、「标题 → 内容」永远是 12px。 */
.section-title { font-size: var(--fs-emphasis); line-height: var(--lh-emphasis); font-weight: 600; margin: 28px 0 12px; }
.section-title:first-child { margin-top: 0; }

/* ── 指标分组（主次 + 分组标题）───────────────────────────────────────
 * 结构 = 组标题 + 组内网格。组内卡片用 grid（天然等宽等高）；
 * 组与组之间 24px，主指标卡（.card--primary）数字更大、带强调色。 */
.metric-groups { display: flex; flex-direction: column; gap: 24px; margin-bottom: 24px; }
.metric-group { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.metric-group-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.metric-group-title {
  margin: 0; font-size: var(--fs-caption); line-height: var(--lh-caption);
  font-weight: 600; color: var(--label-tertiary); letter-spacing: var(--ls-normal);
}
.metric-group-note { font-size: var(--fs-micro); line-height: var(--lh-micro); color: var(--label-caption); }
.metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; align-items: stretch; }
.metric-grid > .card { min-width: 0; }
/* 主指标：左侧强调条 + 强调色数字（比次级指标大一号，见 assets.ts 的 .value-main）。 */
.card--primary { box-shadow: inset 3px 0 0 var(--accent); }
.card--primary .card-label { color: var(--label-secondary); }
.card--primary .value-main { color: var(--accent); }

/* ── 分组键值对（详情页 / 详情弹窗）───────────────────────────────────
 * 一节一个小标题，节内是 label-value 对：label 定宽、值右对齐 + tabular-nums，
 * 长值换行不撑破。窄屏把 label 收到值上面一行。 */
.kv-groups { display: grid; grid-template-columns: minmax(0, 1fr); gap: 20px 24px; }
.kv-group { min-width: 0; }
.kv-group-title {
  margin: 0 0 8px; font-size: var(--fs-caption); line-height: var(--lh-caption);
  font-weight: 600; color: var(--label-tertiary);
}
.kv-list { margin: 0; display: flex; flex-direction: column; }
.kv-row {
  display: grid; grid-template-columns: auto minmax(0, 1fr);
  gap: 4px 12px; align-items: baseline; padding: 6px 0;
  border-bottom: 1px solid var(--border-l1);
}
.kv-row:last-child { border-bottom: none; }
.kv-key { font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--label-tertiary); min-width: 0; }
.kv-value {
  margin: 0; text-align: right; font-size: var(--fs-label); line-height: var(--lh-label);
  color: var(--label-primary); font-variant-numeric: tabular-nums;
  min-width: 0; overflow-wrap: anywhere;
}
.kv-value--mono { font-family: Menlo, Monaco, Consolas, monospace; font-size: var(--fs-caption); }
@media (min-width: 720px) {
  .kv-groups { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
}
@media (max-width: 600px) {
  .kv-row { grid-template-columns: minmax(0, 1fr); }
  .kv-value { text-align: left; }
}

/* ── 详情页的折叠分组（details.card.card--group）──────────────────────
 * .card 本身是 flex 行（给指标卡用的），套在 details 上会让标题与内容
 * **并排成两列**——上游账号详情页的分组一直是这样挤着的。这里恢复成块级，
 * 并给标题行一点可点的样子（箭头随展开旋转）。 */
.card--group { display: block; padding: 0; min-height: 0; }
.card--group > summary {
  display: flex; align-items: center; gap: 8px;
  padding: 14px 20px; cursor: pointer; list-style: none;
  font-size: var(--fs-body); line-height: var(--lh-body); font-weight: 600;
}
.card--group > summary::-webkit-details-marker { display: none; }
.card--group > summary::before {
  content: '▸'; color: var(--label-caption); font-size: var(--fs-caption);
  transition: transform .15s ease;
}
.card--group[open] > summary::before { transform: rotate(90deg); }
.card--group[open] > summary { border-bottom: 1px solid var(--border-l2); margin-bottom: 16px; }
.card-body { padding: 0 20px 16px; display: flex; flex-direction: column; gap: 16px; }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.pager { display: flex; gap: 8px; align-items: center; margin: 12px 0 24px; font-size: var(--fs-label); color: var(--label-tertiary); }
@media (max-width: 767px) {
  .grid-2 { grid-template-columns: minmax(0, 1fr); }
  .table { font-size: var(--fs-caption); }
  .table th, .table td { padding: 10px 12px; }
}
`
