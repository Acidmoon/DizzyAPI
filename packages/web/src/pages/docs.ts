/**
 * 文档站页面（`/console/docs`）：**DeepSeek 文档站形态的独立页**，不覆盖旧的
 * `/console/api-docs`（那个页有 `pages-docs-*.test.ts` 逐字钉着，见 AGENTS.md §5.5）。
 *
 * 形态对照 https://api-docs.deepseek.com/zh-cn/ （2026-10-30 实测抓取）：
 *
 * | 参考站 | 本页 |
 * | --- | --- |
 * | 顶部一行分类导航（快速开始 / API 指南 / API 文档 / …） | `.docs-cats`，锚点到本页各分区 |
 * | 左侧固定「本页目录」 | `.docs-toc`（`position: sticky`），窄屏折叠成 `<details>` |
 * | 正文表格 + 可复制代码块 | `.docs-table` / `.docs-code`（整块复制按钮） |
 * | 右上角「复制 Markdown」 | 顶部「复制本页 Markdown」+「下载 .md」 |
 * | 「跳到主要内容」skip link | `<body>` 后第一个可聚焦元素，跳到 `#docs-main` |
 * | 代码块 curl / python / nodejs 切换 | 纯 CSS 单选组（`docs_markdown.ts`），零脚本 |
 *
 * 为什么是**独立页**而不是改造旧页：旧页的断言（入口 / 错误码逐条、类名逐字）是
 * 文档与代码一致性的护栏，改造会把它们一起拖进风险；而 owner 要的是另一种形态。
 * 两者共用同一份 `docs/api/*.md` 与同一套派生事实（`api_facts.ts`），内容不会分叉。
 *
 * **零内联样式 / 零内联脚本**：CSP 是 `style-src 'self'` / `script-src 'self'`。
 * `shell-assets.test.ts` 与 `pages-guards.test.ts` 有护栏。
 */
import { apiDocsMarkdownCopy, DEFAULT_BASE, sanitizeBase } from '../content/api_docs.ts'
import { renderDocsSite } from '../content/docs_site.ts'
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'

/**
 * 往 `<head>` 里插机器可读链接（与旧文档页同一口径，方便 agent 直接抓 markdown）。
 *
 * 为什么是字符串替换：`pageTemplate.renderDocument()` 没有 head 扩展点，而
 * `packages/page-template/**` 不归本线改。这不是权宜之计的特例——旧文档页
 * （`pages/api_docs.ts`）用的是同一个做法，`pages-docs-http.test.ts` 钉着「这两条要在」。
 */
function withHeadLinks(html: string): string {
  const links = [
    `<link rel="alternate" type="text/markdown" href="/console/api-docs.md" title="API 文档（Markdown 源）">`,
    `<link rel="describedby" type="text/plain" href="/llms.txt" title="站点索引（llms.txt）">`,
  ].join('\n')
  return html.replace('</head>', `${links}\n</head>`)
}

/**
 * 插「跳到主要内容」skip link。
 *
 * **必须是 `<body>` 的第一个可聚焦元素**，所以只能在文档级插，不能放在页面内容里
 * （内容在 `<main>` 里，侧栏比它靠前——放内容里就跳不过侧栏了）。
 * 目标 `#docs-main` 带 `tabindex="-1"`，焦点能真正落过去；无脚本时它就是一个普通锚点。
 *
 * 为什么用字符串替换：`renderDocument` 没有 body 前置扩展点，而
 * `packages/page-template/**` 不归本线改（见文件头的说明）。
 */
function withSkipLink(html: string): string {
  return html.replace(
    '<body>',
    '<body>\n<a class="skip-link" href="#docs-main">跳到主要内容</a>',
  )
}

export const docsPage: PageModule = {
  path: '/console/docs',
  area: 'console',
  title: 'API 文档',
  auth: true,

  async render(ctx) {
    const rawBase = ctx.query.get('base')
    const base = sanitizeBase(rawBase)
    // 复制按钮与下载链接指向的那份 markdown（与 `/console/api-docs.md` 逐字相同）。
    const markdown = apiDocsMarkdownCopy(base)

    const html = renderConsoleShell(
      ctx,
      [
        pageHeader(
          ctx,
          'API 文档',
          `网关兼容 OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四种客户端协议；` +
            `按入口路径决定协议，按账号声明的上游协议自动转换。示例站点地址：${base}`,
        ),
        renderDocsSite(markdown, rawBase),
      ].join('\n'),
    )
    return withSkipLink(withHeadLinks(html))
  },
}

/** 页面默认示例域名（供测试断言「默认走生产入口」用）。 */
export const DOCS_DEFAULT_BASE = DEFAULT_BASE
