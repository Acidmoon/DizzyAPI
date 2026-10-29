/**
 * API 文档的**内容源与渲染器**。
 *
 * 内容不再是硬编码的 TS 常量，而是仓库里的真 markdown 文件：`docs/api/*.md`
 * （按 `DOC_FILES` 的固定顺序拼成一整页）。本文件只做三件事：
 *
 * 1. **加载**：把 `docs/api/*.md` 读成一段 markdown（`apiDocsMarkdown()`）；
 * 2. **渲染**：用 markdown-it（`html: false`，内嵌 HTML 当纯文本，天然防 XSS）
 *    渲染成 HTML，并把表格 / 标题 / 代码映射到页面模板已有的 class
 *    （**不写内联样式**：CSP 是 `style-src 'self'`，内联样式会被浏览器静默丢弃）；
 * 3. **解析**：从同一份 markdown 里把结构化事实（入口表、错误码表、错误体形状、
 *    流式终止符、示例、有损面）解析出来，供 `pages-docs.test.ts` 与代码事实对照。
 *
 * **自证机制**：文档不再从 TS 常量里读事实，而是由 `parseApiDocsFacts()` 直接从
 * `.md` 里解析；测试拿解析结果去核对「错误码真的存在」「入口覆盖全部注册」
 * 「协议名在 contracts 里」——断言对象换了，断言强度不变。
 *
 * 渲染器是 markdown-it 14.1.0（MIT），以单文件形式 vendor 在
 * `src/vendor/markdown-it/`（带 LICENSE）。**故意不用 npm 依赖**：服务器部署走
 * `pnpm install --offline` 复用已有 store，新增依赖会让部署断掉。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 内容文件（顺序 = 页面顺序 = 拼出来的整页 markdown 顺序）。 */
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

/** 一个 LLM 入口。 */
export interface ApiEntry {
  readonly method: string
  readonly path: string
  /** 客户端协议（决定请求 / 响应形状与错误体形状）；空串 = 不分协议。 */
  readonly protocol: string
  readonly protocolLabel: string
  readonly summary: string
  /** 请求体要点。 */
  readonly request: readonly string[]
  /** 响应体要点。 */
  readonly response: readonly string[]
}

/** 一条错误码事实。 */
export interface ApiErrorDoc {
  readonly code: string
  readonly status: number
  readonly meaning: string
  /** 出处（源码位置），给人看，也用来核对「文档不是凭记忆写的」。 */
  readonly source: string
}

/** 错误体形状：**按客户端协议不同**。 */
export interface ApiErrorShape {
  /** 适用协议（`''` = 默认 / OpenAI 形状）。 */
  readonly protocols: readonly string[]
  readonly shape: string
  /** 错误体里出现的键（用来和源码核对，防止文档凭空写字段）。 */
  readonly keys: readonly string[]
  readonly note: string
}

/** 流式差异（三条入口各不同，最容易踩坑的地方）。 */
export interface StreamNote {
  readonly protocol: string
  readonly note: string
}

// ───────────────────────────── markdown-it 装载 ─────────────────────────────

interface MdToken {
  readonly type: string
  readonly tag: string
  readonly content: string
  readonly info: string
  readonly level: number
}

interface MdInstance {
  render(source: string): string
  parse(source: string): MdToken[]
  readonly utils: { escapeHtml(value: string): string }
  readonly renderer: {
    readonly rules: Record<string, (tokens: MdToken[], index: number) => string>
  }
}

type MdConstructor = new (options?: {
  readonly html?: boolean
  readonly linkify?: boolean
  readonly typographer?: boolean
  readonly breaks?: boolean
}) => MdInstance

const require = createRequire(import.meta.url)
/** vendor 的 UMD 单文件：`require()` 拿到构造函数本身。 */
const MarkdownIt = require('../vendor/markdown-it/markdown-it.js') as MdConstructor

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
  // 行内代码 / 代码块 → `.mono` / `.code`（模板里已有 `.mono`；`.code` 待设计线补样式，
  // 现状与本页改动前一致：改动前同样只有 class 没有 CSS，内联样式被 CSP 丢弃）。
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
/** 事实解析用另一个实例：不覆盖渲染规则，只走 `parse()`。 */
const PARSER = createRenderer()

// ───────────────────────────── 加载 markdown ─────────────────────────────

/**
 * 读入全部内容文件（按 `DOC_FILES` 顺序）。
 *
 * **故意不缓存**：四个文件一共十几 KB，一次整页渲染读一遍可以忽略；缓存会让「改了 `.md`
 * 页面没变」这种问题变得难查（`pnpm dev` 下 HMR 只换模块、不换进程）。
 *
 * **故意不在模块顶层读**：读不到时只让这一页报错，**不要**在 import 阶段抛——
 * `pages/index.ts` 会把所有页面 import 进来，模块顶层抛错会连带整个 web 插件装载失败、
 * 整站不可用。文档缺失是内容问题，不该变成全站故障。
 */
function loadParts(): readonly string[] {
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

/** 整页 markdown（`?base=` 只替换示例里的域名）。 */
export function apiDocsMarkdown(rawBase?: string | null): string {
  const base = sanitizeBase(rawBase)
  const markdown = loadParts().join('\n')
  if (base === DEFAULT_BASE) return markdown
  return markdown.replaceAll(DEFAULT_BASE, base)
}

// ───────────────────────────── 渲染 ─────────────────────────────

/**
 * 渲染任意 markdown 成 HTML（页面与 `/console/api-docs.md` 共用同一个渲染器）。
 *
 * 认 `html: false`：内嵌 HTML 一律当纯文本输出，所以 `<script>` 不会变成真标签。
 */
export function renderMarkdown(source: string): string {
  return RENDERER.render(source)
}

/**
 * 渲染整页文档成 HTML。
 *
 * `options.stripTitle`：页面已经有 `pageHeader` 标题，丢掉 markdown 的首个一级标题，
 * 避免同一个标题出现两次（`.md` 副本里仍然保留）。
 */
export function renderApiDocsHtml(options: { readonly base?: string | null; readonly stripTitle?: boolean } = {}): string {
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
  return `# DizzyAPI

> 自托管的模型网关：OpenAI Chat / OpenAI Responses / Anthropic Messages / Gemini 四协议入口，
> Go 负责转发、计费与用量，cordis 负责插件启用。LLM 入口统一用 \`Authorization: Bearer <API key>\`。

- [API 文档（纯 Markdown）](${base}/console/api-docs.md)：入口一览、认证、错误体形状、错误码、流式终止符、最小示例
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

// ───────────────────────────── 事实解析（自证） ─────────────────────────────

type DocBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly text: string }
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'bullets'; readonly items: readonly string[] }
  | { readonly kind: 'table'; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'fence'; readonly info: string; readonly content: string }

/** 去掉 markdown 的行内标记（反引号），拿到用于核对的纯文本。 */
function plain(value: string): string {
  return value.replaceAll('`', '').trim()
}

/** 把 markdown-it 的 token 流压成少量块（标题 / 段落 / 列表 / 表格 / 代码块）。 */
function toBlocks(markdown: string): DocBlock[] {
  const tokens = PARSER.parse(markdown)
  const blocks: DocBlock[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token.type === 'heading_open') {
      blocks.push({ kind: 'heading', level: Number(token.tag.slice(1)), text: plain(tokens[index + 1]?.content ?? '') })
      index += 3
      continue
    }
    if (token.type === 'paragraph_open') {
      blocks.push({ kind: 'paragraph', text: plain(tokens[index + 1]?.content ?? '') })
      index += 3
      continue
    }
    if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const isBullet = token.type === 'bullet_list_open'
      const items: string[] = []
      let depth = 0
      index += 1
      while (index < tokens.length) {
        const current = tokens[index]
        if (current.type === 'bullet_list_open' || current.type === 'ordered_list_open') depth += 1
        else if (current.type === 'bullet_list_close' || current.type === 'ordered_list_close') {
          if (depth === 0) {
            index += 1
            break
          }
          depth -= 1
        } else if (current.type === 'inline' && depth === 0) items.push(plain(current.content))
        index += 1
      }
      blocks.push({ kind: 'bullets', items })
      if (!isBullet) {
        // 有序列表与无序列表在事实层面没有差别，这里只是显式吞掉分支。
      }
      continue
    }
    if (token.type === 'table_open') {
      const rows: string[][] = []
      let row: string[] | undefined
      let cell = ''
      index += 1
      while (index < tokens.length && tokens[index].type !== 'table_close') {
        const current = tokens[index]
        if (current.type === 'tr_open') {
          row = []
          cell = ''
        } else if (current.type === 'inline') {
          cell = plain(current.content)
        } else if (current.type === 'th_close' || current.type === 'td_close') {
          row?.push(cell)
          cell = ''
        } else if (current.type === 'tr_close') {
          if (row !== undefined) rows.push(row)
          row = undefined
        }
        index += 1
      }
      index += 1
      blocks.push({ kind: 'table', rows })
      continue
    }
    if (token.type === 'fence') {
      blocks.push({ kind: 'fence', info: token.info.trim(), content: token.content })
      index += 1
      continue
    }
    index += 1
  }
  return blocks
}

/** 按二级标题分组（每个二级标题下的块，直到下一个二级标题）。 */
function groupByH2(blocks: readonly DocBlock[]): Map<string, DocBlock[]> {
  const groups = new Map<string, DocBlock[]>()
  let current = ''
  for (const block of blocks) {
    if (block.kind === 'heading' && block.level <= 2) {
      current = block.text
      if (!groups.has(current)) groups.set(current, [])
      continue
    }
    const bucket = groups.get(current)
    if (bucket === undefined) groups.set(current, [block])
    else bucket.push(block)
  }
  return groups
}

/** 取某个标题下的第一张表（没找到就明确失败，不静默给空）。 */
function firstTable(blocks: readonly DocBlock[] | undefined, heading: string): readonly (readonly string[])[] {
  const table = blocks?.find((block) => block.kind === 'table')
  if (table === undefined || table.kind !== 'table') throw new Error(`文档结构变了：\`${heading}\` 下找不到表格`)
  return table.rows
}

/** 取某个标题下的列表项。 */
function bulletsUnder(blocks: readonly DocBlock[] | undefined, heading: string): readonly string[] {
  const list = blocks?.find((block) => block.kind === 'bullets')
  if (list === undefined || list.kind !== 'bullets') throw new Error(`文档结构变了：\`${heading}\` 下找不到列表`)
  return list.items
}

export interface ApiDocsFacts {
  readonly entries: readonly ApiEntry[]
  readonly gatewayErrors: readonly ApiErrorDoc[]
  readonly productErrors: readonly ApiErrorDoc[]
  readonly errorShapes: readonly ApiErrorShape[]
  readonly streamNotes: readonly StreamNote[]
  readonly curlExamples: readonly { readonly title: string; readonly command: string }[]
  readonly lossyNotes: readonly string[]
}

/** 从 `docs/api/*.md` 解析出全部结构化事实（**自证机制的入口**）。 */
export function parseApiDocsFacts(rawBase?: string | null): ApiDocsFacts {
  const blocks = toBlocks(apiDocsMarkdown(rawBase))
  const groups = groupByH2(blocks)

  const overviewKey = [...groups.keys()].find((key) => key.startsWith('入口一览'))
  if (overviewKey === undefined) throw new Error('文档结构变了：找不到「入口一览」')
  const entryRows = firstTable(groups.get(overviewKey), overviewKey).slice(1)

  const detailKey = [...groups.keys()].find((key) => key.startsWith('入口详情'))
  const details = new Map<string, { request: string[]; response: string[] }>()
  if (detailKey !== undefined) {
    let current = ''
    let mode: 'none' | 'request' | 'response' = 'none'
    for (const block of groups.get(detailKey) ?? []) {
      if (block.kind === 'heading' && block.level === 3) {
        current = block.text.replace(/\s+/g, ' ').trim()
        details.set(current, { request: [], response: [] })
        mode = 'none'
        continue
      }
      if (block.kind === 'paragraph') {
        if (block.text.includes('请求')) mode = 'request'
        else if (block.text.includes('响应')) mode = 'response'
        continue
      }
      if (block.kind === 'bullets' && current !== '' && mode !== 'none') {
        const bucket = details.get(current)
        if (bucket !== undefined) bucket[mode].push(...block.items)
      }
    }
  }

  const entries = entryRows.map((row) => {
    const method = row[0] ?? ''
    const entryPath = row[1] ?? ''
    const protocol = row[2] ?? ''
    const label = row[3] ?? ''
    const summary = row[4] ?? ''
    const detail = details.get(`${method} ${entryPath}`)
    if (detail === undefined) throw new Error(`文档结构变了：入口 ${method} ${entryPath} 缺少「入口详情」小节`)
    if (detail.request.length === 0 || detail.response.length === 0) {
      throw new Error(`文档结构变了：入口 ${method} ${entryPath} 的请求 / 响应要点为空`)
    }
    return {
      method,
      path: entryPath,
      protocol,
      protocolLabel: label,
      summary,
      request: detail.request,
      response: detail.response,
    }
  })

  const errorKey = [...groups.keys()].find((key) => key.startsWith('错误码（LLM 入口'))
  if (errorKey === undefined) throw new Error('文档结构变了：找不到「错误码（LLM 入口）」')
  const productKey = [...groups.keys()].find((key) => key.startsWith('错误码（产品接口'))
  if (productKey === undefined) throw new Error('文档结构变了：找不到「错误码（产品接口」')

  const errorsOf = (rows: readonly (readonly string[])[]): ApiErrorDoc[] =>
    rows.slice(1).map((row) => ({
      code: row[0] ?? '',
      status: Number(row[1] ?? ''),
      meaning: row[2] ?? '',
      source: row[3] ?? '',
    }))

  const shapeKey = [...groups.keys()].find((key) => key.startsWith('错误体形状'))
  if (shapeKey === undefined) throw new Error('文档结构变了：找不到「错误体形状」')
  const errorShapes = firstTable(groups.get(shapeKey), shapeKey)
    .slice(1)
    .map((row) => ({
      protocols: (row[0] ?? '')
        .split('/')
        .map((item) => (item.trim() === '默认' ? '' : item.trim())),
      shape: row[1] ?? '',
      keys: (row[2] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== ''),
      note: row[3] ?? '',
    }))

  const streamKey = [...groups.keys()].find((key) => key.startsWith('流式终止符'))
  if (streamKey === undefined) throw new Error('文档结构变了：找不到「流式终止符」')
  const streamNotes = firstTable(groups.get(streamKey), streamKey)
    .slice(1)
    .map((row) => ({ protocol: row[0] ?? '', note: row[1] ?? '' }))

  const lossyKey = [...groups.keys()].find((key) => key.startsWith('有损转换'))
  if (lossyKey === undefined) throw new Error('文档结构变了：找不到「有损转换」')
  const lossyNotes = bulletsUnder(groups.get(lossyKey), lossyKey)

  const exampleKey = [...groups.keys()].find((key) => key.startsWith('最小示例'))
  const curlExamples: { title: string; command: string }[] = []
  if (exampleKey !== undefined) {
    let title = ''
    for (const block of groups.get(exampleKey) ?? []) {
      if (block.kind === 'heading' && block.level === 3) title = block.text
      else if (block.kind === 'fence' && title !== '') curlExamples.push({ title, command: block.content })
    }
  }

  return {
    entries,
    gatewayErrors: errorsOf(firstTable(groups.get(errorKey), errorKey)),
    productErrors: errorsOf(firstTable(groups.get(productKey), productKey)),
    errorShapes,
    streamNotes,
    curlExamples,
    lossyNotes,
  }
}
