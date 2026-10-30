/**
 * 深拷贝原站「用量信息」页的**交互行为**（不是原站代码，是按观察到的行为重写）。
 *
 * 观察到的行为（来自原站 DOM 与交互）：
 *
 * - 顶部两个下拉：时间维度（近 30 天 / 近 7 天 / 近 90 天）与 API Key（全部 / 逐个 key）。
 *   原站是 React 受控组件：点开 → 浮层菜单 → 点一项 → 菜单收起、数据重算。
 * - 图表右上角的分段控件在「调用类型 / API Key」之间切换**分组维度**：
 *   「调用类型」按缓存命中与否分两组（因此有黄/橙两色），
 *   「API Key」按 key 分组（因此柱子更多、颜色更多）。
 * - 「导出」按钮导出当前筛选条件下的明细。
 * - 「更多」是图标按钮。
 *
 * 这里用原生 DOM + CSS 实现同样的行为，不引任何运行时依赖。
 */

/** 深色主题下的 CSS 变量；页面所有颜色都从这里取。 */
export const THEME_VARS = `
:root {
  color-scheme: dark;
  --bg-base: #151517;
  --bg-layer-1: #232324;
  --bg-layer-2: #2C2C2E;
  --bg-layer-3: #353638;
  --bg-module-platform: #353638;
  --bg-overlay: #43454A;
  --border-l1: rgba(255,255,255,.06);
  --border-l2: rgba(255,255,255,.12);
  --border-l3: rgba(255,255,255,.16);
  --label-primary: #F9FAFB;
  --label-secondary: #CFD3D6;
  --label-tertiary: #ADB2B8;
  --label-caption: #81858C;
  --brand-primary: #F9FAFB;
  --success: #22C55E;
  --success-tertiary: #233C2C;
  --sidebar-fill: #1B1B1C;
  --sidebar-nav-active: #43454A;
  --sidebar-nav-hover: #2C2C2E;
  --chart-1: #FD8D3C;
  --chart-2: #FED976;
  /* 主指标的强调色：与图表主色同一支橙，只用在「主指标数字 / 左侧强调条」上。 */
  --accent: #FD8D3C;
  --chart-grid: rgba(255,255,255,.12);
  --chart-axis: rgb(150,150,150);

  /* ── 字号与行高 ─────────────────────────────────────────────────
   * 唯一源是 tokens.ts 的 FONT_ROLES；这里的数字必须与它逐条相等，
   * 有守护用例（page-template.test.ts「字号单一源」）盯着，改一边不改另一边会红。
   *
   * --font-scale 是用户的字号档位（0.875 / 1 / 1.25 / 1.5），由 web 的
   * /assets/theme.css 覆盖到 :root。九个档位全部乘同一个系数，
   * 所以「调字号」只需要覆盖这一个变量，不用重写九条。
   *
   * 行高是**无单位**倍数，跟着 font-size 自动缩放——这是用户选「特大」时
   * 文字不重叠的前提。 */
  --font-scale: 1;
  --fs-micro: calc(12px * var(--font-scale));     --lh-micro: 1.4;
  --fs-chip: calc(13px * var(--font-scale));      --lh-chip: 1.27;
  --fs-caption: calc(14px * var(--font-scale));   --lh-caption: 1.5;
  --fs-label: calc(15px * var(--font-scale));     --lh-label: 1.54;
  --fs-body: calc(16px * var(--font-scale));      --lh-body: 1.57;
  --fs-emphasis: calc(18px * var(--font-scale));  --lh-emphasis: 1.5;
  --fs-brand: calc(26px * var(--font-scale));     --lh-brand: 1.09;
  --fs-title: calc(28px * var(--font-scale));     --lh-title: 1.33;
  --fs-metric: calc(34px * var(--font-scale));    --lh-metric: 1.24;

  /* ── 字距：按角色分，不搞全局一个值 ───────────────────────────────
   * .side-word 原本是负字距（品牌字收紧是设计意图），全局加正值会把它撑开。 */
  --ls-normal: 0.01em;
  --ls-tight: -0.02em;
}
`

/**
 * 页面骨架的 CSS。
 *
 * 数值全部来自 `tokens.ts` 的实测结果（侧栏 260px、主列 32/40px 内边距、
 * 卡片 16px 圆角、指标大数字 29/36、图表网格线 #4E4E50 等）。
 */
export const PAGE_CSS = `${THEME_VARS}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--bg-base);
  color: var(--label-primary);
  font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-variant-ligatures: no-contextual;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  /* 全站字距放宽；品牌字等紧凑处用 --ls-tight 覆盖回去。 */
  letter-spacing: var(--ls-normal);
}
a { color: inherit; text-decoration: none; }
button { font: inherit; color: inherit; }

/* ── 布局：侧栏 + 主列 ─────────────────────────────────────────── */
.shell { display: flex; height: 100vh; overflow: hidden; }
.side {
  width: 260px; flex: 0 0 260px; height: 100%;
  background: var(--sidebar-fill);
  padding: 12px; overflow: auto;
  display: flex; flex-direction: column;
}
.side-top { display: flex; align-items: center; gap: 8px; margin: 12px 0 32px; padding-left: 14px; }
/* 高度跟着品牌字走：字号上调后固定 24px 会把 26px 的字裁掉。 */
.side-logo { display: flex; align-items: center; gap: 6px; height: auto; }
.side-word { font-size: var(--fs-brand); font-weight: 600; letter-spacing: var(--ls-tight); line-height: var(--lh-brand); }
.side-badge {
  font-size: var(--fs-micro); line-height: var(--lh-micro); padding: 1px 4px; border-radius: 3px;
  background: var(--label-primary); color: #111214; font-weight: 500;
}
.side-nav { display: flex; flex-direction: column; gap: 2px; }
.side-link {
  display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 16px;
  border-radius: 14px; color: var(--label-primary); font-size: var(--fs-body); line-height: var(--lh-body);
  transition: background-color .2s ease;
}
.side-link:hover { background: var(--sidebar-nav-hover); }
.side-link[aria-current="page"] { background: var(--sidebar-nav-active); }
.side-link .ico { width: 18px; height: 18px; flex: 0 0 18px; color: var(--label-tertiary); }
.side-link[aria-current="page"] .ico { color: #4D93F8; }
.side-sep { height: 1px; background: var(--border-l1); margin: 8px 0; }
.side-foot { margin-top: auto; padding-top: 24px; display: flex; flex-direction: column; gap: 2px; }
.side-user {
  display: flex; align-items: center; gap: 8px; margin-top: 4px; margin-left: 2px;
  padding: 6px 2px 6px 6px; border-radius: 12px; width: fit-content;
}
.side-user:hover { background: var(--sidebar-nav-hover); }
.side-avatar {
  width: 32px; height: 32px; border-radius: 50%; flex: 0 0 32px;
  background: rgba(255,255,255,.08) center/cover no-repeat;
  display: flex; align-items: center; justify-content: center;
  color: var(--label-tertiary); font-size: var(--fs-emphasis); font-weight: 600; overflow: hidden;
}
.side-avatar img { width: 100%; height: 100%; object-fit: cover; }
.side-name { font-size: var(--fs-emphasis); font-weight: 600; }

.main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 32px 40px; }
.col { max-width: 936px; margin: 0 auto; width: 100%; }

/* ── 标题 ──────────────────────────────────────────────────────── */
.page-title { font-size: var(--fs-title); line-height: var(--lh-title); font-weight: 600; margin: 0 0 8px; }
.page-note {
  display: flex; align-items: center; gap: 4px; margin: 0 0 16px;
  color: var(--label-tertiary); font-size: var(--fs-body); line-height: var(--lh-body);
}
.page-note .info { color: var(--label-caption); display: inline-flex; }

/* ── 余额卡 ────────────────────────────────────────────────────── */
.balances { display: flex; flex-wrap: wrap; gap: 12px; align-items: stretch; margin-bottom: 40px; }
.card {
  background: var(--bg-module-platform); border-radius: 16px; padding: 16px 20px;
  min-height: 100px; display: flex; flex: 1 1 0; min-width: 0; gap: 12px;
}
.card-col { display: flex; flex-direction: column; justify-content: space-between; gap: 12px; width: 100%; }
.card-head { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.card-label { font-size: var(--fs-body); line-height: var(--lh-body); color: var(--label-primary); white-space: nowrap; }
.card-info { color: var(--label-caption); display: inline-flex; margin-right: 4px; }
.card-value-row { display: flex; align-items: flex-end; gap: 12px 16px; flex-wrap: wrap; width: 100%; min-width: 0; }
.card-value { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
/* 次级指标用 title 字号（28px）；主指标与余额大卡是 metric 字号（34px，见下）。
 * 数字可以换行（overflow-wrap），长值不会把卡片撑破——但级差保证主指标一眼最重。 */
.value-main {
  font-size: var(--fs-title); line-height: var(--lh-title);
  font-weight: 500; font-variant-numeric: tabular-nums;
  min-width: 0; overflow-wrap: anywhere;
}
.balances .value-main,
.card--primary .value-main { font-size: var(--fs-metric); line-height: var(--lh-metric); }
.value-unit { font-size: var(--fs-emphasis); line-height: var(--lh-emphasis); color: var(--label-caption); }
.tag {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px;
  border-radius: 4px; font-size: var(--fs-caption); line-height: var(--lh-caption); white-space: nowrap;
  background: var(--success-tertiary); color: var(--success);
}
.tag a { text-decoration: underline; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; height: 36px;
  padding: 0 14px; min-width: 72px; border-radius: 18px; border: none; cursor: pointer;
  background: var(--brand-primary); color: #111214; font-size: var(--fs-body); font-weight: 500;
  white-space: nowrap; transition: opacity .2s ease;
}
.btn:hover { opacity: .88; }
.btn.ghost { background: transparent; color: var(--label-primary); }
.icon-btn {
  width: 36px; height: 36px; border-radius: 50%; border: none; background: transparent;
  color: var(--label-primary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
}
.icon-btn:hover { background: var(--interactive-bg-hover, rgba(255,255,255,.08)); }

.divider { height: 1px; background: var(--border-l2); margin: 10px 0 32px; }

/* ── 过滤行 ────────────────────────────────────────────────────── */
.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin: 40px 0 24px; }
.filter-group { display: flex; flex: 1 1 max-content; flex-wrap: wrap; align-items: center; gap: 16px; min-width: 0; }
.filter-right { margin-left: auto; display: flex; align-items: center; gap: 4px; }
/* 胶囊是浮层菜单的定位上下文：菜单相对它绝对定位。 */
.pill-wrap { position: relative; display: inline-flex; }
.pill {
  display: inline-flex; align-items: center; gap: 12px; height: 36px; min-width: 90px;
  max-width: 280px; padding: 0 14px; border-radius: 18px; cursor: pointer; user-select: none;
  background: var(--bg-module-platform); color: var(--label-primary); font-size: var(--fs-body);
  border: none; position: relative;
}
.pill-label { color: var(--label-tertiary); white-space: nowrap; flex-shrink: 0; }
.pill-sep { width: 1px; height: 14px; background: var(--border-l1); flex-shrink: 0; }
.pill-value { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 auto; min-width: 0; }
.pill-caret { color: var(--label-primary); display: inline-flex; flex-shrink: 0; transition: transform .2s ease; }
.pill[aria-expanded="true"] .pill-caret { transform: rotate(180deg); }
.menu {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 20; min-width: 100%;
  background: var(--bg-layer-3); border: 1px solid var(--border-l3); border-radius: 12px;
  padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.36); display: none;
}
.pill[aria-expanded="true"] .menu { display: block; }
.menu-item {
  display: block; width: 100%; text-align: left; background: transparent; border: none;
  padding: 8px 10px; border-radius: 8px; font-size: var(--fs-body); line-height: var(--lh-body); cursor: pointer;
  color: var(--label-primary); white-space: nowrap;
}
.menu-item:hover { background: var(--bg-layer-2); }
.menu-item[aria-selected="true"] { color: var(--label-primary); font-weight: 600; }

/* ── 指标卡 ────────────────────────────────────────────────────── */
/* 改前：display:flex + flex-wrap，卡片再 flex: 1 1 0 —— 8 张卡被压成一行、
 * 每张 ~110px 宽，「今日 Tokens / 累计 Tokens / 累计隔离」全糊在一起
 * （owner 的原话：「全站用量这些指标全部挤在一起，谁能看得清楚？」）。
 *
 * 现在用网格：桌面最多 4 列、窄了自动降列，同一行的卡片**等宽等高**；
 * 需要主次时用 .metric-groups（组标题 + 网格 + 主指标卡，见 extra-styles.ts）。 */
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  align-items: stretch;
  margin-bottom: 24px;
}
.metrics .card { min-width: 0; }

/* ── 图表卡 ────────────────────────────────────────────────────── */
.chart-card {
  background: var(--bg-module-platform); border-radius: 16px; padding: 20px 20px 12px;
  min-height: 335px; display: flex; flex-direction: column;
}
.chart-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 13px; }
.chart-titles { display: flex; align-items: baseline; gap: 6px 4px; flex-wrap: wrap; min-width: 0; margin-top: 1px; }
.chart-title { font-size: var(--fs-body); line-height: var(--lh-body); font-weight: 600; }
.chart-total { font-size: var(--fs-body); line-height: var(--lh-body); color: var(--label-secondary); font-variant-numeric: tabular-nums; }
.segmented { display: inline-flex; gap: 3px; padding: 2px; border-radius: 20px; background: var(--bg-layer-2); flex: none; }
.seg-item {
  border-radius: 20px; height: 24px; padding: 0 8px; font-size: var(--fs-chip); line-height: var(--lh-chip);
  color: var(--label-primary); white-space: nowrap; display: inline-flex; align-items: center;
}
.seg-item[aria-selected="true"] { background: var(--label-primary); color: #111214; font-weight: 600; }
.segmented button {
  border: none; background: transparent; border-radius: 20px; height: 24px; padding: 0 8px;
  font-size: var(--fs-chip); line-height: var(--lh-chip); color: var(--label-primary); cursor: pointer;
  font-weight: 400; white-space: nowrap;
}
.segmented button[aria-selected="true"] { background: var(--label-primary); color: #111214; font-weight: 600; }
.plot { flex: 1; min-height: 0; position: relative; }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
/* 网格线与坐标轴文字：原站实测值（见 THEME_VARS 的 --chart-grid / --chart-axis）。 */
.grid-line { stroke: var(--chart-grid); stroke-width: 1; }
.axis-text { fill: var(--chart-axis); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.bar { transition: opacity .15s ease; }
.bar:hover { opacity: .82; }
/* 模型小图里的面积折线：填充与描边都写在 path 属性上，这里只做过渡。 */
.line { transition: opacity .15s ease; }
.line:hover { opacity: .82; }
.legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 8px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-caption); line-height: var(--lh-caption); color: var(--label-tertiary); }
.legend-dot { width: 8px; height: 8px; border-radius: 2px; }

/* ── 模型分块 ──────────────────────────────────────────────────── */
.models { display: flex; flex-direction: column; gap: 24px 12px; margin-top: 24px; }
/* 行高 1.75 比 emphasis 的 1.5 松：它是分块标题，下方紧跟 16px 间距。 */
.model-name { font-size: var(--fs-emphasis); line-height: 1.75; font-weight: 600; margin-bottom: 16px; }
.model-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.mini {
  background: var(--bg-module-platform); border-radius: 16px; padding: 23px 20px 12px;
  display: flex; flex-direction: column; gap: 12px; min-width: 0;
}
.mini-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.mini-label { font-size: var(--fs-body); line-height: var(--lh-body); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-value { font-size: var(--fs-body); line-height: var(--lh-body); color: var(--label-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.mini-plot { position: relative; }
/* 小图画布 422×272，与原站一致：宽度撑满卡片，高度按比例。 */
.mini-plot svg { display: block; width: 100%; height: auto; overflow: visible; }

/* ── 提示 ──────────────────────────────────────────────────────── */
.empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; padding: 64px 0; color: var(--label-tertiary); font-size: var(--fs-body);
}
@media (max-width: 767px) {
  .main { padding: 20px; }
  .side { display: none; }
  .model-grid { grid-template-columns: minmax(0, 1fr); }
}
`


// 客户端脚本单独成文件（见 client-script.ts）；这里重新导出，导入路径保持不变。
export { CLIENT_JS } from './client-script.ts'
