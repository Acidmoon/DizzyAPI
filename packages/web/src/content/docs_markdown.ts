/**
 * 文档站（`/console/docs`）的 markdown 渲染器：**表格 + 可切语言 + 可整块复制的代码块**。
 *
 * 为什么与旧的 `renderMarkdown()` 分开：旧文档页是「一整页 markdown 一次渲染完」，
 * 它的类名（`.section-title` / 裸 `<pre class="code mono">`）被
 * `packages/web/test/pages-docs-http.test.ts` 逐字钉着，不能动。文档站要的是
 * 「按文件分节 + 标题锚点 + 代码块带语言标签页」，两者结构不同，各用一份渲染器比在
 * 一个函数里分支干净。
 *
 * 三条硬约束（都来自 owner 与 CSP）：
 * 1. **`html: false`**：内嵌 HTML 一律当纯文本，`<script>` 不会变成真标签（与旧页一致）。
 * 2. **零内联样式 / 零 JS**：CSP 是 `style-src 'self'`。语言切换用**纯 CSS 单选组**
 *    （`input[type=radio]` + `:checked ~`），不引脚本，也没有「无 JS 就坏掉」的分支：
 *    单选组是原生控件，键盘方向键可切。
 * 3. **复制走已有钩子**：按钮带 `data-copy`（`web/src/client-extras.ts` 的 COPY_JS
 *    已经处理），反馈是已有的 `#dizzy-toasts` / `window.dizzyToast`，不另造一套提示。
 */

import { escapeAttr, escapeText } from '@dizzyapi/plugin-page-template'
import MarkdownIt from '../vendor/markdown-it.min.cjs'

/**
 * fence 的 info 字符串 → 标签页文案。
 *
 * `bash` 显示成「curl」：站点里的 shell 示例全是 curl 命令，标签写 bash 反而要多想一步。
 * 未登记的语言原样显示（不猜、不丢）。
 */
const LANG_LABELS: Readonly<Record<string, string>> = {
  bash: 'curl',
  sh: 'curl',
  shell: 'curl',
  curl: 'curl',
  python: 'python',
  py: 'python',
  javascript: 'nodejs',
  js: 'nodejs',
  nodejs: 'nodejs',
  json: 'JSON',
  text: '文本',
}

/** 一个标题（正文里真实渲染出来的那个，带锚点）。 */
export interface DocsHeading {
  readonly id: string
  readonly title: string
  /** 3 = markdown `##`，4 = markdown `###`。 */
  readonly level: 3 | 4
}

/**
 * 一次页面渲染的可变状态。
 *
 * 为什么不用模块级计数器：一页有五份 `.md`，标题锚点必须**跨文件唯一**，
 * 所以 `prefix`（分区 id）与 `anchors`（已用集合）都要在一次渲染内共享。
 */
export interface DocsRenderContext {
  /** radio 的 `name` 序号（同一页内唯一）。 */
  groups: number
  /** 已分配的锚点 id（去重用）。 */
  readonly anchors: Set<string>
  /** 锚点前缀（= 当前分区 id）。逐文件渲染前由调用方改写。 */
  prefix: string
  /** 收集到的标题（按渲染顺序）。 */
  readonly headings: DocsHeading[]
  /** 打开中的标题 id 栈（`heading_open` 压、`heading_close` 弹）。 */
  readonly openIds: string[]
}

/** 新开一次渲染状态。 */
export function newDocsContext(): DocsRenderContext {
  return { groups: 0, anchors: new Set<string>(), prefix: 'docs', headings: [], openIds: [] }
}

/** 语言文案：登记过的走映射，没登记的用语言名本身，空串叫「文本」。 */
function langLabel(lang: string): string {
  if (lang === '') return '文本'
  return LANG_LABELS[lang] ?? lang
}

/**
 * 标题 → 锚点 id。
 *
 * 保留中文（与 DeepSeek 文档站一致：`#接入-agent-工具`），只把空白与标点换成 `-`，
 * 这样锚点既稳定又能在地址栏里读懂。去重由 `uniqueId()` 负责。
 */
export function slugifyHeading(text: string): string {
  const collapsed = text
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    // 标点 / 括号 / 斜杠 / 反引号 / 星号等一律换成连字符（中文标点也在此列）。
    .replace(/[!-/:-@[-`{-~\u3000-\u303f\uff00-\uffef]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return collapsed === '' ? 'section' : collapsed
}

/** 在本次渲染内唯一的 id：重名时追加 `-2`、`-3`（与 Docusaurus 一致的做法）。 */
function uniqueId(context: DocsRenderContext, base: string): string {
  let candidate = base
  let suffix = 2
  while (context.anchors.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  context.anchors.add(candidate)
  return candidate
}

/** 代码块右上角的「复制」按钮（`data-copy` 是已有钩子，值必须是原文）。 */
function copyButton(code: string): string {
  // `docs-copy` 这个类名**必须留着**：CSS 靠 `.docs-code .docs-copy` 把它靠右
  // （多语言时工具栏里只有它一个元素，`space-between` 会把它推到左边）。
  return `<button class="btn small docs-copy" type="button" data-copy="${escapeAttr(code)}">复制</button>`
}

/** 一块代码：`<pre><code>`，内容全部转义（`html: false` 的另一半保证）。 */
function codePane(code: string): string {
  return `<pre class="code mono docs-pre"><code>${escapeText(code)}</code></pre>`
}

/** 一块带语言的代码。 */
interface Fence {
  readonly lang: string
  readonly code: string
}

/**
 * 一组代码块。
 *
 * - 单语言：一条工具栏（语言名 + 复制）+ 代码；
 * - 多语言：radio + 标签页 + 每个面板自带复制按钮。
 *   **复制按钮放在面板里**，所以「复制的是哪一份」永远等于「你现在看的是哪一份」，
 *   不需要脚本去读选中态。
 *
 * 标签页的 CSS 靠 `:nth-of-type` 对齐（见 `docs_site_css.ts`）：radio 是 `input`、
 * 标签容器是 `span`、面板是 `div`，三者标签名互不相同，所以序号不会串。
 * **上限 3 种语言**——`curl / python / nodejs` 正是三种；超出的组退化成单块堆叠，
 * 宁可朴素，也不做出一个切不到的面板。
 */
function codeGroup(fences: readonly Fence[], context: DocsRenderContext): string {
  if (fences.length <= 1) {
    const only = fences[0]
    if (only === undefined) return ''
    return `<div class="docs-code">
<div class="docs-code-bar"><span class="docs-code-lang">${escapeText(langLabel(only.lang))}</span>${copyButton(only.code)}</div>
${codePane(only.code)}
</div>`
  }
  const id = `docs-code-${context.groups}`
  context.groups += 1
  const radios = fences
    .map((_, index) => `<input class="docs-code-radio" type="radio" name="${id}" id="${id}-${index}"${index === 0 ? ' checked' : ''}>`)
    .join('')
  const tabs = fences
    .map((fence, index) => `<label class="docs-code-tab" for="${id}-${index}">${escapeText(langLabel(fence.lang))}</label>`)
    .join('')
  const panes = fences
    .map((fence) => `<div class="docs-code-pane">
<div class="docs-code-bar">${copyButton(fence.code)}</div>
${codePane(fence.code)}
</div>`)
    .join('')
  return `<div class="docs-code">
${radios}<span class="docs-code-tabs">${tabs}</span>
${panes}
</div>`
}

/** markdown 标题级别 → 页面上的 HTML 级别（h1 由页面给，文件里的 `#` 会被剥掉）。 */
const HEADING_MAP: Readonly<Record<number, { tag: string; cls: string; level: 3 | 4 }>> = {
  2: { tag: 'h3', cls: 'docs-h3', level: 3 },
  3: { tag: 'h4', cls: 'docs-h4', level: 4 },
}

/**
 * 文档站渲染器。
 *
 * **一个模块一份实例**：MarkdownIt 的构造（正则编译）不便宜，而规则本身无状态；
 * 「第几组标签页 / 用了哪些锚点」都在 `DocsRenderContext` 里，由调用方逐次给。
 * 渲染是同步的，所以「同一时刻只有一个渲染在跑」，不需要锁。
 */
function createRenderer(): InstanceType<typeof MarkdownIt> {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false })

  md.renderer.rules.table_open = () => '<div class="panel docs-table"><table class="table">'
  md.renderer.rules.table_close = () => '</table></div>'
  md.renderer.rules.code_inline = (tokens, index) =>
    `<code class="mono">${md.utils.escapeHtml(tokens[index].content)}</code>`

  md.renderer.rules.heading_open = (tokens, index) => {
    const mapped = HEADING_MAP[Number(tokens[index].tag.slice(1))]
    if (mapped === undefined) return `<${tokens[index].tag}>`
    const title = tokens[index + 1]?.content ?? ''
    const id = uniqueId(active, `${active.prefix}-${slugifyHeading(title)}`)
    active.openIds.push(id)
    active.headings.push({ id, title: title.trim(), level: mapped.level })
    return `<${mapped.tag} class="${mapped.cls}" id="${escapeAttr(id)}">`
  }

  md.renderer.rules.heading_close = (tokens, index) => {
    const mapped = HEADING_MAP[Number(tokens[index].tag.slice(1))]
    if (mapped === undefined) return `</${tokens[index].tag}>`
    const id = active.openIds.pop() ?? ''
    // 「#」永久链接：视觉上只在悬停 / 聚焦标题时出现，但读屏软件一直能读到 aria-label。
    return `<a class="docs-anchor" href="#${escapeAttr(id)}" aria-label="本节永久链接">#</a></${mapped.tag}>`
  }

  md.renderer.rules.fence = (tokens, index) => {
    // 一组连续围栏只在**第一块**渲染，后面的吞掉（否则会重复输出整组）。
    if (index > 0 && tokens[index - 1].type === 'fence') return ''
    const fences: Fence[] = []
    for (let cursor = index; cursor < tokens.length && tokens[cursor].type === 'fence'; cursor += 1) {
      fences.push({
        lang: tokens[cursor].info.trim().split(/\s+/)[0] ?? '',
        code: tokens[cursor].content,
      })
    }
    if (fences.length > 3) return fences.map((fence) => codeGroup([fence], active)).join('')
    return codeGroup(fences, active)
  }
  return md
}

const RENDERER = createRenderer()

/** 当前渲染的状态（渲染同步，所以模块级一个 `active` 就够）。 */
let active: DocsRenderContext = newDocsContext()

/**
 * 渲染一段 markdown（文档站口径），并把标题锚点收集进 `context`。
 *
 * 调用方**必须**传同一个 `context` 渲染同一页的所有文件：锚点去重与标签页编号
 * 都是跨文件共享的。
 */
export function renderDocsMarkdown(source: string, context: DocsRenderContext): string {
  active = context
  return RENDERER.render(source)
}
