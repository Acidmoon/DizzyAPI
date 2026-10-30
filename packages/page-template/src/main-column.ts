/**
 * 主列（`<main>`）：整页与 htmx 局部刷新**共用这一段**。
 *
 * 为什么单独一个文件：第 4 批要求「侧栏切换只刷新右侧内容」，而护栏是
 * **抓整页 HTML 里 `<main>` 那一截，与 `HX-Request` 的响应体逐字比对**。
 * 最省事的做法是「整页渲染完，把 `<main>` 切出来回给 htmx」——这样片段
 * 天然是整页的子串，不可能因为两个函数各拼一遍而漂移。这段代码就干两件事：
 * 渲染这一段、按同一套切法从整页里切出来。
 *
 * 两个附加属性是给客户端用的，**不重复标题与路径的来源**：
 * - `data-page-title`：整页 `<title>` 的文本（同一个变量传进 renderDocument 与这里）；
 * - `data-page-path`：当前页路径，htmx 换入后据此更新侧栏高亮（不靠猜 URL）。
 *
 * 无 JS 时两个属性都没有副作用；锚点的 `href` 是唯一的导航入口。
 */
import { escapeAttr } from './escape.ts'

export interface MainColumnOptions {
  /** 主列内容（页面模块渲染好的 HTML）。 */
  readonly content: string
  /** 整页 `<title>` 的文本；与 `DocumentOptions.title` **必须是同一个值**。 */
  readonly pageTitle?: string
  /** 当前页路径（`/console/usage` 这种），客户端据此同步侧栏高亮。 */
  readonly pagePath?: string
}

/** `<main>` 的开始标记：切片段、写用例都认这一个字符串。 */
export const MAIN_COLUMN_OPEN = '<main class="main"'

/** 主列的 id：跳过链接（`#main-content`）与 `aria-labelledby` 之类都按它定位。 */
export const MAIN_COLUMN_ID = 'main-content'

/**
 * 渲染主列。整页里 `<main>` 那一截就是它的返回值（不改写、不重排）。
 *
 * `id` / `tabindex="-1"` 是**跳过链接的落点**：`<a href="#main-content">` 只是把
 * 视口滚过来，用户按 Tab 还是从链接后面那个元素继续；只有落点本身可聚焦
 * （`tabindex="-1"`）浏览器才会把焦点一起交过去，键盘用户才真的「跳进正文」。
 */
export function renderMainColumn(options: MainColumnOptions): string {
  const title = options.pageTitle === undefined
    ? ''
    : ` data-page-title="${escapeAttr(options.pageTitle)}"`
  const path = options.pagePath === undefined
    ? ''
    : ` data-page-path="${escapeAttr(options.pagePath)}"`
  return `${MAIN_COLUMN_OPEN} id="${MAIN_COLUMN_ID}" tabindex="-1"${title}${path}>
<div class="col">
${options.content}
</div>
</main>`
}

/**
 * 从整页 HTML 里切出主列（htmx 局部刷新的响应体）。
 *
 * 用 `lastIndexOf('</main>')` 而不是第一个：页面的**正文**里理论上可能出现
 * `</main>` 字符串（例如文档页贴了一段 HTML），而外壳自己输出的那个一定在最后。
 * 切不到就返回 `undefined`，调用方据此退回整页——宁可多传字节，也不回半截 HTML。
 */
export function extractMainColumn(html: string): string | undefined {
  const start = html.indexOf(MAIN_COLUMN_OPEN)
  if (start < 0) return undefined
  const end = html.lastIndexOf('</main>')
  if (end < start) return undefined
  return html.slice(start, end + '</main>'.length)
}
