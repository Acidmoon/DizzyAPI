/**
 * 文档站（`/console/docs`）的样式：**顶部一行分类导航 + 左侧本页目录 + 正文**。
 *
 * 为什么 CSS 放在 `packages/web/src/content/`：样式要进 `/assets/app.css`，
 * 而那张表的装配点是 `web/src/asset-version.ts`（`APP_CSS_BODY`）——本批只有
 * `pages/**`、`content/**` 与 `docs/api/**` 归文档线，所以样式文本放这里，
 * `asset-version.ts` 只加一个 import 与一个数组元素（见该文件里的一行注释）。
 *
 * 三条纪律：
 * 1. **CSP 是 `style-src 'self'`**：页面里不许出现内联 `style=`，类名必须在这里定义。
 * 2. **零 JS 退化**：语言标签页是**原生单选组 + `:checked` 兄弟选择器**，
 *    没有脚本也能切；目录在没有脚本时就是一串普通 `<a>`。
 * 3. **字号只走 token**（`--fs-*` / `--lh-*`）：用户能调字号档位，写死 px 会跟着一起歪。
 */
export const DOCS_SITE_CSS = `
/* ── 文档站：跳过导航（作为 <body> 的第一个可聚焦元素，见 pages/docs.ts）───── */
.skip-link {
  position: absolute; left: 8px; top: -48px; z-index: 90;
  padding: 10px 16px; border-radius: 10px;
  background: var(--brand-primary); color: #111214;
  font-size: var(--fs-body); line-height: var(--lh-body); font-weight: 500;
}
.skip-link:focus { top: 8px; }

/* ── 文档站：整体骨架 ─────────────────────────────────────────────
 * .col 的 max-width 是 936px（模板给的），文档站要在里面塞「目录 + 正文」两列，
 * 所以这里不抢宽度，只做两列网格。窄屏折叠成单列（见文件末尾的媒体查询）。 */
.docs-page { display: flex; flex-direction: column; gap: 16px; }

/* 顶部一行分类导航：吸顶，滚正文时一直在。 */
.docs-cats {
  position: sticky; top: 0; z-index: 6;
  display: flex; flex-wrap: wrap; gap: 4px;
  padding: 8px 0; margin: -8px 0 0;
  background: var(--bg-base);
  border-bottom: 1px solid var(--border-l1);
}
.docs-cat {
  display: inline-flex; align-items: center; height: 34px; padding: 0 12px;
  border-radius: 10px; color: var(--label-tertiary);
  font-size: var(--fs-label); line-height: var(--lh-label); white-space: nowrap;
  transition: background-color .16s ease, color .16s ease;
}
.docs-cat:hover { background: var(--bg-layer-2); color: var(--label-primary); }
.docs-cat[aria-current="true"] { background: var(--bg-layer-3); color: var(--label-primary); font-weight: 600; }
.docs-cat:focus-visible { outline: 2px solid #4D93F8; outline-offset: 2px; }

.docs-layout {
  display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 28px;
  align-items: start;
}

/* ── 本页目录（左侧固定）──────────────────────────────────────────── */
.docs-toc { position: sticky; top: 56px; max-height: calc(100vh - 72px); overflow: auto; }
.docs-toc-title {
  margin: 0 0 8px; color: var(--label-caption);
  font-size: var(--fs-caption); line-height: var(--lh-caption);
}
.docs-toc-list, .docs-toc-sub { margin: 0; padding: 0; list-style: none; }
.docs-toc-sub { margin: 2px 0 6px 10px; border-left: 1px solid var(--border-l1); padding-left: 8px; }
.docs-toc-sub .docs-toc-sub { border-left: none; padding-left: 8px; }
.docs-toc-link {
  display: block; padding: 4px 6px; border-radius: 6px;
  color: var(--label-tertiary); font-size: var(--fs-caption); line-height: var(--lh-caption);
  overflow-wrap: anywhere;
  transition: background-color .16s ease, color .16s ease;
}
.docs-toc-link:hover { background: var(--bg-layer-2); color: var(--label-primary); }
.docs-toc-link:focus-visible { outline: 2px solid #4D93F8; outline-offset: 1px; }
/* 一级（分类）比二级粗一点：目录里也要能分出层级。 */
.docs-toc-cat > .docs-toc-link { color: var(--label-secondary); font-weight: 600; }

/* 移动端的折叠目录：<details>，默认收起，不占正文宽度。 */
.docs-toc-mobile {
  display: none;
  background: var(--bg-layer-1); border: 1px solid var(--border-l1);
  border-radius: 12px; padding: 10px 14px;
}
.docs-toc-mobile > summary {
  cursor: pointer; color: var(--label-secondary);
  font-size: var(--fs-label); line-height: var(--lh-label);
}
.docs-toc-mobile[open] > summary { margin-bottom: 8px; }

/* ── 正文 ──────────────────────────────────────────────────────── */
.docs-body { min-width: 0; }
.docs-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 8px; }
.docs-section + .docs-section { margin-top: 40px; }
.docs-intro { margin: 0 0 16px; color: var(--label-secondary); font-size: var(--fs-body); line-height: var(--lh-body); }

/* 标题层级：页面 h1（模板给的 page-title）→ 分类 h2 → markdown ## 变 h3 → ### 变 h4。
 * scroll-margin-top 让锚点跳转后标题不被吸顶的分类导航压住。
 * **实测值**（Chrome 156 / 1440×900）：分类导航吸顶后底边在 83px，
 * 所以这里取 96px（留 13px 呼吸），写 72px 会让标题顶到导航底边下面（真机实测过）。 */
.docs-h2, .docs-h3, .docs-h4 {
  position: relative;
  scroll-margin-top: 96px; text-wrap: balance;
  /* 右侧给「#」留位置：它绝对定位在右边缘，正文不该跑到它下面。 */
  padding-right: 18px;
  /* 入口标题里有 v1beta 那种长串（模型名 + :streamGenerateContent）：
   * 不许它把正文撑出横向滚动条（真机实测 390px 下撑出 27px）。 */
  overflow-wrap: anywhere;
}
.docs-h2 {
  margin: 0 0 16px; padding-top: 8px;
  font-size: var(--fs-emphasis); line-height: var(--lh-emphasis); font-weight: 600;
}
.docs-h3 {
  margin: 28px 0 12px;
  font-size: var(--fs-body); line-height: var(--lh-body); font-weight: 600;
}
.docs-h4 {
  margin: 22px 0 10px;
  font-size: var(--fs-label); line-height: var(--lh-label); font-weight: 600;
  color: var(--label-secondary);
}
/* 标题后的「#」永久链接：指针悬停 / 键盘聚焦到标题时出现，不占版面。
 * **绝对定位在右边缘**：inline 排版时它跟在长标题后面，会把整行撑宽
 * （窄屏实测 350px 正文被撑到 417px）；left: 100% 同样会溢出到容器外。 */
.docs-anchor {
  position: absolute; right: 0; top: 0;
  color: var(--label-caption); font-weight: 400; opacity: 0;
  transition: opacity .16s ease;
}
.docs-h2:hover .docs-anchor,
.docs-h3:hover .docs-anchor,
.docs-h4:hover .docs-anchor,
.docs-anchor:focus-visible { opacity: 1; }

/* 正文段落 / 列表：节奏与首页一致（16px 段间距）。 */
.docs-body p {
  margin: 0 0 16px; color: var(--label-secondary);
  font-size: var(--fs-body); line-height: var(--lh-body);
}
.docs-body ul, .docs-body ol {
  margin: 0 0 16px; padding-left: 22px; color: var(--label-secondary);
  font-size: var(--fs-body); line-height: var(--lh-body);
}
.docs-body li { margin-bottom: 6px; }
.docs-body li > ul, .docs-body li > ol { margin-top: 6px; margin-bottom: 6px; }
.docs-body strong { color: var(--label-primary); font-weight: 600; }

/* ── 表格：宽表在自己的框里横向滚，不撑破正文 ────────────────────── */
.docs-table { overflow-x: auto; }
.docs-table .table { min-width: 100%; }
.docs-table .table td { vertical-align: top; }

/* ── 代码块 ──────────────────────────────────────────────────────
 * 一个 .docs-code = 工具栏（语言名 + 复制）+ 代码；多语言时工具栏变成标签页。
 * 语言切换**纯 CSS**：radio 与面板是兄弟，用 :nth-of-type 对齐序号。
 * 三种元素标签名互不相同（radio=input / 标签=label / 面板=div），序号不会串。 */
.docs-code { position: relative; margin: 0 0 16px; }
.docs-code-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-height: 28px; margin-bottom: 6px;
}
.docs-code-lang {
  color: var(--label-caption); font-size: var(--fs-caption); line-height: var(--lh-caption);
}
/* 多语言时工具栏里只有「复制」一个元素：space-between 会把它推到左边，
 * 所以显式靠右，与参考站（右上角复制）一致。 */
.docs-code .docs-copy { flex: none; margin-left: auto; }.docs-pre {
  margin: 0; padding: 14px 16px; overflow: auto; border-radius: 12px;
  background: var(--bg-layer-1); border: 1px solid var(--border-l1);
  font-size: var(--fs-caption); line-height: 1.6;
}
.docs-pre code { font-family: Menlo, Monaco, Consolas, monospace; }

/* 标签页头：label 就是按钮；选中的那个高亮。 */
.docs-code-tabs { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.docs-code-tab {
  display: inline-flex; align-items: center; height: 28px; padding: 0 10px;
  border-radius: 8px; cursor: pointer; user-select: none;
  background: var(--bg-layer-1); color: var(--label-tertiary);
  font-size: var(--fs-caption); line-height: var(--lh-caption);
  transition: background-color .16s ease, color .16s ease;
}
.docs-code-tab:hover { background: var(--bg-layer-2); color: var(--label-primary); }
/* 单选控件本身不可见但仍可聚焦（键盘方向键切页，焦点环画在 label 上）。 */
.docs-code-radio {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0;
  border: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
}
.docs-code-radio:nth-of-type(1):checked ~ .docs-code-tabs > .docs-code-tab:nth-of-type(1),
.docs-code-radio:nth-of-type(2):checked ~ .docs-code-tabs > .docs-code-tab:nth-of-type(2),
.docs-code-radio:nth-of-type(3):checked ~ .docs-code-tabs > .docs-code-tab:nth-of-type(3) {
  background: var(--bg-layer-3); color: var(--label-primary); font-weight: 600;
}
.docs-code-radio:nth-of-type(1):focus-visible ~ .docs-code-tabs > .docs-code-tab:nth-of-type(1),
.docs-code-radio:nth-of-type(2):focus-visible ~ .docs-code-tabs > .docs-code-tab:nth-of-type(2),
.docs-code-radio:nth-of-type(3):focus-visible ~ .docs-code-tabs > .docs-code-tab:nth-of-type(3) {
  outline: 2px solid #4D93F8; outline-offset: 2px;
}
/* 面板：默认全隐藏，选中的那个显示。 */
.docs-code-pane { display: none; }
.docs-code-radio:nth-of-type(1):checked ~ .docs-code-pane:nth-of-type(1),
.docs-code-radio:nth-of-type(2):checked ~ .docs-code-pane:nth-of-type(2),
.docs-code-radio:nth-of-type(3):checked ~ .docs-code-pane:nth-of-type(3) {
  display: block;
}

/* ── 窄屏：目录折叠、单列、留足点击区 ────────────────────────────── */
@media (max-width: 1023px) {
  .docs-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
  .docs-toc { display: none; }
  .docs-toc-mobile { display: block; }
}
@media (max-width: 767px) {
  .docs-cats { gap: 2px; }
  .docs-cat { height: 32px; padding: 0 10px; }
  .docs-code-tab { height: 32px; }
  .docs-pre { font-size: var(--fs-micro); }
}
/* 用户要求「减少动态效果」时不做悬停过渡。 */
@media (prefers-reduced-motion: reduce) {
  .docs-cat, .docs-toc-link, .docs-code-tab, .docs-anchor { transition: none; }
}
`
