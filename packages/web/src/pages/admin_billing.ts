/** 管理台 · 结算：扣费汇总、失败 / 残留、最近结算记录（只读）。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { formatYuan } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'

const STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '待结算',
  settling: '结算中（残留）',
  settled: '已结算',
  'no-price': '无价格',
  'no-user': '无用户',
  failed: '失败',
  review: '待核查',
}

const PROBLEM_LIMIT = 20
const RECENT_LIMIT = 20

/** 请求时间：`MM-DD HH:mm`（UTC 的 ISO 切片，与其它页面同口径）。 */
function shortTime(iso: string | null): string {
  if (iso === null || iso.length < 16) return '—'
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

export const adminBillingPage: PageModule = {
  path: '/admin/billing',
  area: 'admin',
  title: '结算',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const billing = ctx.services.billing
    if (billing === undefined) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '结算') +
          t.renderNotice({
            kind: 'err',
            text: '结算服务未运行：扣费已暂停，用量仍照常落库；启用 billing 插件后自动恢复',
          }),
      )
    }

    const summary = billing.summary(WEB_ACTOR)
    const problems = billing.list(WEB_ACTOR, { status: 'problem', limit: PROBLEM_LIMIT })
    const recent = billing.list(WEB_ACTOR, { limit: RECENT_LIMIT })
    const totals = summary.totals
    const openCases = totals.failed + totals.review + totals.settling

    const dailyRows = summary.daily.map((point) => [
      t.escapeText(point.date),
      t.escapeText(t.formatThousands(point.settled)),
      t.escapeText(t.formatThousands(point.records)),
      t.escapeText(formatYuan(point.chargedMicros)),
    ])

    const problemRows = problems.items.map((item) => [
      t.escapeText(shortTime(item.startedAt)),
      t.escapeText(item.reqId),
      t.escapeText(`#${item.userId}`),
      t.escapeText(item.model === '' ? '—' : item.model),
      t.escapeText(STATUS_LABEL[item.status] ?? item.status),
      t.escapeText(formatYuan(item.costMicro)),
      t.escapeText(item.note ?? '—'),
    ])

    const recentRows = recent.items.map((item) => [
      t.escapeText(shortTime(item.settledAt ?? item.startedAt)),
      t.escapeText(item.reqId),
      t.escapeText(`#${item.userId}`),
      t.escapeText(item.model === '' ? '—' : item.model),
      t.escapeText(STATUS_LABEL[item.status] ?? item.status),
      t.escapeText(formatYuan(item.costMicro)),
    ])

    const modelRows = summary.models.map((item) => [
      t.escapeText(item.model === '' ? '—' : item.model),
      t.escapeText(t.formatThousands(item.records)),
      t.escapeText(formatYuan(item.chargedMicros)),
    ])

    return renderAdminShell(
      ctx,
      [
        pageHeader(ctx, '结算', '真实扣费：先结算、再落用量、最后推进游标；同一 reqId 只扣一次。日期按 UTC。'),
        t.renderStatCards(
          [
            { label: '已结算', value: t.formatThousands(totals.settled) },
            { label: '累计扣费', value: formatYuan(totals.chargedMicros), unit: 'CNY' },
            { label: '今日扣费', value: formatYuan(totals.todayChargedMicros), unit: 'CNY' },
            { label: '待处理', value: t.formatThousands(openCases) },
            { label: '无价格', value: t.formatThousands(totals.noPrice) },
            { label: '无用户', value: t.formatThousands(totals.noUser) },
          ],
          'metrics',
        ),
        t.renderSectionTitle('失败 / 残留'),
        t.renderTable({
          columns: [
            { label: '请求时间' },
            { label: '请求 ID' },
            { label: '用户' },
            { label: '模型' },
            { label: '状态' },
            { label: '费用', align: 'right' },
            { label: '备注' },
          ],
          rows: problemRows,
          empty: '没有失败或残留的结算',
        }),
        t.renderSectionTitle('按天汇总'),
        t.renderTable({
          columns: [
            { label: '日期' },
            { label: '已结算', align: 'right' },
            { label: '请求数', align: 'right' },
            { label: '扣费', align: 'right' },
          ],
          rows: dailyRows,
          empty: '最近 30 天没有结算记录',
        }),
        t.renderSectionTitle('按模型'),
        t.renderTable({
          columns: [
            { label: '模型' },
            { label: '请求数', align: 'right' },
            { label: '扣费', align: 'right' },
          ],
          rows: modelRows,
          empty: '还没有结算记录',
        }),
        t.renderSectionTitle('最近结算'),
        t.renderTable({
          columns: [
            { label: '结算时间' },
            { label: '请求 ID' },
            { label: '用户' },
            { label: '模型' },
            { label: '状态' },
            { label: '费用', align: 'right' },
          ],
          rows: recentRows,
          empty: '还没有结算记录',
        }),
      ].join('\n'),
    )
  },
}
