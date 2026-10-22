/** 管理台 · 全站用量：今日 / 累计与按模型汇总。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { formatYuan } from '../forms.ts'

export const adminUsagePage: PageModule = {
  path: '/admin/usage',
  area: 'admin',
  title: '全站用量',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const usage = ctx.services.usage
    if (usage === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '全站用量') + t.renderNotice({ kind: 'err', text: '用量服务未运行' }))
    }
    const stats = usage.stats()
    const rows = stats.models.map((model) => [
      t.escapeText(model.model),
      t.escapeText(t.formatThousands(model.requests)),
      t.escapeText(t.formatThousands(model.totalTokens)),
      t.escapeText(formatYuan(model.costMicros)),
    ])
    return renderAdminShell(ctx, [
      pageHeader(ctx, '全站用量'),
      t.renderStatCards([
        { label: '今日请求', value: t.formatThousands(stats.today.requests) },
        { label: '今日 Tokens', value: t.formatThousands(stats.today.totalTokens) },
        { label: '今日费用', value: formatYuan(stats.today.costMicros), unit: 'CNY' },
        { label: '累计请求', value: t.formatThousands(stats.total.requests) },
        { label: '累计 Tokens', value: t.formatThousands(stats.total.totalTokens) },
        { label: '累计费用', value: formatYuan(stats.total.costMicros), unit: 'CNY' },
      ], 'metrics'),
      t.renderSectionTitle('按模型'),
      t.renderTable({
        columns: [
          { label: '模型' },
          { label: '请求数', align: 'right' },
          { label: 'Tokens', align: 'right' },
          { label: '费用', align: 'right' },
        ],
        rows,
        empty: '还没有用量记录',
      }),
    ].join('\n'))
  },
}
