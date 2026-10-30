/**
 * 用量概览（`/console/usage`）：指标卡 + 恒定 7 个时间点的消费图 + 按模型 + 最近 10 条请求。
 *
 * owner 的口径：
 * - 概览页「最近请求」**只留最近 10 条**，完整列表在 `/console/usage/detail`；
 * - 柱状图**恒 7 个时间点**（空桶补 0），支持「按模型 / 按 API key」两种查看维度；
 * - 时间维度是显式下拉（今天 / 昨天 / 近 7 天 / 近 30 天）；
 * - 每行「详情」→ 自绘弹窗：模型 / 总耗时 / TTFT / 四桶 token / 金额。
 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { formatYuan } from '../forms.ts'
import {
  CHART_SAMPLE_LIMIT,
  DIMENSIONS,
  RECENT_LIMIT,
  USAGE_RANGES,
  averageTtft,
  buildChart,
  chartSlots,
  detailModal,
  detailTrigger,
  dialogIdOf,
  filtersForm,
  formatClock,
  formatMs,
  hrefOf,
  keyOptions,
  parseFilters,
  queryOf,
  rangeOnlyQuery,
} from '../usage-view.ts'

const DETAIL_PATH = '/console/usage/detail'

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

    const filters = parseFilters(ctx.query)
    const query = queryOf(filters)
    // 两个汇总：一个**不受 model / API key 筛选影响**（给下拉选项用），一个按当前筛选（给数字用）。
    const optionSummary = usage.summary(rangeOnlyQuery(filters))
    const summary = usage.summary(query)
    const page = usage.list({ ...query, limit: RECENT_LIMIT })
    const rows = usage.exportRows(query, CHART_SAMPLE_LIMIT)
    const keyRows =
      filters.model === '' && filters.apiKeyId === ''
        ? rows
        : usage.exportRows(rangeOnlyQuery(filters), CHART_SAMPLE_LIMIT)

    const singleDay = filters.range.key === 'today' || filters.range.key === 'yesterday'
    const slots = chartSlots(filters.range)
    const view = buildChart(rows, slots, filters.dim)
    const chart = t.renderStackedBarChart(view.data, view.groups, view.theme, 'currency', 'usage')
    const chartCard = t.renderChartCard({
      title: singleDay ? '消费金额（CNY，最近 7 小时）' : '消费金额（CNY，7 个时间点）',
      total: formatYuan(summary.totals.costMicros),
      // 查看维度放图卡里：它是「这张图怎么分组」的属性，跟筛选条件不是一回事。
      segments: DIMENSIONS.map((item) => ({
        label: item.label,
        href: hrefOf('/console/usage', filters, { dim: item.key }),
        selected: item.key === filters.dim,
      })),
      chart,
    })

    const stats = t.renderStatCards(
      [
        { label: '消费金额', value: formatYuan(summary.totals.costMicros), unit: 'CNY' },
        { label: 'API 请求次数', value: t.formatThousands(summary.totals.requests) },
        { label: 'Tokens', value: t.formatThousands(summary.totals.totalTokens) },
        // 首字延迟：只统计采集到的（流式）请求；一条都没有时显示「—」。
        { label: '平均首字延迟', value: formatMs(averageTtft(rows)) },
      ],
      'metrics',
    )

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

    const recentRows = page.items.map((row) => [
      t.escapeText(formatClock(row.startedAt)),
      t.escapeText(row.model),
      t.escapeText(row.apiKeyName === '' ? '—' : row.apiKeyName),
      t.escapeText(t.formatThousands(row.totalTokens)),
      t.escapeText(formatYuan(row.costMicros)),
      t.escapeText(formatMs(row.durationMs)),
      t.escapeText(formatMs(row.ttftMs)),
      row.status === 200 ? t.escapeText('200') : t.renderBadge(String(row.status), 'err'),
      detailTrigger(
        t,
        row,
        dialogIdOf(row),
        hrefOf(DETAIL_PATH, filters, { reqId: row.reqId, cursor: undefined }),
      ),
    ])
    const recentTable = t.renderTable({
      columns: [
        { label: '时间' },
        { label: '模型' },
        { label: 'API key' },
        { label: 'Tokens', align: 'right' },
        { label: '消费', align: 'right' },
        { label: '耗时', align: 'right' },
        { label: '首字延迟', align: 'right' },
        { label: '状态', align: 'right' },
        { label: '操作' },
      ],
      rows: recentRows,
      empty: '还没有请求记录',
    })

    return renderConsoleShell(ctx, [
      pageHeader(ctx, '用量信息', '所有日期按本地时区显示；数据可能有几分钟延迟。'),
      filtersForm(
        t,
        '/console/usage',
        filters,
        optionSummary.models.map((model) => model.model),
        keyOptions(keyRows, filters.apiKeyId),
      ),
      stats,
      chartCard,
      t.renderSectionTitle('按模型'),
      modelTable,
      t.renderSectionTitle('最近请求'),
      t.renderNotice({
        kind: 'info',
        text: '概览只保留最近 10 条；完整列表、分页与筛选在「用量明细」页。首字延迟只有流式请求才有值。',
      }),
      recentTable,
      `<div class="actions"><a class="btn" href="${t.escapeAttr(
        hrefOf(DETAIL_PATH, filters, { cursor: undefined, reqId: undefined }),
      )}">查看全部明细</a></div>`,
      // 每条记录的详情弹窗（服务端预渲染）。JS 在时由 data-dialog-open 打开；
      // 没有 JS 时「详情」是普通链接，跳到明细页并直接渲染该条记录。
      page.items.map((row) => detailModal(t, row)).join('\n'),
    ].join('\n'))
  },
}

/** 时间档位在页面里只读一次，导出给测试断言「四档都在」。 */
export const USAGE_RANGE_KEYS = USAGE_RANGES.map((item) => item.key)
