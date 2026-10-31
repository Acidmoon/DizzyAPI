/**
 * 极简 Markdown → **块模型**（纯函数，不碰 React / DOM）。
 *
 * 为什么自己写而不引库：新前端是静态导出（`output: 'export'`），文档源是仓库里的
 * `docs/api/*.md`；引一个 markdown 库会多一份运行时依赖与一次 CSP 风险，
 * 而这些文档只用到一个很小的语法子集（标题 / 段落 / 列表 / 围栏代码 / 表格 / 行内代码）。
 *
 * 为什么返回「块模型」而不是 HTML 字符串：页面用 React 组件渲染，**不经过
 * `dangerouslySetInnerHTML`**——文档里将来出现 `<script>` 之类也不会变成注入面。
 *
 * 支持的子集（超出子集的写法按普通段落呈现，不吞内容）：
 * - `#` / `##` / `###` 标题；
 * - `-` / `*` 无序列表、`1.` 有序列表（**不支持嵌套**，缩进按同一级处理）；
 * - ``` 围栏代码块（带语言标记）；
 * - `|` 表格（第二行是 `---` 分隔）；
 * - `>` 引用块；
 * - `---` 分隔线；
 * - 行内：`**粗体**`、`` `代码` ``、`[文字](链接)`。
 */

export type InlineNode =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'strong'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly href: string }

export type Block =
  | { readonly kind: 'heading'; readonly level: 1 | 2 | 3; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'paragraph'; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly InlineNode[])[] }
  | { readonly kind: 'code'; readonly language: string; readonly code: string }
  | { readonly kind: 'quote'; readonly inlines: readonly InlineNode[] }
  | { readonly kind: 'table'; readonly head: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | { readonly kind: 'divider' }
  /**
   * 旧 SSR 页的「从代码实时派生」占位（`<!-- facts:xxx -->`）。
   *
   * 新前端是**静态导出**，构建期不读 Go / TS 源码，所以这类表格这里只能明确说
   * 「这张表没有生成」，而不是装作文档里没有它。
   */
  | { readonly kind: 'facts'; readonly id: string }

/** 行内解析：`**粗**` / `` `码` `` / `[文字](链接)` 三种，其余按文本。 */
export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buffer = ''
  let index = 0
  const flush = (): void => {
    if (buffer !== '') {
      nodes.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }
  while (index < text.length) {
    const rest = text.slice(index)
    const strong = /^\*\*([^*]+)\*\*/.exec(rest)
    if (strong !== null) {
      flush()
      nodes.push({ kind: 'strong', text: strong[1] as string })
      index += strong[0].length
      continue
    }
    const code = /^`([^`]+)`/.exec(rest)
    if (code !== null) {
      flush()
      nodes.push({ kind: 'code', text: code[1] as string })
      index += code[0].length
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
    if (link !== null) {
      flush()
      nodes.push({ kind: 'link', text: link[1] as string, href: link[2] as string })
      index += link[0].length
      continue
    }
    buffer += text[index] as string
    index += 1
  }
  flush()
  return nodes
}

/** 表格行：`| a | b |` → `['a', 'b']`（首尾空段丢掉）。 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/** 分隔行：`| --- | :--: |` 这种。 */
function isDividerRow(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line.trim())
}

/** 主入口：Markdown 文本 → 块数组。空行分段，围栏代码里的空行不算分段。 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] as string

    if (line.trim() === '') {
      index += 1
      continue
    }

    // 派生占位：`<!-- facts:entries -->`（旧 SSR 页在这里插实时表）。
    const facts = /^<!--\s*facts:([\w-]+)\s*-->$/.exec(line.trim())
    if (facts !== null) {
      blocks.push({ kind: 'facts', id: facts[1] as string })
      index += 1
      continue
    }

    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence !== null) {
      const language = fence[1] ?? ''
      const code: string[] = []
      index += 1
      while (index < lines.length && !/^```\s*$/.test(lines[index] as string)) {
        code.push(lines[index] as string)
        index += 1
      }
      index += 1 // 跳过收尾 ```
      blocks.push({ kind: 'code', language, code: code.join('\n') })
      continue
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      blocks.push({
        kind: 'heading',
        level: (heading[1] as string).length as 1 | 2 | 3,
        inlines: parseInline(heading[2] as string),
      })
      index += 1
      continue
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push({ kind: 'divider' })
      index += 1
      continue
    }

    if (line.startsWith('> ')) {
      const quote: string[] = []
      while (index < lines.length && (lines[index] as string).startsWith('> ')) {
        quote.push((lines[index] as string).slice(2))
        index += 1
      }
      blocks.push({ kind: 'quote', inlines: parseInline(quote.join(' ')) })
      continue
    }

    if (line.trimStart().startsWith('|') && index + 1 < lines.length && isDividerRow(lines[index + 1] as string)) {
      const head = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && (lines[index] as string).trimStart().startsWith('|')) {
        rows.push(splitRow(lines[index] as string))
        index += 1
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null
      const items: InlineNode[][] = []
      while (index < lines.length) {
        const current = lines[index] as string
        const hit = isOrdered ? /^\s*\d+\.\s+(.*)$/.exec(current) : /^\s*[-*]\s+(.*)$/.exec(current)
        if (hit === null) break
        items.push(parseInline(hit[1] as string))
        index += 1
      }
      blocks.push({ kind: 'list', ordered: isOrdered, items })
      continue
    }

    // 普通段落：连续非空行合一段。
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index] as string
      if (current.trim() === '' || /^(#{1,3})\s+/.test(current) || current.startsWith('```')) break
      if (/^\s*[-*]\s+/.test(current) || /^\s*\d+\.\s+/.test(current)) break
      if (current.trimStart().startsWith('|')) break
      paragraph.push(current.trim())
      index += 1
    }
    if (paragraph.length === 0) {
      // 保险：任何未被上面规则吃掉的单行，按段落输出，绝不静默丢内容。
      paragraph.push(line.trim())
      index += 1
    }
    blocks.push({ kind: 'paragraph', inlines: parseInline(paragraph.join(' ')) })
  }

  return blocks
}

/** 行内节点的纯文本（标题锚点 / 目录用）。 */
export function inlineText(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => (node.kind === 'link' ? node.text : node.text)).join('')
}
