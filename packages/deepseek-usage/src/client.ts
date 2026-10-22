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
  --chart-grid: rgba(255,255,255,.12);
  --chart-axis: rgb(150,150,150);
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
.side-logo { display: flex; align-items: center; gap: 6px; height: 24px; }
.side-word { font-size: 22px; font-weight: 600; letter-spacing: -.4px; line-height: 24px; }
.side-badge {
  font-size: 10px; line-height: 14px; padding: 1px 4px; border-radius: 3px;
  background: var(--label-primary); color: #111214; font-weight: 500;
}
.side-nav { display: flex; flex-direction: column; gap: 2px; }
.side-link {
  display: flex; align-items: center; gap: 10px; height: 42px; padding: 0 16px;
  border-radius: 14px; color: var(--label-primary); font-size: 14px; line-height: 25px;
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
  color: var(--label-tertiary); font-size: 16px; font-weight: 600; overflow: hidden;
}
.side-avatar img { width: 100%; height: 100%; object-fit: cover; }
.side-name { font-size: 16px; font-weight: 600; }

.main { flex: 1 1 auto; min-width: 0; overflow: auto; padding: 32px 40px; }
.col { max-width: 936px; margin: 0 auto; width: 100%; }

/* ── 标题 ──────────────────────────────────────────────────────── */
.page-title { font-size: 24px; line-height: 32px; font-weight: 600; margin: 0 0 8px; }
.page-note {
  display: flex; align-items: center; gap: 4px; margin: 0 0 16px;
  color: var(--label-tertiary); font-size: 14px; line-height: 22px;
}
.page-note .info { color: var(--label-caption); display: inline-flex; }

/* ── 余额卡 ────────────────────────────────────────────────────── */
.balances { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; margin-bottom: 40px; }
.card {
  background: var(--bg-module-platform); border-radius: 16px; padding: 16px 20px;
  min-height: 100px; display: flex; flex: 1 1 0; min-width: 0; gap: 12px;
}
.card-col { display: flex; flex-direction: column; justify-content: space-between; gap: 12px; width: 100%; }
.card-head { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; min-width: 0; }
.card-label { font-size: 14px; line-height: 22px; color: var(--label-primary); white-space: nowrap; }
.card-info { color: var(--label-caption); display: inline-flex; margin-right: 4px; }
.card-value-row { display: flex; align-items: flex-end; gap: 12px 16px; flex-wrap: wrap; width: 100%; }
.card-value { display: flex; align-items: baseline; gap: 6px; }
.value-main { font-size: 29px; line-height: 36px; font-weight: 500; font-variant-numeric: tabular-nums; }
.value-unit { font-size: 16px; line-height: 24px; color: var(--label-caption); }
.tag {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px;
  border-radius: 4px; font-size: 12px; line-height: 18px; white-space: nowrap;
  background: var(--success-tertiary); color: var(--success);
}
.tag a { text-decoration: underline; }
.btn {
  display: inline-flex; align-items: center; justify-content: center; height: 36px;
  padding: 0 14px; min-width: 72px; border-radius: 18px; border: none; cursor: pointer;
  background: var(--brand-primary); color: #111214; font-size: 14px; font-weight: 500;
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
  background: var(--bg-module-platform); color: var(--label-primary); font-size: 14px;
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
  padding: 8px 10px; border-radius: 8px; font-size: 14px; line-height: 22px; cursor: pointer;
  color: var(--label-primary); white-space: nowrap;
}
.menu-item:hover { background: var(--bg-layer-2); }
.menu-item[aria-selected="true"] { color: var(--label-primary); font-weight: 600; }

/* ── 指标卡 ────────────────────────────────────────────────────── */
.metrics { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px; margin-bottom: 24px; }
/* 原站三张指标卡等宽排布 */
.metrics .card { flex: 1 1 0; }

/* ── 图表卡 ────────────────────────────────────────────────────── */
.chart-card {
  background: var(--bg-module-platform); border-radius: 16px; padding: 20px 20px 12px;
  min-height: 335px; display: flex; flex-direction: column;
}
.chart-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; margin-bottom: 13px; }
.chart-titles { display: flex; align-items: baseline; gap: 6px 4px; flex-wrap: wrap; min-width: 0; margin-top: 1px; }
.chart-title { font-size: 14px; line-height: 22px; font-weight: 600; }
.chart-total { font-size: 14px; line-height: 22px; color: var(--label-secondary); font-variant-numeric: tabular-nums; }
.segmented { display: inline-flex; gap: 3px; padding: 2px; border-radius: 20px; background: var(--bg-layer-2); flex: none; }
.seg-item {
  border-radius: 20px; height: 24px; padding: 0 8px; font-size: 11px; line-height: 14px;
  color: var(--label-primary); white-space: nowrap; display: inline-flex; align-items: center;
}
.seg-item[aria-selected="true"] { background: var(--label-primary); color: #111214; font-weight: 600; }
.segmented button {
  border: none; background: transparent; border-radius: 20px; height: 24px; padding: 0 8px;
  font-size: 11px; line-height: 14px; color: var(--label-primary); cursor: pointer;
  font-weight: 400; white-space: nowrap;
}
.segmented button[aria-selected="true"] { background: var(--label-primary); color: #111214; font-weight: 600; }
.plot { flex: 1; min-height: 0; position: relative; }
.plot svg { display: block; width: 100%; height: auto; overflow: visible; }
/* 网格线与坐标轴文字：原站实测值（见 THEME_VARS 的 --chart-grid / --chart-axis）。 */
.grid-line { stroke: var(--chart-grid); stroke-width: 1; }
.axis-text { fill: var(--chart-axis); font-size: 12px; font-variant-numeric: tabular-nums; }
.bar { transition: opacity .15s ease; }
.bar:hover { opacity: .82; }
/* 模型小图里的面积折线：填充与描边都写在 path 属性上，这里只做过渡。 */
.line { transition: opacity .15s ease; }
.line:hover { opacity: .82; }
.legend { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-top: 8px; }
.legend-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 18px; color: var(--label-tertiary); }
.legend-dot { width: 8px; height: 8px; border-radius: 2px; }

/* ── 模型分块 ──────────────────────────────────────────────────── */
.models { display: flex; flex-direction: column; gap: 24px 12px; margin-top: 24px; }
.model-name { font-size: 16px; line-height: 28px; font-weight: 600; margin-bottom: 16px; }
.model-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.mini {
  background: var(--bg-module-platform); border-radius: 16px; padding: 23px 20px 12px;
  display: flex; flex-direction: column; gap: 12px; min-width: 0;
}
.mini-head { display: flex; align-items: center; gap: 4px; min-width: 0; }
.mini-label { font-size: 14px; line-height: 22px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mini-value { font-size: 14px; line-height: 22px; color: var(--label-secondary); font-variant-numeric: tabular-nums; flex-shrink: 0; }
.mini-plot { position: relative; }
/* 小图画布 422×272，与原站一致：宽度撑满卡片，高度按比例。 */
.mini-plot svg { display: block; width: 100%; height: auto; overflow: visible; }

/* ── 提示 ──────────────────────────────────────────────────────── */
.empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 8px; padding: 64px 0; color: var(--label-tertiary); font-size: 14px;
}
@media (max-width: 767px) {
  .main { padding: 20px; }
  .side { display: none; }
  .model-grid { grid-template-columns: minmax(0, 1fr); }
}
`

/**
 * 客户端脚本：下拉菜单的展开与收起。
 *
 * 页面是**服务端渲染**的：筛选条件都在 URL 查询串里（`range` / `apiKeyId` / `group`），
 * 菜单项就是普通链接，点了直接导航过去——状态因此可分享、可刷新、可后退。
 * 脚本只负责「点开浮层菜单」这一件事，不需要重绘任何东西。
 */
export const CLIENT_JS = `
(function () {
  'use strict';

  function closeAll(except) {
    var pills = document.querySelectorAll('.pill[aria-expanded="true"]');
    for (var i = 0; i < pills.length; i++) {
      if (pills[i] !== except) pills[i].setAttribute('aria-expanded', 'false');
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var pill = target.closest('.pill');
    if (pill) {
      var open = pill.getAttribute('aria-expanded') === 'true';
      closeAll(pill);
      pill.setAttribute('aria-expanded', open ? 'false' : 'true');
      event.stopPropagation();
      return;
    }

    // 点到菜单项：让它按链接正常导航（脚本不拦截），但先收起浮层。
    if (target.closest('.menu-item')) {
      closeAll(null);
      return;
    }

    closeAll(null);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeAll(null);
  });
})();
`
