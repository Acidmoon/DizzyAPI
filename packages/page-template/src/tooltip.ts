/**
 * 悬浮提示（Tooltip）：自绘浮层，替掉 `title` 属性 / SVG `<title>`。
 *
 * 为什么必须换：浏览器原生提示由**浏览器绘制**，CSS 碰不到（字色、圆角、延迟、
 * 换行都不可控），而且中文长文本会挤成一条。owner 第 3 条要求「不用浏览器默认控件」，
 * 这条与下拉 / 日历是同一类问题。
 *
 * **渐进增强**：
 * - 服务端只输出一个 `data-tooltip="…"` 属性（`tooltipAttr()`），不输出任何浮层结构；
 * - 浮层由客户端脚本创建一次（`<div class="tooltip">`，`TOOLTIP_JS`），定位用
 *   Floating UI 的 `computePosition`（MIT，vendor 在本地，CSP 保持 `'self'`）；
 * - 没有 JS 时属性无副作用。**图表柱子额外保留 `<title>`** 作无 JS 兜底，
 *   脚本接管时会把它摘掉，否则原生提示与自绘浮层会同时弹出来。
 *
 * 定位为什么用库而不是自己算：tooltip 要处理「上方放不下就翻到下方」「左右不出界」
 * 这些边界，手写版本在小屏与弹窗里都出过问题（见 AGENTS.md 的 flatpickr 那条）。
 */
import { escapeAttr } from './escape.ts'

/** 提示属性的名字：服务端渲染与客户端脚本共用这一个常量（别各写各的字符串）。 */
export const TOOLTIP_ATTR = 'data-tooltip'

/** 提示浮层的元素 id（`renderDocument` 会输出这个壳）。 */
export const TOOLTIP_HOST_ID = 'dizzy-tooltip'

/**
 * 提示浮层的属性片段，拼进任意元素的属性位。
 *
 * 返回字符串前面**带一个空格**，用法：`<button class="btn"${tooltipAttr('复制完整 key')}>`。
 */
export function tooltipAttr(text: string): string {
  return ` ${TOOLTIP_ATTR}="${escapeAttr(text)}"`
}

/** 浮层壳：由 `renderDocument` 输出一次，客户端脚本往里写文本。 */
export function renderTooltipHost(): string {
  return `<div class="tooltip" id="${TOOLTIP_HOST_ID}" role="tooltip" hidden></div>`
}

/**
 * 这段 HTML 里有没有需要提示的元素（决定这一页要不要引 Floating UI）。
 *
 * 为什么要判：floating-ui 两个包共 22 KB。挂在所有页面上，登录页 / 注册页
 * 就要为一张不存在的图表多下 22 KB——上一批被驳回的正是「每页下载用不到的库」。
 * 判据是**已渲染的 HTML 里有没有那个属性**，不是「这个页面理论上可能加提示」：
 * 漏判的后果只是提示不起作用（`<title>` 兜底还在），多判的后果才是白下载。
 */
export function needsTooltips(html: string): boolean {
  return html.includes(TOOLTIP_ATTR)
}

/** 提示浮层的 CSS（由 `web` 拼进 `/assets/app.css`）。 */
export const TOOLTIP_CSS = `
/* ── 悬浮提示（自绘，替掉原生 title）─────────────────────────────────
 * 浮层固定定位（不受 .main 的滚动容器影响），坐标由 Floating UI 现算。
 * 颜色沿用同一套 token，不使用任何浏览器默认外观。 */
.tooltip {
  position: fixed;
  top: 0; left: 0;
  z-index: 60;
  max-width: 320px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-l3);
  background: var(--bg-layer-3);
  color: var(--label-primary);
  font-size: var(--fs-caption);
  line-height: var(--lh-caption);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .40);
  /* 浮层自己不能吃鼠标事件：否则鼠标移向提示的一瞬间触发 mouseleave，浮层开始闪 */
  pointer-events: none;
  white-space: normal;
  word-break: break-word;
}
.tooltip[hidden] { display: none; }
/* 让带提示的元素有一个「可交互」的视觉暗示（只在真的需要的地方加类）。 */
.has-tooltip { cursor: help; }
`
