/**
 * 完整 HTML 文档外壳：`<!doctype>` / `<head>` / 资源链接 / 底部脚本。
 *
 * 为什么从 `shell.ts` 拆出来：那个文件同时装「文档骨架」和「侧栏 / 卡片 / 表格 /
 * 表单控件」两类东西，早就顶过 400 行软上限。文档骨架是**每个页面都要走**的一段，
 * 独立之后改它（比如加第二张样式表）不用碰任何组件渲染代码。
 *
 * 两条硬约束：
 * 1. **生产必须走外链**。CSP 是 `style-src 'self'` / `script-src 'self'`，
 *    内联 `<style>` / `<script>` 一律被拦。`assets` 缺省时的那条内联分支**只给测试用**。
 * 2. **`jsHrefs` 的顺序是契约**，见 `DocumentOptions.assets.jsHrefs` 的注释。
 */
import { CLIENT_JS, PAGE_CSS } from './assets.ts'
import { COMPONENT_CSS } from './extra-styles.ts'
import { LAYOUT_CSS } from './layout-classes.ts'
import { MODAL_CSS } from './modal.ts'
import { TOAST_CSS, renderToastHost } from './toast.ts'
import { TOOLTIP_CSS, renderTooltipHost } from './tooltip.ts'
import { renderConfirmDialog } from './confirm.ts'
import { escapeAttr, escapeText } from './escape.ts'

export interface DocumentOptions {
  readonly title: string
  /** `<body>` 里的内容，通常是一次 `renderShell()` 的结果。 */
  readonly body: string
  /** 给出时用外链；不给则把样式与脚本内联进文档（仅测试用：生产 CSP 会拦内联）。 */
  readonly assets?: {
    readonly cssHref: string
    /**
     * 第二张样式表（**用户偏好**：`/assets/theme.css`）。
     *
     * 必须**排在 `cssHref` 之后**：它只覆盖 `--font-scale` / `--letter-spacing` 这类
     * CSS 变量与规则，压在基础样式后面才生效（同优先级下后者胜）。
     *
     * 与 `cssHref` 的区别是**缓存语义**：`app.css` 带内容哈希、`immutable`；
     * 这张是**按用户**生成的，必须 `private, no-store`（不然 A 用户的字号会缓存给 B）。
     */
    readonly themeCssHref?: string
    /**
     * 按顺序输出的 `<script src>` 列表。
     *
     * **顺序有意义，别随手排序**：
     * 1. 第三方库之间有依赖（`floating-ui.dom` 要用 `floating-ui.core` 暴露的全局 `FloatingUICore`）；
     * 2. `/assets/app.js` **必须排最后**——它初始化各控件，并在 htmx 加载之后
     *    设置 `htmx.config.includeIndicatorStyles = false`。
     *    若 app.js 在 htmx 之前执行，那时 `window.htmx` 还是 `undefined`，
     *    配置设不进去，htmx 会按默认值注入一段内联 `<style>`（被 CSP 拦掉）。
     *    实测见 AGENTS.md「前端 / CSP」一节。
     */
    readonly jsHrefs?: readonly string[]
  }
}

/** 渲染完整 HTML 文档。 */
export function renderDocument(options: DocumentOptions): string {
  const { title, body, assets } = options
  const style = assets === undefined
    ? `<style>${PAGE_CSS}${COMPONENT_CSS}${LAYOUT_CSS}${MODAL_CSS}${TOOLTIP_CSS}${TOAST_CSS}</style>`
    : [
      `<link rel="stylesheet" href="${escapeAttr(assets.cssHref)}">`,
      ...(assets.themeCssHref === undefined
        ? []
        : [`<link rel="stylesheet" href="${escapeAttr(assets.themeCssHref)}">`]),
    ].join('\n')
  // 外链模式：按给定顺序逐个输出，顺序本身是契约（见 DocumentOptions.assets.jsHrefs）。
  // 内联模式只给测试用——生产 CSP 是 style-src/script-src 'self'，内联会被拦。
  const script = assets === undefined
    ? `<script>${CLIENT_JS}</script>`
    : (assets.jsHrefs ?? []).map((href) => `<script src="${escapeAttr(href)}"></script>`).join('\n')
  return `<!doctype html>
<html lang="zh-CN" class="dark" data-ds-dark-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#151517">
<title>${escapeText(title)}</title>
${style}
</head>
<body>
<div class="sr-only" id="dizzy-status" role="status" aria-live="polite"></div>
${body}
${renderConfirmDialog()}
${renderToastHost()}
${renderTooltipHost()}
${script}
</body>
</html>
`
}
