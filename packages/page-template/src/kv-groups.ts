/**
 * 分组键值对（详情页 / 详情弹窗用）。
 *
 * owner 的原话：「详情页所有的都是一行然后按照行排列，这样不行」。改前的做法是
 * 把十四个字段塞进一张「字段 / 值」两列表格，一路排下来——读的人分不清
 * 「模型 / 请求 ID」是一组、「输入 tokens / 输出 tokens」是另一组。
 *
 * 现在按语义分小节（请求 / 令牌 / 费用 / 时间），每节是一串 label-value 对：
 * - label 定宽（`dt` 在 grid 里占固定列），值右对齐 + tabular-nums，一列扫下来能对齐；
 * - 长值（请求 ID、模型名）换行而不是撑破弹窗宽度；
 * - 语义用 `<dl>/<dt>/<dd>`：键值对本来就是定义列表，不是表格。
 */
import { escapeText } from './escape.ts'

/** 一条键值对。 */
export interface KeyValueItem {
  readonly label: string
  /**
   * 值的**已渲染 HTML**（与 `renderTable` 的单元格同一约定：转义由调用方负责）。
   * 纯文本请自己过 `escapeText`；需要徽标 / 等宽包裹时在这里拼。
   */
  readonly value: string
  /** 等宽字体：请求 ID、模型名这类标识符用。 */
  readonly mono?: boolean
}

/** 一个小节（一个语义分组）。 */
export interface KeyValueGroup {
  /** 小节标题；省略 = 不渲染标题（外层已经有区块标题时用）。 */
  readonly title?: string
  readonly items: readonly KeyValueItem[]
}

/**
 * 渲染分组键值对。
 *
 * ```
 * <div class="kv-groups">
 *   <section class="kv-group">
 *     <h3 class="kv-group-title">请求</h3>
 *     <dl class="kv-list">
 *       <div class="kv-row"><dt class="kv-key">模型</dt><dd class="kv-value kv-value--mono">…</dd></div>
 *     </dl>
 *   </section>
 * </div>
 * ```
 */
export function renderKeyValueGroups(groups: readonly KeyValueGroup[]): string {
  if (groups.length === 0) return ''
  const blocks = groups.map((group) => {
    const title = group.title === undefined
      ? ''
      : `<h3 class="kv-group-title">${escapeText(group.title)}</h3>`
    const items = group.items.map((item) =>
      `<div class="kv-row"><dt class="kv-key">${escapeText(item.label)}</dt><dd class="kv-value${
        item.mono === true ? ' kv-value--mono' : ''
      }">${item.value}</dd></div>`).join('\n')
    return `<section class="kv-group">
${title}
<dl class="kv-list">
${items}
</dl>
</section>`
  }).join('\n')
  return `<div class="kv-groups">
${blocks}
</div>`
}
