/** 管理台 · 全站用量：今日 / 累计与按模型汇总 + 坏记录隔离区。 */
import { pageHeader, renderAdminShell, type PageContext, type PageModule } from '../layout.ts'
import { formatYuan, requiredString, WebError } from '../forms.ts'
import { auditedAction } from '../audit.ts'

const REJECTED_LIMIT = 20

function formatTime(value: string): string {
  return value.slice(0, 19).replace('T', ' ')
}

function rejectedBadge(t: PageContext['t'], status: string): string {
  if (status === 'pending') return t.renderBadge('待处理', 'warn')
  if (status === 'ignored') return t.renderBadge('已忽略', 'err')
  if (status === 'replayed') return t.renderBadge('已重放', 'ok')
  return t.renderBadge(status)
}

/** 操作列：只有 pending 能操作（已忽略 / 已重放保持可见但不可再点）。 */
function rejectedActions(ctx: PageContext, reqId: string, status: string): string {
  if (status === 'ignored') return ctx.t.escapeText('已忽略（不结算）')
  if (status === 'replayed') return ctx.t.escapeText('已重放')
  const id = ctx.t.escapeAttr(reqId)
  return `<div class="actions">
<form class="inline-form" method="post" action="/admin/usage?action=ignore" data-confirm="忽略后这条用量永久不结算、不扣钱，确定？">
<input type="hidden" name="reqId" value="${id}">
<button class="btn small" type="submit">忽略</button>
</form>
<form class="inline-form" method="post" action="/admin/usage?action=replay" data-confirm="按原始载荷重新插入这条用量明细，确定？">
<input type="hidden" name="reqId" value="${id}">
<button class="btn small" type="submit">重放</button>
</form>
</div>`
}

function rejectedPager(offset: number, total: number): string {
  const links: string[] = []
  if (offset > 0) {
    links.push(`<a class="btn small" href="/admin/usage?offset=${Math.max(offset - REJECTED_LIMIT, 0)}">上一页</a>`)
  }
  if (offset + REJECTED_LIMIT < total) {
    links.push(`<a class="btn small" href="/admin/usage?offset=${offset + REJECTED_LIMIT}">下一页</a>`)
  }
  return links.length === 0 ? '' : `<div class="actions">${links.join('')}</div>`
}

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

    const offsetText = ctx.query.get('offset') ?? '0'
    const offset = /^\d+$/.test(offsetText) ? Number(offsetText) : 0
    let rejected
    try {
      rejected = usage.listRejected({ limit: REJECTED_LIMIT, offset })
    } catch {
      rejected = undefined
    }
    const rejectedRows =
      rejected === undefined
        ? []
        : rejected.items.map((row) => [
            `<span class="mono">${t.escapeText(row.reqId)}</span>`,
            t.escapeText(String(row.seq)),
            rejectedBadge(t, row.status),
            t.escapeText(t.formatThousands(row.failures)),
            t.escapeText(row.error.length > 80 ? `${row.error.slice(0, 80)}…` : row.error),
            t.escapeText(formatTime(row.updatedAt)),
            rejectedActions(ctx, row.reqId, row.status),
          ])
    const rejectedSection =
      rejected === undefined
        ? t.renderNotice({ kind: 'err', text: '隔离区暂时不可读，请稍后再试' })
        : [
            t.renderSectionTitle('坏记录隔离区'),
            t.renderNotice({
              kind: 'info',
              text:
                '这些记录连续落库失败后已被隔离：它们没有进用量明细，不会结算或扣钱；' +
                '确认放弃点「忽略」，修好数据后点「重放」（按 req_id 幂等）。',
            }),
            t.renderTable({
              columns: [
                { label: '请求 ID' },
                { label: '序号', align: 'right' },
                { label: '状态' },
                { label: '失败轮数', align: 'right' },
                { label: '原因' },
                { label: '更新时间' },
                { label: '操作' },
              ],
              rows: rejectedRows,
              empty: '没有隔离记录',
            }),
            rejectedPager(offset, rejected.total),
          ].join('\n')

    return renderAdminShell(ctx, [
      pageHeader(ctx, '全站用量'),
      t.renderStatCards([
        { label: '今日请求', value: t.formatThousands(stats.today.requests) },
        { label: '今日 Tokens', value: t.formatThousands(stats.today.totalTokens) },
        { label: '今日费用', value: formatYuan(stats.today.costMicros), unit: 'CNY' },
        { label: '累计请求', value: t.formatThousands(stats.total.requests) },
        { label: '累计 Tokens', value: t.formatThousands(stats.total.totalTokens) },
        { label: '累计费用', value: formatYuan(stats.total.costMicros), unit: 'CNY' },
        { label: '待处理隔离', value: t.formatThousands(rejected?.pending ?? 0) },
        { label: '累计隔离', value: t.formatThousands(rejected?.total ?? 0) },
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
      rejectedSection,
    ].join('\n'))
  },

  actions: {
    ignore: async (ctx) => {
      const usage = ctx.services.usage
      if (usage === undefined) throw new WebError('WEB_NO_USAGE', '用量服务未运行')
      const reqId = requiredString(ctx.form, 'reqId', '隔离记录')
      await auditedAction(
        ctx,
        {
          action: 'usage.rejected.ignore',
          targetType: 'usage-record',
          targetId: reqId,
          // 忽略 = 这笔用量永久不结算、不扣钱，等于放弃收入。
          summary: '忽略一条被隔离的用量记录（永久不结算）',
        },
        () => usage.ignoreRejected(reqId),
      )
      return `/admin/usage?ok=${encodeURIComponent('已忽略这条隔离记录：不结算、不扣钱')}`
    },

    replay: async (ctx) => {
      const usage = ctx.services.usage
      if (usage === undefined) throw new WebError('WEB_NO_USAGE', '用量服务未运行')
      const reqId = requiredString(ctx.form, 'reqId', '隔离记录')
      const result = await auditedAction(
        ctx,
        {
          action: 'usage.rejected.replay',
          targetType: 'usage-record',
          targetId: reqId,
          // 重放会补结算（扣钱）：失败也记，漏记一次账就对不上。
          summary: '重放一条被隔离的用量记录（补结算）',
          metadataOf: (out) => ({ inserted: out.inserted, status: out.status }),
        },
        () => usage.replayRejected(reqId),
      )
      const text = result.inserted
        ? '已重放并补写用量明细'
        : '已重放：这条记录此前已补写成功，没有重复插入'
      return `/admin/usage?ok=${encodeURIComponent(text)}`
    },
  },
}
