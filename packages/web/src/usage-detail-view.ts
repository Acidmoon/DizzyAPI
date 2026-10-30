/**
 * 用量详情（详情弹窗 + 明细页 `?reqId=` 的整页详情）的视图层。
 *
 * 为什么从 `usage-view.ts` 拆出来：那个文件已经顶到 400 行软上限，而详情这块要
 * 从「字段 / 值两列表格」改成分组键值对（owner 的原话：「详情页所有的都是一行
 * 然后按照行排列，这样不行」），只会更长。职责也不一样：`usage-view.ts` 管
 * 「筛选 / 时间档位 / 图表」，这里管「一条记录的详情长什么样」。
 *
 * 分四节的依据是**读的人想知道什么**：
 * - 请求：这是哪个模型、哪次请求、哪个 key、成没成；
 * - 令牌：四桶 token 与合计（输入 / 输出分开看，缓存单独两桶）；
 * - 费用：这次花了多少（读取时按价格表算，不落库）；
 * - 时间：什么时候、用了多久、首字多快。
 *
 * 两条口径不变：**金额注明「读取时按价格表计算」**；**首字延迟 null 显示「—」**，
 * 绝不显示 0 ms（0 与「没采集」是两件事）。
 */
import type { PageTemplateService, KeyValueGroup } from '@dizzyapi/plugin-page-template'
import { formatYuan } from './forms.ts'
import type { UsageRow } from './usage-types.ts'
import { formatClock, formatMs } from './usage-view.ts'

/** 「详情」按钮：JS 在的时候开弹窗；没有 JS 时退化成整页链接（明细页渲染该条详情）。 */
export function detailTrigger(t: PageTemplateService, row: UsageRow, dialogId: string, fallbackHref: string): string {
  return `<a class="btn small" href="${t.escapeAttr(fallbackHref)}"${t.dialogOpenAttr(dialogId)}>详情</a>`
}

/**
 * 详情正文：四小节 + 键值对（见文件头）。
 *
 * 值一律先转义再拼（`renderKeyValueGroups` 的值是「已渲染 HTML」，与表格单元格同一约定）。
 */
export function detailBody(t: PageTemplateService, row: UsageRow): string {
  const status = String(row.status)
  const groups: readonly KeyValueGroup[] = [
    {
      title: '请求',
      items: [
        { label: '模型', value: t.escapeText(row.model), mono: true },
        { label: '请求 ID', value: t.escapeText(row.reqId), mono: true },
        { label: 'API key', value: t.escapeText(row.apiKeyName === '' ? '—' : row.apiKeyName) },
        { label: '状态', value: row.status === 200 ? t.escapeText(status) : t.renderBadge(status, 'err') },
      ],
    },
    {
      title: '令牌',
      items: [
        { label: '输入 tokens', value: t.escapeText(t.formatThousands(row.inputTokens)) },
        { label: '输出 tokens', value: t.escapeText(t.formatThousands(row.outputTokens)) },
        { label: '缓存读 tokens', value: t.escapeText(t.formatThousands(row.cacheReadTokens)) },
        { label: '缓存写 tokens', value: t.escapeText(t.formatThousands(row.cacheWriteTokens)) },
        { label: '推理 tokens', value: t.escapeText(t.formatThousands(row.reasoningTokens)) },
        { label: '合计 tokens', value: t.escapeText(t.formatThousands(row.totalTokens)) },
      ],
    },
    {
      title: '费用',
      items: [{ label: '金额', value: `${t.escapeText(formatYuan(row.costMicros))} CNY` }],
    },
    {
      title: '时间',
      items: [
        { label: '开始时间', value: t.escapeText(formatClock(row.startedAt)) },
        { label: '总耗时', value: t.escapeText(formatMs(row.durationMs)) },
        { label: '首字延迟（TTFT）', value: t.escapeText(formatMs(row.ttftMs)) },
      ],
    },
  ]
  const usageFlags = [
    row.usagePresent ? null : t.renderBadge('响应未带 usage', 'warn'),
    row.usageComplete ? null : t.renderBadge('流未读完（客户端可能提前断开）', 'warn'),
  ].filter((item) => item !== null)
  return [
    t.renderKeyValueGroups(groups),
    t.renderNotice({
      kind: 'info',
      text: '金额在读取时按价格表计算（整数微元换算，不落库）；首字延迟只有流式请求才有值。',
    }),
    usageFlags.length === 0 ? '' : `<div class="actions">${usageFlags.join('')}</div>`,
  ].join('\n')
}

/**
 * 一条记录的详情弹窗（服务端预渲染：没有客户端 fetch，也就不依赖任何脚本）。
 *
 * 用 `full` 档（720px）：四小节的键值对要能排成两列，`wide` 档只有 560px，会很挤。
 */
export function detailModal(t: PageTemplateService, row: UsageRow): string {
  return t.renderModal({
    id: dialogIdOf(row),
    title: '请求详情',
    bodyHtml: detailBody(t, row),
    footerHtml: '<button class="btn" type="button" data-dialog-close>关闭</button>',
    size: 'full',
  })
}

export function dialogIdOf(row: UsageRow): string {
  return `usage-detail-${row.id}`
}
