/**
 * 模板之外的补充样式：表格、表单、提示条、登录卡、分页。
 *
 * 与 `assets.ts` 的 PAGE_CSS 分开，保持像素级原文不被改动；
 * 这里只新增类名，颜色与圆角全部复用同一套 token。
 */
export const COMPONENT_CSS = `
/* ── 数据表格 ──────────────────────────────────────────────────── */
.panel { background: var(--bg-layer-1); border-radius: 16px; overflow: hidden; margin-bottom: 24px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; line-height: 20px; }
.table th {
  text-align: left; font-weight: 500; color: var(--label-tertiary);
  padding: 12px 16px; border-bottom: 1px solid var(--border-l1); white-space: nowrap;
}
.table td { padding: 12px 16px; border-bottom: 1px solid var(--border-l1); color: var(--label-secondary); }
.table tr:last-child td { border-bottom: none; }
.table tr:hover td { background: var(--bg-layer-2); }
.table .num { text-align: right; font-variant-numeric: tabular-nums; }
.table .mono { font-family: Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.table .empty-row td { color: var(--label-caption); text-align: center; padding: 32px 16px; }

/* ── 表单 ──────────────────────────────────────────────────────── */
.form { display: flex; flex-direction: column; gap: 16px; max-width: 520px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field > label { font-size: 13px; line-height: 20px; color: var(--label-secondary); }
.field .hint { font-size: 12px; line-height: 18px; color: var(--label-caption); }
.input, .select, .textarea {
  background: var(--bg-layer-2); border: 1px solid var(--border-l2); border-radius: 10px;
  color: var(--label-primary); font: inherit; font-size: 14px; line-height: 22px;
  padding: 8px 12px; height: 38px; outline: none; width: 100%;
}
.textarea { height: auto; min-height: 96px; resize: vertical; }
.input:focus, .select:focus, .textarea:focus { border-color: var(--border-l3); }
.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end; }
.row > .field { flex: 1 1 200px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.btn.danger { background: transparent; color: var(--error, #F25A5A); border: 1px solid var(--border-l2); }
.btn.small { height: 28px; min-width: 0; padding: 0 10px; font-size: 12px; border-radius: 14px; }
.inline-form { display: inline; }

/* ── 提示条 ────────────────────────────────────────────────────── */
.notice {
  display: flex; align-items: center; gap: 8px; border-radius: 10px;
  padding: 10px 14px; font-size: 13px; line-height: 20px; margin-bottom: 20px;
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
.auth-title { font-size: 22px; line-height: 30px; font-weight: 600; margin: 0; }
.auth-sub { font-size: 13px; line-height: 20px; color: var(--label-tertiary); margin: 0; }
.auth-foot { font-size: 13px; color: var(--label-tertiary); display: flex; gap: 6px; }

/* ── 标签与状态 ────────────────────────────────────────────────── */
.badge {
  display: inline-flex; align-items: center; height: 22px; padding: 0 8px;
  border-radius: 6px; font-size: 12px; line-height: 18px;
  background: var(--bg-layer-2); color: var(--label-secondary);
}
.badge.ok { background: rgba(34,197,94,.12); color: var(--success); }
.badge.warn { background: rgba(245,158,11,.12); color: #F59E0B; }
.badge.err { background: rgba(242,90,90,.12); color: #F25A5A; }
.muted { color: var(--label-caption); }
.mono { font-family: Menlo, Monaco, Consolas, monospace; font-size: 12px; }
.section-title { font-size: 16px; line-height: 24px; font-weight: 600; margin: 0 0 12px; }
.grid-2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.stack { display: flex; flex-direction: column; gap: 12px; }
.pager { display: flex; gap: 8px; align-items: center; margin: 12px 0 24px; font-size: 13px; color: var(--label-tertiary); }
@media (max-width: 767px) {
  .grid-2 { grid-template-columns: minmax(0, 1fr); }
  .table { font-size: 12px; }
  .table th, .table td { padding: 10px 12px; }
}
`
