/**
 * `_lib/markdown.ts` 的护栏：文档页的渲染完全依赖这个解析器，它坏了页面会「看起来空」。
 *
 * 断言的都是**块结构**（不是 HTML 字符串），因为页面用 React 组件渲染块，
 * 不经过 `dangerouslySetInnerHTML`——结构对了就没有注入面。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as markdownModule from '../app/src/app/(main)/user/_lib/markdown.ts'
import { unwrap } from './helpers/module-interop.ts'

const { parseMarkdown, parseInline, inlineText } = unwrap<typeof markdownModule>(markdownModule)

describe('parseInline', () => {
  it('粗体 / 行内代码 / 链接', () => {
    const nodes = parseInline('这是**粗体**与 `code` 还有[链接](https://example.com)')
    assert.deepEqual(nodes, [
      { kind: 'text', text: '这是' },
      { kind: 'strong', text: '粗体' },
      { kind: 'text', text: '与 ' },
      { kind: 'code', text: 'code' },
      { kind: 'text', text: ' 还有' },
      { kind: 'link', text: '链接', href: 'https://example.com' },
    ])
  })

  it('纯文本原样返回', () => {
    assert.deepEqual(parseInline('没有任何标记'), [{ kind: 'text', text: '没有任何标记' }])
  })

  it('inlineText 取纯文本（标题 / 目录用）', () => {
    // 节点之间原有的空格**保留**（'a ' + 'b' + ' ' + 'c' → 'a b c'）：
    // 目录与标题要还原成人读的文本，掐掉空格会粘成一个词。
    assert.equal(inlineText(parseInline('a **b** `c`')), 'a b c')
  })
})

describe('parseMarkdown：标题', () => {
  it('三级标题都识别，层级对', () => {
    const blocks = parseMarkdown('# 一级\n\n## 二级\n\n### 三级')
    assert.deepEqual(
      blocks.map((block) => (block.kind === 'heading' ? block.level : null)),
      [1, 2, 3],
    )
  })
})

describe('parseMarkdown：列表', () => {
  it('无序列表按项切分', () => {
    const blocks = parseMarkdown('- 第一\n- 第二\n- 第三')
    assert.equal(blocks.length, 1)
    const list = blocks[0] as { kind: 'list'; ordered: boolean; items: unknown[] }
    assert.equal(list.kind, 'list')
    assert.equal(list.ordered, false)
    assert.equal(list.items.length, 3)
  })

  it('有序列表标记为 ordered', () => {
    const blocks = parseMarkdown('1. 一\n2. 二')
    const list = blocks[0] as { kind: 'list'; ordered: boolean; items: unknown[] }
    assert.equal(list.ordered, true)
    assert.equal(list.items.length, 2)
  })
})

describe('parseMarkdown：围栏代码', () => {
  it('语言标记与正文都被保留，代码里的空行不切段', () => {
    const source = ['```bash', 'curl \\', '  -H "a: b"', '', 'echo done', '```'].join('\n')
    const blocks = parseMarkdown(source)
    assert.equal(blocks.length, 1)
    const code = blocks[0] as { kind: 'code'; language: string; code: string }
    assert.equal(code.kind, 'code')
    assert.equal(code.language, 'bash')
    assert.equal(code.code, ['curl \\', '  -H "a: b"', '', 'echo done'].join('\n'))
  })

  it('代码块之后的段落不会被吞进代码', () => {
    const blocks = parseMarkdown(['```js', 'const a = 1', '```', '', '之后的段落'].join('\n'))
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1]?.kind, 'paragraph')
  })
})

describe('parseMarkdown：表格', () => {
  it('表头 + 分隔行 + 数据行', () => {
    const source = ['| 协议 | 形状 |', '| --- | --- |', '| chat | `{error}` |', '| gemini | `{code}` |'].join('\n')
    const blocks = parseMarkdown(source)
    assert.equal(blocks.length, 1)
    const table = blocks[0] as { kind: 'table'; head: string[]; rows: string[][] }
    assert.equal(table.kind, 'table')
    assert.deepEqual(table.head, ['协议', '形状'])
    assert.deepEqual(table.rows, [
      ['chat', '`{error}`'],
      ['gemini', '`{code}`'],
    ])
  })

  it('没有分隔行就不是表格（按段落处理，不吞内容）', () => {
    const blocks = parseMarkdown('| 只是竖线 | 不是表格 |')
    assert.equal(blocks[0]?.kind, 'paragraph')
  })
})

describe('parseMarkdown：派生占位', () => {
  it('`<!-- facts:xxx -->` 变成 facts 块（不静默丢掉）', () => {
    const blocks = parseMarkdown(['## 入口一览', '', '<!-- facts:entries -->', '', '后面还有正文'].join('\n'))
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['heading', 'facts', 'paragraph'],
    )
    const facts = blocks[1] as { kind: 'facts'; id: string }
    assert.equal(facts.id, 'entries')
  })
})

describe('parseMarkdown：不吞内容', () => {
  it('引用块与分隔线', () => {
    const blocks = parseMarkdown(['> 一句引用', '', '---'].join('\n'))
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ['quote', 'divider'],
    )
  })

  it('多行段落合成一段', () => {
    const blocks = parseMarkdown(['第一行', '第二行'].join('\n'))
    assert.equal(blocks.length, 1)
    const paragraph = blocks[0] as unknown as { kind: string; inlines: Parameters<typeof inlineText>[0] }
    assert.equal(paragraph.kind, 'paragraph')
    assert.equal(inlineText(paragraph.inlines), '第一行 第二行')
  })

  it('任何行都不会被静默丢弃：块数 ≥ 非空逻辑行数 / 3', () => {
    const source = ['# 标题', '', '段落一', '', '- 项一', '- 项二', '', '```ts', 'x', '```'].join('\n')
    const blocks = parseMarkdown(source)
    assert.ok(blocks.length >= 4, `只解析出 ${blocks.length} 块`)
  })
})
