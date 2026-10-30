/**
 * 文档站（`/console/docs`）的**内容装配**：分区 → 目录 → 正文 → 页内动作。
 *
 * 内容来源仍是 `docs/api/*.md`（人写的叙述 + 派生的代码事实表），这里一份 `.md`
 * 对应顶部导航的一个分区：
 *
 * | 分区 | 源文件 |
 * | --- | --- |
 * | 快速开始 | `01-overview.md` |
 * | 接口参考 | `02-endpoints.md` |
 * | 错误码 | `03-errors.md` |
 * | 示例 | `04-examples.md` |
 * | 限流计费 | `05-limits-billing.md` |
 *
 * **不复制一份内容**：分区表只写「哪个文件叫什么名」，正文全部来自源文件；新增一份
 * `.md` 只要在 `DOC_SECTIONS` 里登记一行（`pages-docs-site.test.ts` 会钉住
 * 「每个源文件都被某个分区认领」，漏登记直接红）。
 *
 * 三个和旧文档页（`/console/api-docs`）刻意不同的做法：
 * 1. **按文件分节渲染**，不是整页一次渲染——只有这样每个分区才有稳定锚点；
 * 2. **标题带锚点 + `scroll-margin-top`**，跳转后不被吸顶的分类导航盖住；
 * 3. **代码块带语言标签页**（`docs_markdown.ts` 的纯 CSS 单选组）。
 */

import { escapeAttr, escapeText } from '@dizzyapi/plugin-page-template'
import { expandFacts, loadDocSources, sanitizeBase, DEFAULT_BASE } from './api_docs.ts'
import { newDocsContext, renderDocsMarkdown, type DocsHeading } from './docs_markdown.ts'

/** 一个分区：顶部导航的一项 + 一份源文件。 */
export interface DocSectionDef {
  /** 锚点前缀（也用在 h2 的 id 上）。 */
  readonly id: string
  /** 顶部导航文案。 */
  readonly label: string
  /** `docs/api/` 下的文件名。 */
  readonly file: string
}

/**
 * 分区表（顺序 = 顶部导航顺序 = 正文顺序）。
 *
 * 顺序是有讲究的：先「怎么连上」，再「有哪些入口」，然后失败怎么判、怎么写代码，
 * 最后是钱与限流。别按文件名排——文件名只是给人看的。
 */
export const DOC_SECTIONS: readonly DocSectionDef[] = [
  { id: 'docs-quickstart', label: '快速开始', file: '01-overview.md' },
  { id: 'docs-api', label: '接口参考', file: '02-endpoints.md' },
  { id: 'docs-errors', label: '错误码', file: '03-errors.md' },
  { id: 'docs-examples', label: '示例', file: '04-examples.md' },
  { id: 'docs-limits', label: '限流计费', file: '05-limits-billing.md' },
]

/** 渲染好的一个分区。 */
interface RenderedSection extends DocSectionDef {
  /** h2 的 id（= 分区的锚点，TOC 一级项跳这里）。 */
  readonly headingId: string
  /** 分区正文 HTML（h3 / h4 已带锚点）。 */
  readonly html: string
  /** 分区内的二、三级标题（TOC 用）。 */
  readonly headings: readonly DocsHeading[]
}

/** 去掉文件开头的 `# 一级标题`：页面自己给 h1，正文里再来一个就是两个 h1。 */
function stripTopHeading(markdown: string): string {
  return markdown.replace(/^#\s+.*\r?\n/, '')
}

/** 目录里的一项：链接 + 文案 + 层级。 */
function tocLink(id: string, title: string): string {
  return `<a class="docs-toc-link" href="#${escapeAttr(id)}">${escapeText(title)}</a>`
}

/**
 * 本页目录（左侧固定那份与移动端 `<details>` 里那份**同一份内容**，两处都在服务端
 * 渲染：有脚本站得稳、没脚本也是普通锚点列表）。
 *
 * 层级只做两级：分区内的 `##`（→ h3）是一级条目，它下面的 `###`（→ h4）挂在
 * 那个条目的子列表里。跨分区不嵌套——目录是「本页有哪些节」，不是标题树本身。
 */
function renderToc(sections: readonly RenderedSection[]): string {
  const blocks = sections.map((section) => {
    const items: string[] = []
    let open: string[] | undefined
    const flush = (): void => {
      if (open !== undefined) items.push(`<ul class="docs-toc-sub">${open.join('')}</ul></li>`)
      open = undefined
    }
    for (const heading of section.headings) {
      if (heading.level === 3) {
        flush()
        items.push(`<li>${tocLink(heading.id, heading.title)}`)
        open = []
        continue
      }
      const link = `<li>${tocLink(heading.id, heading.title)}</li>`
      if (open === undefined) items.push(link)
      else open.push(link)
    }
    flush()
    const sub = items.length === 0 ? '' : `\n<ul class="docs-toc-sub">\n${items.join('\n')}\n</ul>`
    return `<li class="docs-toc-cat">${tocLink(section.headingId, section.label)}${sub}</li>`
  })
  return `<ul class="docs-toc-list">\n${blocks.join('\n')}\n</ul>`
}

/**
 * 装配五个分区（每个一次 markdown 渲染）。
 *
 * 锚点上下文**一页共用一个**：`anchors` 集合与标签页编号跨文件唯一，否则两个文件里
 * 都有「最小示例」时会撞 id，点目录跳到第一个。
 */
function renderSections(): RenderedSection[] {
  const sources = new Map(loadDocSources().map((source) => [source.name, source.text]))
  const context = newDocsContext()
  return DOC_SECTIONS.map((section) => {
    const source = sources.get(section.file)
    if (source === undefined) {
      throw new Error(`文档站分区 ${section.id} 指向的源文件不存在：docs/api/${section.file}`)
    }
    // 事实占位符逐文件展开：一份文件里可能一个占位符都没有（`allowAll=false`）。
    const markdown = stripTopHeading(expandFacts(source, false))
    const before = context.headings.length
    // 锚点前缀按分区走：`docs-api-入口一览` 这种，跨文件也不会重。
    context.prefix = section.id
    const html = renderDocsMarkdown(markdown, context)
    const headings = context.headings.slice(before)
    const headingId = section.id
    // 分区标题本身也要占一个锚点 id（TOC 一级项跳它）；记进集合避免和后续标题相撞。
    context.anchors.add(headingId)
    return {
      id: section.id,
      label: section.label,
      file: section.file,
      headingId,
      html,
      headings,
    }
  })
}

/** 分区标题（h2）：带锚点 + 永久链接，位置与正文标题同一套外观。 */
function sectionHeading(section: RenderedSection): string {
  return `<h2 class="docs-h2" id="${escapeAttr(section.headingId)}">${escapeText(section.label)}<a class="docs-anchor" href="#${escapeAttr(section.headingId)}" aria-label="本节永久链接">#</a></h2>`
}

/** 顶部一行分类导航（锚点到本页各分区）。 */
function categoryNav(sections: readonly RenderedSection[]): string {
  const links = sections
    .map((section) => `<a class="docs-cat" href="#${escapeAttr(section.headingId)}">${escapeText(section.label)}</a>`)
    .join('\n')
  return `<nav class="docs-cats" aria-label="文档分类">\n${links}\n</nav>`
}

/**
 * 页内动作：复制本页 Markdown + 下载 .md。
 *
 * 两者都只认 `/console/api-docs.md`（web 插件已经发这条纯 markdown 副本）：
 * 复制走已有的 `data-copy` 钩子（轻提示是 `#dizzy-toasts`，不另造），
 * 下载就是一条普通链接 + `download`，零脚本。
 */
function renderActions(markdown: string): string {
  return `<div class="docs-actions">
<button class="btn" type="button" data-copy="${escapeAttr(markdown)}">复制本页 Markdown</button>
<a class="btn ghost" href="/console/api-docs.md" download="dizzyapi-api-docs.md">下载 .md</a>
</div>`
}

/**
 * 文档站正文（`renderConsoleShell` 的 content）。
 *
 * @param markdown 整页 markdown（复制按钮与下载链接都指向它）。
 * @param rawBase `?base=` 覆盖示例域名，与旧文档页同一口径（非法值回落默认，不注入）。
 */
export function renderDocsSite(markdown: string, rawBase?: string | null): string {
  const base = sanitizeBase(rawBase)
  const sections = renderSections()
  // `?base=` 只换示例里的域名：正文里出现的是默认域名，换成用户给的。
  const swapBase = (html: string): string => (base === DEFAULT_BASE ? html : html.split(DEFAULT_BASE).join(base))

  const toc = renderToc(sections)
  const heading = (section: RenderedSection): string => swapBase(sectionHeading(section))
  const body = sections
    .map((section) => `<section class="docs-section" aria-labelledby="${escapeAttr(section.headingId)}">
${heading(section)}
${swapBase(section.html)}
</section>`)
    .join('\n')

  return `<div class="docs-page">
${categoryNav(sections)}
<div class="docs-layout">
<nav class="docs-toc" aria-label="本页目录">
<p class="docs-toc-title">本页目录</p>
${toc}
</nav>
<div class="docs-body" id="docs-main" tabindex="-1">
<details class="docs-toc-mobile">
<summary>本页目录</summary>
${toc}
</details>
${renderActions(markdown)}
${body}
</div>
</div>
</div>`
}

/** 文档站分区表里登记的文件名（测试用来核对「没有漏登记 / 没有指向不存在的文件」）。 */
export const DOC_SECTION_FILES: readonly string[] = DOC_SECTIONS.map((section) => section.file)
