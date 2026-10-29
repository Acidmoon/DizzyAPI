/**
 * API 文档页（用户站）：支持的入口路径、协议形状、认证、错误码表、流式差异与最小示例。
 *
 * 这一页是**静态内容**：不查库、不调服务，只渲染 `src/content/api_docs.ts` 里的
 * 结构化事实。内容与源码的一致性由 `packages/web/test/pages-docs.test.ts` 守着
 * （文档里的每个错误码都必须在源码里真实存在）。
 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import {
  API_ENTRIES,
  CURL_EXAMPLES,
  ERROR_SHAPES,
  GATEWAY_ERRORS,
  LOSSY_NOTES,
  PRODUCT_ERRORS,
  STREAM_NOTES,
  type ApiErrorDoc,
} from '../content/api_docs.ts'

/** 代码块：内容一律转义（错误码表与示例里可能出现 `<` / `&`）。 */
function codeBlock(t: { escapeText(value: string): string }, text: string): string {
  return `<pre class="code code--block"><code>${t.escapeText(text)}</code></pre>`
}

function errorRows(t: { escapeText(value: string): string }, rows: readonly ApiErrorDoc[]): string[][] {
  return rows.map((row) => [
    `<code class="mono">${t.escapeText(row.code)}</code>`,
    t.escapeText(String(row.status)),
    t.escapeText(row.meaning),
  ])
}

export const apiDocsPage: PageModule = {
  path: '/console/api-docs',
  area: 'console',
  title: 'API 文档',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const base = ctx.query.get('base')?.trim() || 'https://<站点域名>'

    const entrySections = API_ENTRIES.map((entry) => {
      const head = [
        t.renderSectionTitle(`${entry.method} ${entry.path}`),
        `<p class="page-note p--tight">${t.escapeText(entry.protocolLabel)}` +
          `${entry.protocol === '' ? '' : ` · <code class="mono">${t.escapeText(entry.protocol)}</code>`}</p>`,
        `<p class="p--tight">${t.escapeText(entry.summary)}</p>`,
        `<p class="p--label"><strong>请求</strong></p>`,
        `<ul class="list--docs-tight">${entry.request
          .map((item) => `<li>${t.escapeText(item)}</li>`)
          .join('')}</ul>`,
        `<p class="p--label"><strong>响应</strong></p>`,
        `<ul class="list--docs">${entry.response
          .map((item) => `<li>${t.escapeText(item)}</li>`)
          .join('')}</ul>`,
      ]
      return head.join('\n')
    })

    const examples = CURL_EXAMPLES.map((example) =>
      [t.renderSectionTitle(example.title), codeBlock(t, example.command.replaceAll('https://<站点域名>', base))].join('\n'),
    )

    return renderConsoleShell(
      ctx,
      [
        pageHeader(
          ctx,
          'API 文档',
          '网关兼容 OpenAI Chat / OpenAI Responses / Anthropic Messages 三种客户端协议；' +
            '按入口路径决定协议，按账号声明的上游协议自动转换。',
        ),
        t.renderNotice({
          kind: 'info',
          text: '认证统一用 Authorization: Bearer <你的 API key>（在「API keys」页创建）。' +
            'key 只在创建时显示一次，丢了就轮换。',
        }),
        t.renderSectionTitle('入口一览'),
        t.renderTable({
          columns: [{ label: '入口' }, { label: '协议' }, { label: '说明' }],
          rows: API_ENTRIES.map((entry) => [
            `<code class="mono">${t.escapeText(`${entry.method} ${entry.path}`)}</code>`,
            t.escapeText(entry.protocolLabel),
            t.escapeText(entry.summary),
          ]),
        }),
        t.renderSectionTitle('认证与会话'),
        `<ul class="list--docs">
<li>所有 LLM 入口与 <code class="mono">GET /v1/models</code> 都要带 <code class="mono">Authorization: Bearer &lt;API key&gt;</code></li>
<li>缺 key 返回 401 <code class="mono">MISSING_API_KEY</code>；key 无效返回 401 <code class="mono">INVALID_API_KEY</code></li>
<li><code class="mono">/api/*</code> 是控制面接口，用登录会话（Cookie），与 LLM 入口的 key 鉴权是两套</li>
</ul>`,
        entrySections.join('\n'),
        t.renderSectionTitle('错误体形状（按客户端协议不同）'),
        t.renderTable({
          columns: [{ label: '适用协议' }, { label: '形状' }, { label: '说明' }],
          rows: ERROR_SHAPES.map((shape) => [
            `<code class="mono">${t.escapeText(
              shape.protocols.map((item) => (item === '' ? '（默认 / OpenAI）' : item)).join(' / '),
            )}</code>`,
            `<code class="mono">${t.escapeText(shape.shape.replaceAll('`', ''))}</code>`,
            t.escapeText(shape.note),
          ]),
        }),
        t.renderSectionTitle('错误码（LLM 入口）'),
        t.renderTable({
          columns: [{ label: 'code' }, { label: 'HTTP', align: 'right' }, { label: '含义' }],
          rows: errorRows(t, GATEWAY_ERRORS),
        }),
        t.renderSectionTitle('错误码（产品接口 /api/*）'),
        t.renderTable({
          columns: [{ label: 'code' }, { label: 'HTTP', align: 'right' }, { label: '含义' }],
          rows: errorRows(t, PRODUCT_ERRORS),
        }),
        t.renderSectionTitle('流式：三种入口的终止符不同'),
        t.renderTable({
          columns: [{ label: '协议' }, { label: '流式终止符' }],
          rows: STREAM_NOTES.map((note) => [
            `<code class="mono">${t.escapeText(note.protocol)}</code>`,
            t.escapeText(note.note),
          ]),
        }),
        t.renderSectionTitle('有损转换'),
        `<ul class="list--docs">${LOSSY_NOTES.map((note) => `<li>${t.escapeText(note)}</li>`).join('')}</ul>`,
        t.renderSectionTitle('最小示例'),
        examples.join('\n'),
        t.renderSectionTitle('模型与价格'),
        t.renderNotice({
          kind: 'info',
          text: '对外模型名、单价与可用性见「模型广场」（/console/models）。' +
            'GET /v1/models 只返回当前可用模型名的并集，不含价格。',
        }),
      ].join('\n'),
    )
  },
}
