/**
 * API 文档页（用户站）：内容全部来自 `docs/api/*.md`（真 markdown 源），
 * 这一页只负责「渲染 + 机器友好副本的入口」。
 *
 * 三件套（业界做法，见方案 §1.4）：
 * 1. 内容源是真 `.md` 文件，服务端用 markdown-it 渲染成 HTML（`html: false`）；
 * 2. 机器友好副本：`/console/api-docs.md`（纯 markdown）与 `/llms.txt`（站点索引），
 *    HTML 里用 `<link rel="alternate" type="text/markdown">` 与 `rel="describedby"` 指向它们；
 * 3. 页面上「复制整页 Markdown」按钮复制的是那份 `.md`，方便直接投喂给 agent。
 *
 * **自证**：内容与代码的一致性由 `packages/web/test/pages-docs.test.ts` 守着——它从
 * `.md` 源解析事实，再核对「错误码真的存在」「入口覆盖全部注册」等（断言强度与改动前一致）。
 */
import {
  apiDocsMarkdownCopy,
  DEFAULT_BASE,
  renderApiDocsHtml,
} from '../content/api_docs.ts'
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'

/**
 * 往 `<head>` 里插两条机器可读链接。
 *
 * 为什么是字符串替换：`pageTemplate.renderDocument()` 目前没有 head 扩展点，而
 * `packages/page-template/**` 在本批归设计线独占。等它加了 `head` 选项后，这里换成
 * 参数即可（`pages-docs.test.ts` 有用例守着这两条链接必须在，换实现不会丢断言）。
 */
function withHeadLinks(html: string, base: string): string {
  const links = [
    `<link rel="alternate" type="text/markdown" href="/console/api-docs.md" title="API 文档（Markdown 源）">`,
    `<link rel="describedby" type="text/plain" href="/llms.txt" title="站点索引（llms.txt）">`,
  ].join('\n')
  return html.replace('</head>', `${links}\n</head>`)
}

export const apiDocsPage: PageModule = {
  path: '/console/api-docs',
  area: 'console',
  title: 'API 文档',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const base = ctx.query.get('base')?.trim() || DEFAULT_BASE
    const markdown = apiDocsMarkdownCopy(base)

    const copyRow = [
      `<div class="actions">`,
      `<button class="btn" type="button" data-copy="${t.escapeAttr(markdown)}">复制整页 Markdown</button>`,
      `<a class="btn ghost" href="/console/api-docs.md">打开 .md 副本</a>`,
      `<a class="btn ghost" href="/llms.txt">llms.txt</a>`,
      `</div>`,
    ].join('')

    const html = renderConsoleShell(
      ctx,
      [
        pageHeader(
          ctx,
          'API 文档',
          '网关兼容 OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四种客户端协议；' +
            '按入口路径决定协议，按账号声明的上游协议自动转换。',
        ),
        t.renderNotice({
          kind: 'info',
          text:
            '认证统一用 Authorization: Bearer <你的 API key>（在「API keys」页创建）。' +
            'key 只在创建时显示一次，丢了就轮换。整页 markdown 副本在 /console/api-docs.md，可直接喂给 agent。',
        }),
        copyRow,
        renderApiDocsHtml({ base, stripTitle: true }),
      ].join('\n'),
    )
    return withHeadLinks(html, base)
  },
}
