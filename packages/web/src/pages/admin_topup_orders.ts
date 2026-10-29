/**
 * 管理台 · 充值订单：列表 / 筛选 / 人工确认到账 / 取消。
 *
 * 确认到账会**真的加余额**（走 `user.adjustBalance`，幂等）：重复确认只回「此前已到账」，
 * 不会重复加钱；页面明确提示「确认前请先核对转账」。
 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { formatYuan, requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'
import { auditedAction } from '../audit.ts'

const PAGE_SIZE = 20

const STATUS_LABEL: Readonly<Record<string, string>> = {
  pending: '待确认',
  paid: '已到账',
  canceled: '已取消',
  expired: '已过期',
}

const STATUS_TONE: Readonly<Record<string, 'ok' | 'err' | 'warn'>> = {
  pending: 'warn',
  paid: 'ok',
  canceled: 'err',
  expired: 'err',
}

const FILTERS: readonly { label: string; status: string }[] = [
  { label: '全部', status: '' },
  { label: '待确认', status: 'pending' },
  { label: '已到账', status: 'paid' },
  { label: '已取消', status: 'canceled' },
  { label: '已过期', status: 'expired' },
]

function shortTime(iso: string | null): string {
  return iso === null || iso.length < 19 ? '—' : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

function intParam(value: string | null): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
}

export const adminTopupOrdersPage: PageModule = {
  path: '/admin/topup-orders',
  area: 'admin',
  title: '充值订单',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const topup = ctx.services.topup
    if (topup === undefined) {
      return renderAdminShell(
        ctx,
        pageHeader(ctx, '充值订单') +
          t.renderNotice({ kind: 'err', text: '充值订单服务未运行：暂时不能确认到账' }),
      )
    }

    const status = ctx.query.get('status') ?? ''
    const offset = intParam(ctx.query.get('offset'))
    let page: Awaited<ReturnType<typeof topup.list>>
    let stats: Awaited<ReturnType<typeof topup.stats>>
    try {
      page = topup.list(WEB_ACTOR, {
        limit: PAGE_SIZE,
        offset,
        ...(status === '' ? {} : { status }),
      })
      stats = topup.stats(WEB_ACTOR)
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取充值订单失败'
      return renderAdminShell(ctx, pageHeader(ctx, '充值订单') + t.renderNotice({ kind: 'err', text: message }))
    }

    const filterLinks = FILTERS.map((item) => ({
      label: item.label,
      href: item.status === '' ? '/admin/topup-orders' : `/admin/topup-orders?status=${item.status}`,
    }))
    const filterHtml = `<div class="filters">${filterLinks
      .map(
        (item) =>
          `<a class="btn small${(item.href === '/admin/topup-orders' ? status === '' : item.href.endsWith(status)) ? ' active' : ''}" href="${t.escapeAttr(item.href)}">${t.escapeText(item.label)}</a>`,
      )
      .join('')}</div>`

    const rows = page.items.map((order) => {
      const actionCell =
        order.status !== 'pending'
          ? t.escapeText('—')
          : [
              `<form class="inline-form" method="post" action="/admin/topup-orders?action=confirm" data-confirm="确认会给用户 #${order.userId} 增加 ${formatYuan(order.amountMicro)} 余额（幂等，只加一次），确定已收到转账？">
<input type="hidden" name="orderNo" value="${t.escapeAttr(order.orderNo)}">
<button class="btn small" type="submit">确认到账</button>
</form>`,
              `<form class="inline-form" method="post" action="/admin/topup-orders?action=cancel" data-confirm="取消后这笔订单不能再确认到账，确定？">
<input type="hidden" name="orderNo" value="${t.escapeAttr(order.orderNo)}">
<button class="btn small" type="submit">取消</button>
</form>`,
            ].join(' ')
      return [
        `<code class="mono">${t.escapeText(order.orderNo)}</code>`,
        t.escapeText(`#${order.userId}`),
        t.escapeText(formatYuan(order.amountMicro)),
        t.renderBadge(STATUS_LABEL[order.status] ?? order.status, STATUS_TONE[order.status] ?? 'err'),
        t.escapeText(order.providerLabel),
        t.escapeText(shortTime(order.createdAt)),
        t.escapeText(shortTime(order.expiresAt)),
        actionCell,
      ]
    })

    const pager: string[] = []
    if (offset > 0) {
      const previous = Math.max(offset - PAGE_SIZE, 0)
      const href = status === '' ? `/admin/topup-orders?offset=${previous}` : `/admin/topup-orders?status=${status}&offset=${previous}`
      pager.push(`<a class="btn small" href="${t.escapeAttr(href)}">上一页</a>`)
    }
    if (offset + PAGE_SIZE < page.total) {
      const next = offset + PAGE_SIZE
      const href = status === '' ? `/admin/topup-orders?offset=${next}` : `/admin/topup-orders?status=${status}&offset=${next}`
      pager.push(`<a class="btn small" href="${t.escapeAttr(href)}">下一页</a>`)
    }

    return renderAdminShell(
      ctx,
      [
        pageHeader(
          ctx,
          '充值订单',
          '确认到账会立刻给用户增加余额（走 user.adjustBalance，按订单号幂等，只加一次）；' +
            '请先核对线下转账再点。当前没有在线支付，也没有支付回调。',
        ),
        t.renderStatCards(
          [
            { label: '今日到账', value: formatYuan(stats.todayPaidMicros), unit: 'CNY' },
            { label: '今日笔数', value: t.formatThousands(stats.todayPaidCount) },
            { label: '累计到账', value: formatYuan(stats.totalPaidMicros), unit: 'CNY' },
            { label: '累计笔数', value: t.formatThousands(stats.totalPaidCount) },
            { label: '待确认', value: t.formatThousands(stats.pendingCount) },
            { label: '已过期', value: t.formatThousands(stats.expiredCount) },
          ],
          'metrics',
        ),
        filterHtml,
        t.renderTable({
          columns: [
            { label: '单号' },
            { label: '用户' },
            { label: '金额', align: 'right' },
            { label: '状态' },
            { label: '支付方式' },
            { label: '创建（UTC）' },
            { label: '到期（UTC）' },
            { label: '操作' },
          ],
          rows,
          empty: '没有符合条件的充值订单',
        }),
        pager.length === 0 ? '' : `<div class="filters" style="margin-top:12px">${pager.join('')}</div>`,
      ].join('\n'),
    )
  },

  actions: {
    confirm: async (ctx) => {
      const topup = ctx.services.topup
      if (topup === undefined) throw new WebError('WEB_NO_TOPUP', '充值订单服务未运行')
      const orderNo = requiredString(ctx.form, 'orderNo', '订单号')
      const result = await auditedAction(
        ctx,
        {
          action: 'topup.order.confirm',
          targetType: 'topup-order',
          targetId: orderNo,
          summary: `确认充值订单 ${orderNo} 到账`,
          metadataOf: (out) => ({
            credited: out.credited,
            userId: out.order.userId,
            amountMicros: out.order.amountMicro.toString(),
          }),
        },
        () => topup.confirmPaid(WEB_ACTOR, orderNo),
      )
      const text = result.credited
        ? `订单 ${orderNo} 已确认到账：用户 #${result.order.userId} 余额已增加 ${formatYuan(result.order.amountMicro)}`
        : `订单 ${orderNo} 此前已到账，本次没有重复加钱`
      return `/admin/topup-orders?ok=${encodeURIComponent(text)}`
    },

    cancel: async (ctx) => {
      const topup = ctx.services.topup
      if (topup === undefined) throw new WebError('WEB_NO_TOPUP', '充值订单服务未运行')
      const orderNo = requiredString(ctx.form, 'orderNo', '订单号')
      await auditedAction(
        ctx,
        {
          action: 'topup.order.cancel',
          targetType: 'topup-order',
          targetId: orderNo,
          summary: `取消充值订单 ${orderNo}`,
          metadataOf: (order) => ({ userId: order.userId, status: order.status }),
        },
        () => topup.cancel(WEB_ACTOR, orderNo),
      )
      return `/admin/topup-orders?ok=${encodeURIComponent(`订单 ${orderNo} 已取消`)}`
    },
  },
}
