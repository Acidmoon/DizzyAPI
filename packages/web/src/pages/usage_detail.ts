/**
 * 用量明细（`/console/usage/detail`）：完整列表 + keyset 分页 + 筛选 + 每行详情弹窗。
 *
 * 为什么单独一页：概览页只留指标卡、图与最近 10 条（owner 的口径），
 * 完整明细（四桶 token / 耗时 / 首字延迟 / 金额）放这里，页面不会越用越长。
 *
 * **无 JS 的降级**：概览页的「详情」是普通链接，跳到这里并带 `?reqId=`；
 * 本页在顶部把那条记录**用普通区块**渲染出来（不是弹窗），所以禁用脚本也能看。
 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { formatYuan } from '../forms.ts'
import {
  CHART_SAMPLE_LIMIT,
  DETAIL_PAGE_SIZE,
  detailBody,
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
import { exportHref } from '../usage-export.ts'

const DETAIL_PATH = '/console/usage/detail'

export const usageDetailPage: PageModule = {
  path: DETAIL_PATH,
  area: 'console',
  title: '用量明细',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const usage = ctx.services.usage
    if (usage === undefined) {
      return renderConsoleShell(ctx, pageHeader(ctx, '用量明细') + t.renderNotice({ kind: 'err', text: '用量服务未运行' }))
    }

    const filters = parseFilters(ctx.query)
    // 用户侧**必须**带 userId：`usage` 服务不给 userId 就是全站口径（管理面语义）。
    const userId = ctx.user.userId
    const query = queryOf(filters, userId)
    const page = usage.list({ ...query, limit: DETAIL_PAGE_SIZE })
    const optionRows = usage.exportRows(rangeOnlyQuery(filters, userId), CHART_SAMPLE_LIMIT)
    const optionSummary = usage.summary(rangeOnlyQuery(filters, userId))

    // `?reqId=`：无脚本路径下的单条详情。**只给本人**（页面是用户面，
    // 服务层的 get 不判归属，权限必须在这一层判，否则改 URL 就能看别人的记录）。
    const reqId = (ctx.query.get('reqId') ?? '').trim()
    let focused: string = ''
    if (reqId !== '') {
      const record = usage.get(reqId)
      const own = record !== null && record.userId === ctx.user.userId
      focused = own
        ? [
            t.renderSectionTitle('请求详情'),
            detailBody(t, record),
            `<div class="actions"><a class="btn small" href="${t.escapeAttr(
              hrefOf(DETAIL_PATH, filters, { reqId: undefined }),
            )}">关闭详情</a></div>`,
          ].join('\n')
        : t.renderNotice({ kind: 'err', text: '没有这条用量记录' })
    }

    const rows = page.items.map((row) => [
      t.escapeText(formatClock(row.startedAt)),
      t.escapeText(row.model),
      t.escapeText(row.apiKeyName === '' ? '—' : row.apiKeyName),
      t.escapeText(t.formatThousands(row.inputTokens)),
      t.escapeText(t.formatThousands(row.outputTokens)),
      t.escapeText(t.formatThousands(row.cacheReadTokens)),
      t.escapeText(t.formatThousands(row.cacheWriteTokens)),
      t.escapeText(t.formatThousands(row.totalTokens)),
      t.escapeText(formatYuan(row.costMicros)),
      t.escapeText(formatMs(row.durationMs)),
      t.escapeText(formatMs(row.ttftMs)),
      row.status === 200 ? t.escapeText('200') : t.renderBadge(String(row.status), 'err'),
      detailTrigger(t, row, dialogIdOf(row), hrefOf(DETAIL_PATH, filters, { reqId: row.reqId })),
    ])
    const table = t.renderTable({
      columns: [
        { label: '时间' },
        { label: '模型' },
        { label: 'API key' },
        { label: '输入', align: 'right' },
        { label: '输出', align: 'right' },
        { label: '缓存读', align: 'right' },
        { label: '缓存写', align: 'right' },
        { label: '合计', align: 'right' },
        { label: '消费', align: 'right' },
        { label: '耗时', align: 'right' },
        { label: '首字延迟', align: 'right' },
        { label: '状态', align: 'right' },
        { label: '操作' },
      ],
      rows,
      empty: '当前筛选条件下没有用量记录',
    })

    // keyset 分页只能往后翻：下一页用 nextCursor，回第一页用「回到最新」。
    const pager: string[] = []
    if (filters.cursor !== undefined) {
      pager.push(
        `<a class="btn small" href="${t.escapeAttr(hrefOf(DETAIL_PATH, filters, { cursor: undefined }))}">回到最新</a>`,
      )
    }
    if (page.nextCursor !== null) {
      pager.push(
        `<a class="btn small" href="${t.escapeAttr(
          hrefOf(DETAIL_PATH, filters, { cursor: page.nextCursor }),
        )}">下一页</a>`,
      )
    }
    // 导出：普通链接指向 web 自己的 `text/csv` 路由（带当前筛选），浏览器原生下载，
    // 不依赖任何客户端脚本；所以不需要 `data-export` 钩子。
    const exportHtml = `<a class="btn" href="${exportHref(t, filters)}">导出 CSV</a>`

    return renderConsoleShell(ctx, [
      pageHeader(ctx, '用量明细', '完整列表：四桶 token、耗时、首字延迟与金额。金额在读取时按价格表计算。'),
      focused,
      filtersForm(
        t,
        DETAIL_PATH,
        filters,
        optionSummary.models.map((model) => model.model),
        keyOptions(optionRows, filters.apiKeyId),
      ),
      t.renderNotice({
        kind: 'info',
        text: '首字延迟（TTFT）只有流式请求才有值；非流式请求与升级前的历史记录显示「—」。',
      }),
      table,
      `<div class="actions">${exportHtml}${pager.join('')}</div>`,
      `<div class="actions"><a class="btn" href="${t.escapeAttr(
        hrefOf('/console/usage', filters, { cursor: undefined, reqId: undefined }),
      )}">返回概览</a></div>`,
      page.items.map((row) => detailModal(t, row)).join('\n'),
    ].join('\n'))
  },
}
