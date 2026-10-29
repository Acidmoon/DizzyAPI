/**
 * API 文档的**内容装配与渲染**。
 *
 * 分工（这条分界是 owner 要求的核心）：
 *
 * - **叙述**（认证、模型与价格、每个入口的请求/响应要点、错误体形状、流式差异、示例、
 *   有损面）写在 `docs/api/*.md` 里——这些是**人写的文字**。
 * - **事实性清单**（入口表、错误码表、协议名）**不写在 markdown 里**：由 `api_facts.ts`
 *   在渲染时从代码实时读出来，再替换掉 markdown 里的占位符注释
 *   （`<!-- facts:entries -->` / `<!-- facts:gateway-errors -->` / `<!-- facts:product-errors -->`）。
 *
 * 为什么要这样分：把清单手写进 md，代码加一个入口文档不会自动知道，测试只能红成
 * 「文档没更新」而不是「代码有问题」——文档就成了会腐烂的副本。现在清单是派生的，
 * 代码变了页面自动跟上，markdown 只负责讲人话。
 *
 * 渲染器是 markdown-it 14.1.0（MIT，`html: false` 防 XSS），以 vendor 单文件放在
 * `src/vendor/markdown-it.min.cjs` + 手写 `markdown-it.min.d.cts`。**故意不用 npm 依赖**：
 * 服务器部署走 `pnpm install --offline` 复用已有 store，新增依赖会让线上部署断掉。
 *
 * 为什么扩展名是 `.cjs`：仓库根 `package.json` 有 `"type": "module"`，`.js` 会被当 ESM 解析，
 * 这个 UMD 单文件在 ESM 语境下 `require()` 只能拿到空对象（见 `.d.cts` 顶部说明）。
 */
import { readFileSync } from 'node:fs'
import MarkdownIt from '../vendor/markdown-it.min.cjs'
import { readCodeFacts, type ErrorFact } from './api_facts.ts'

/** 内容文件（顺序 = 页面顺序）。 */
export const DOC_FILES: readonly string[] = [
  '01-overview.md',
  '02-endpoints.md',
  '03-errors.md',
  '04-examples.md',
]

/** 文档目录（仓库根 `docs/api/`）。从本文件 `packages/web/src/content/` 往上四级。 */
export const DOCS_DIR = new URL('../../../../docs/api/', import.meta.url)

/** 默认站点地址（示例里出现，页面可用 `?base=` 覆盖）。 */
export const DEFAULT_BASE = 'https://<站点域名>'

/** 占位符：事实表插在这里（一段 HTML 注释，渲染前会被替换掉）。 */
export const FACT_PLACEHOLDERS = {
  entries: '<!-- facts:entries -->',
  gatewayErrors: '<!-- facts:gateway-errors -->',
  productErrors: '<!-- facts:product-errors -->',
} as const

// ───────────────────────────── markdown-it 装载 ─────────────────────────────

/** 渲染器实例类型（声明来自 vendor 的 `.d.cts`）。 */
type MdInstance = InstanceType<typeof MarkdownIt>

/** 新建渲染器：`html: false`（防 XSS）+ 把结构映射到模板已有 class。 */
function createRenderer(): MdInstance {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false })
  const escape = (value: string): string => md.utils.escapeHtml(value)

  // 表格 → `.panel` + `.table`（模板里已有的样式）。
  md.renderer.rules.table_open = () => '<div class="panel"><table class="table">'
  md.renderer.rules.table_close = () => '</table></div>'
  // 标题 → `.page-title` / `.section-title`（模板里已有的样式）。
  md.renderer.rules.heading_open = (tokens, index) => {
    const token = tokens[index]
    const level = Number(token.tag.slice(1))
    const cls = level <= 1 ? 'page-title' : 'section-title'
    return `<${token.tag} class="${cls}">`
  }
  md.renderer.rules.heading_close = (tokens, index) => `</${tokens[index].tag}>`
  // 行内代码 / 代码块 → `.mono` / `.code`（不写内联样式：CSP 是 style-src 'self'）。
  md.renderer.rules.code_inline = (tokens, index) =>
    `<code class="mono">${escape(tokens[index].content)}</code>`
  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index]
    const lang = token.info.trim().split(/\s+/)[0] ?? ''
    const cls = lang === '' ? 'code mono' : `code mono lang-${escape(lang)}`
    return `<pre class="${cls}"><code>${escape(token.content)}</code></pre>\n`
  }
  return md
}

const RENDERER = createRenderer()

// ───────────────────────────── 加载叙述 ─────────────────────────────

/**
 * 读入全部叙述文件（按 `DOC_FILES` 顺序）。
 *
 * **故意不缓存**：四个文件十几 KB，一次整页渲染读一遍可以忽略；缓存会让「改了 `.md`
 * 页面没变」变得难查。
 *
 * **故意不在模块顶层读**：读不到时只让这一页报错，**不要**在 import 阶段抛——
 * `pages/index.ts` 会把所有页面 import 进来，模块顶层抛错会连带整个 web 插件装载失败。
 */
function loadNarrative(): readonly string[] {
  return DOC_FILES.map((name) => {
    try {
      return readFileSync(new URL(name, DOCS_DIR), 'utf8')
    } catch (error) {
      throw new Error(
        `API 文档源缺失或不可读：docs/api/${name}（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  })
}

/** `base` 只允许协议 + 主机 + 路径的安全字符，避免拼进 markdown 时破坏围栏 / 注入。 */
function sanitizeBase(raw: string | null | undefined): string {
  const value = (raw ?? '').trim()
  if (value === '') return DEFAULT_BASE
  return /^https?:\/\/[A-Za-z0-9.\-~_:/]+$/.test(value) ? value : DEFAULT_BASE
}

// ───────────────────────────── 事实表（markdown 片段） ─────────────────────────────

/** 单个单元格转义：`|` 会破坏表格，反引号会破坏行内代码。 */
function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function codeCell(value: string): string {
  return value === '' ? '—' : `\`${cell(value).replaceAll('`', "'")}\``
}

/** 入口表：全派生。 */
function entriesTable(): string {
  const { entries } = readCodeFacts()
  const rows = entries.map((entry) => {
    const protocol =
      entry.protocol === ''
        ? '不分协议'
        : `${codeCell(entry.protocol)}${entry.protocol === '' ? '' : `（\`${entry.protocolConst}\`）`}`
    return `| ${codeCell(entry.method)} | ${codeCell(entry.path)} | ${protocol} |`
  })
  return ['| 方法 | 路径 | 协议 |', '| --- | --- | --- |', ...rows].join('\n')
}

/** 错误码表：码 / 状态 / 说明 / 出处，除「说明」外全部派生。 */
function errorTable(facts: readonly ErrorFact[], kind: 'gateway' | 'product'): string {
  const rows = facts.map((fact) => {
    // Go 侧能从代码里读到人话说明；TS 侧的消息是运行时拼的，只能给码本身。
    const meaning = fact.message === '' ? '—' : fact.message
    return `| ${codeCell(fact.code)} | ${fact.status} | ${cell(meaning)} | \`${cell(fact.source)}\` |`
  })
  const header =
    kind === 'gateway'
      ? '| code | HTTP | 说明（来自代码） | 出处 |'
      : '| code | HTTP | 说明 | 出处 |'
  return [header, '| --- | --- | --- | --- |', ...rows].join('\n')
}

/** 把占位符换成派生出来的事实表；占位符必须**各出现一次**，否则明确失败。 */
function assemble(): string {
  const narrative = loadNarrative().join('\n')
  const facts = readCodeFacts()
  const replacements: { readonly marker: string; readonly table: string; readonly name: string }[] = [
    { marker: FACT_PLACEHOLDERS.entries, table: entriesTable(), name: 'entries' },
    { marker: FACT_PLACEHOLDERS.gatewayErrors, table: errorTable(facts.gatewayErrors, 'gateway'), name: 'gateway-errors' },
    { marker: FACT_PLACEHOLDERS.productErrors, table: errorTable(facts.productErrors, 'product'), name: 'product-errors' },
  ]
  let markdown = narrative
  for (const { marker, table, name } of replacements) {
    const occurrences = markdown.split(marker).length - 1
    if (occurrences !== 1) {
      throw new Error(`docs/api/*.md 里占位符 ${marker} 应该出现且只出现一次（实际 ${occurrences} 次）`)
    }
    markdown = markdown.replace(marker, table)
    // 自检：替换后不该还残留占位符名。
    if (markdown.includes(`facts:${name}`) && !markdown.includes(table)) {
      throw new Error(`占位符 ${marker} 替换失败`)
    }
  }
  return markdown
}

// ───────────────────────────── 对外 ─────────────────────────────

/** 整页 markdown（叙述 + 派生事实表；`?base=` 只替换示例里的域名）。 */
export function apiDocsMarkdown(rawBase?: string | null): string {
  const base = sanitizeBase(rawBase)
  const markdown = assemble()
  if (base === DEFAULT_BASE) return markdown
  return markdown.replaceAll(DEFAULT_BASE, base)
}

/**
 * 渲染任意 markdown 成 HTML（`html: false`：内嵌 HTML 一律当纯文本，所以 `<script>`
 * 不会变成真标签）。
 */
export function renderMarkdown(source: string): string {
  return RENDERER.render(source)
}

/**
 * 渲染整页文档成 HTML。
 *
 * `options.stripTitle`：页面已经有 `pageHeader` 标题，丢掉 markdown 的首个一级标题。
 */
export function renderApiDocsHtml(
  options: { readonly base?: string | null; readonly stripTitle?: boolean } = {},
): string {
  let markdown = apiDocsMarkdown(options.base)
  if (options.stripTitle === true) markdown = markdown.replace(/^# .*\r?\n/, '')
  return renderMarkdown(markdown)
}

/** `/console/api-docs.md` 的纯 markdown 副本（给 agent 直接抓）。 */
export function apiDocsMarkdownCopy(rawBase?: string | null): string {
  return `${apiDocsMarkdown(rawBase)}\n`
}

/** `/llms.txt`：站点索引（llms.txt v2），告诉 agent 有哪些文档、去哪拿干净的 markdown。 */
export function renderLlmsTxt(rawBase?: string | null): string {
  const base = sanitizeBase(rawBase)
  const facts = readCodeFacts()
  return `# DizzyAPI

> 自托管的模型网关：OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四协议入口，
> Go 负责转发、计费与用量，cordis 负责插件启用。LLM 入口统一用 \`Authorization: Bearer <API key>\`。

- [API 文档（纯 Markdown）](${base}/console/api-docs.md)：入口一览（${facts.entries.length} 个）、认证、错误体形状、错误码（LLM ${facts.gatewayErrors.length} 个 / 产品 ${facts.productErrors.length} 个）、流式终止符、最小示例
- [API 文档（网页）](${base}/console/api-docs)：同一份内容的服务端渲染版本
- [模型广场](${base}/console/models)：对外模型名、四档单价与可用性

## Optional

- [健康检查](${base}/healthz)：网关存活探针（不分协议、不鉴权）
`
}

// ───────────────────────────── 资源路由 ─────────────────────────────

export interface DocResource {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

/**
 * 两个**机器友好副本**的路由。
 *
 * 只做「路径 → 字节」的纯判定，真正的 HTTP 接线在 web 插件（`/llms.txt` 与
 * `/console/api-docs.md` 不是 `/api/*`，nginx 会把它们反代到 web 的 7792）。
 */
export function apiDocsResource(pathname: string, rawBase?: string | null): DocResource | null {
  if (pathname === '/llms.txt') {
    return { status: 200, contentType: 'text/plain; charset=utf-8', body: renderLlmsTxt(rawBase) }
  }
  if (pathname === '/console/api-docs.md') {
    return { status: 200, contentType: 'text/markdown; charset=utf-8', body: apiDocsMarkdownCopy(rawBase) }
  }
  return null
}
