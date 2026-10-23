/** 用量信息：指标卡 + 按天成本图 + 模型明细。 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { formatYuan, microsToYuan } from '../forms.ts'
import { bucketDaily } from '../series.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** 本地时区当天 0 点；`offsetDays = 1` 是昨天 0 点。 */
function startOfLocalDay(offsetDays = 0): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - offsetDays)
  return date.getTime()
}

interface RangeOption {
  readonly key: string
  readonly label: string
  from(): number
  to(): number
}

const RANGES: readonly RangeOption[] = [
  { key: 'today', label: '今天', from: () => startOfLocalDay(0), to: () => Date.now() },
  { key: 'yesterday', label: '昨天', from: () => startOfLocalDay(1), to: () => startOfLocalDay(0) },
  { key: '7d', label: '近 7 天', from: () => Date.now() - 7 * DAY_MS, to: () => Date.now() },
  { key: '30d', label: '近 30 天', from: () => Date.now() - 30 * DAY_MS, to: () => Date.now() },
  { key: '90d', label: '近 90 天', from: () => Date.now() - 90 * DAY_MS, to: () => Date.now() },
]

export const usagePage: PageModule = {
  path: '/console/usage',
  area: 'console',
  title: '用量信息',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const usage = ctx.services.usage
    if (usage === undefined) {
      return renderConsoleShell(ctx, pageHeader(ctx, '用量信息') + t.renderNotice({ kind: 'err', text: '用量服务未运行' }))
    }

    const rangeKey = ctx.query.get('range') ?? '30d'
    const range = RANGES.find((item) => item.key === rangeKey) ?? RANGES[3]
    const fromMs = range.from()
    const toMs = range.to()
    const query = { fromMs, toMs, userId: ctx.user.userId }
    const summary = usage.summary(query)
    const page = usage.list({ ...query, limit: 20 })

    const stats = t.renderStatCards([
      { label: '消费金额', value: formatYuan(summary.totals.costMicros), unit: 'CNY' },
      { label: 'API 请求次数', value: t.formatThousands(summary.totals.requests) },
      { label: 'Tokens', value: t.formatThousands(summary.totals.totalTokens) },
    ], 'metrics')

    // 图表固定 7 根柱：30 / 90 天按时间顺序等分聚合。
    const daily = bucketDaily(summary.daily)
    const chartData = daily.map((point) => ({
      date: point.date,
      series: { 消费金额: microsToYuan(point.costMicros) },
    }))
    const chart = t.renderStackedBarChart(chartData, ['消费金额'], undefined, 'currency', 'usage')
    const chartCard = t.renderChartCard({ title: '消费金额（CNY）', total: formatYuan(summary.totals.costMicros), chart })

    const modelRows = summary.models.map((model) => [
      t.escapeText(model.model),
      t.escapeText(t.formatThousands(model.requests)),
      t.escapeText(t.formatThousands(model.totalTokens)),
      t.escapeText(formatYuan(model.costMicros)),
    ])
    const modelTable = t.renderTable({
      columns: [
        { label: '模型' },
        { label: '请求数', align: 'right' },
        { label: 'Tokens', align: 'right' },
        { label: '消费', align: 'right' },
      ],
      rows: modelRows,
      empty: '当前范围内没有用量记录',
    })

    const detailRows = page.items.map((row) => [
      t.escapeText(row.startedAt.slice(0, 16).replace('T', ' ')),
      t.escapeText(row.model),
      t.escapeText(row.apiKeyName),
      t.escapeText(t.formatThousands(row.totalTokens)),
      t.escapeText(formatYuan(row.costMicros)),
    ])
    const detailTable = t.renderTable({
      columns: [
        { label: '时间' },
        { label: '模型' },
        { label: 'API key' },
        { label: 'Tokens', align: 'right' },
        { label: '消费', align: 'right' },
      ],
      rows: detailRows,
      empty: '还没有请求记录',
    })

    const pills = [{
      label: '时间维度',
      value: range.label,
      items: RANGES.map((item) => ({
        label: item.label,
        href: `/console/usage?range=${item.key}`,
        selected: item.key === range.key,
      })),
    }]

    return renderConsoleShell(ctx, [
      pageHeader(ctx, '用量信息', '所有日期均按 GMT+8 显示，数据可能有几分钟延迟。'),
      stats,
      t.renderFilterBar(pills),
      chartCard,
      t.renderSectionTitle('按模型'),
      modelTable,
      t.renderSectionTitle('最近请求'),
      detailTable,
    ].join('\n'))
  },
}
