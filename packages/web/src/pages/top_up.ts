/**
 * 充值（用户页）：下单 → 人工确认到账。
 *
 * 本批**没有在线支付**：下单只生成一笔 pending 订单，页面给出「联系管理员线下转账」的说明，
 * 管理员在 `/admin/topup-orders` 确认后才加余额（走 user.adjustBalance，幂等）。
 * 页面文案必须让用户明确「不会自动到账」。
 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { formatYuan, optionalString, requiredString, WebError } from '../forms.ts'

const ORDER_LIST_LIMIT = 20

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

function shortTime(iso: string | null): string {
  return iso === null || iso.length < 19 ? '—' : `${iso.slice(0, 10)} ${iso.slice(11, 19)}`
}

export const topUpPage: PageModule = {
  path: '/console/top-up',
  area: 'console',
  title: '充值',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const header = pageHeader(
      ctx,
      '充值',
      '当前仅支持人工确认到账：下单后请联系管理员线下转账，管理员核对后为你确认到账；' +
        '尚未接入在线支付，不会自动到账。余额按整数微元记账（1 元 = 1,000,000 微元）。',
    )
    const topup = ctx.services.topup
    if (topup === undefined) {
      return renderConsoleShell(
        ctx,
        `${header}\n${t.renderNotice({ kind: 'err', text: '充值订单服务未运行，暂时不能下单' })}`,
      )
    }

    const options = topup.options()
    const page = topup.listMine(ctx.user.userId, ORDER_LIST_LIMIT)

    // 下单后 303 回来带 ?order=<单号>：把「怎么付」的说明放在最显眼的位置。
    const detailOrderNo = ctx.query.get('order')
    let detail = ''
    if (detailOrderNo !== null && detailOrderNo !== '') {
      try {
        const order = topup.getMine(ctx.user.userId, detailOrderNo)
        detail = [
          t.renderSectionTitle(`订单 ${order.orderNo}`),
          `<div class="panel panel--pad-wide">`,
          `<p class="p--tight">金额 <strong>${t.escapeText(formatYuan(order.amountMicro))}</strong>` +
            ` · 状态 ${t.renderBadge(STATUS_LABEL[order.status] ?? order.status, STATUS_TONE[order.status] ?? 'err')}</p>`,
          `<p class="p--tight">${t.escapeText(order.instructions ?? '请联系管理员确认到账。')}</p>`,
          `<p class="page-note p--flush">单号 <code class="mono">${t.escapeText(order.orderNo)}</code>` +
            ` · 请在 ${t.escapeText(shortTime(order.expiresAt))} UTC 前完成转账</p>`,
          `</div>`,
        ].join('\n')
      } catch {
        detail = t.renderNotice({ kind: 'err', text: '没有找到这笔充值订单' })
      }
    }

    const rows = page.items.map((order) => [
      `<code class="mono">${t.escapeText(order.orderNo)}</code>`,
      t.escapeText(formatYuan(order.amountMicro)),
      t.renderBadge(STATUS_LABEL[order.status] ?? order.status, STATUS_TONE[order.status] ?? 'err'),
      t.escapeText(order.providerLabel),
      t.escapeText(shortTime(order.createdAt)),
      order.status === 'pending'
        ? `<form class="inline-form" method="post" action="/console/top-up?action=cancel" data-confirm="取消后这笔订单不能再确认到账，确定？">
<input type="hidden" name="orderNo" value="${t.escapeAttr(order.orderNo)}">
<button class="btn small" type="submit">取消</button>
</form>`
        : t.escapeText(STATUS_LABEL[order.status] ?? order.status),
    ])

    return renderConsoleShell(
      ctx,
      [
        header,
        t.renderStatCards(
          [
            { label: '当前余额', value: formatYuan(ctx.user.user.balance), unit: 'CNY' },
            { label: '单笔范围', value: `${formatYuan(options.minAmountMicros)} ~ ${formatYuan(options.maxAmountMicros)}` },
            { label: '支付方式', value: options.providerLabel },
          ],
          'balances',
        ),
        detail,
        `<form class="form form--wide form--spaced" method="post" action="/console/top-up?action=create">
<div class="row">
${t.renderField({
  label: `充值金额（元，${formatYuan(options.minAmountMicros)} ~ ${formatYuan(options.maxAmountMicros)}）`,
  name: 'amountYuan',
  inputmode: 'decimal',
  required: true,
  placeholder: '例如：100',
  hint: `最多 6 位小数；订单 ${options.expiresMinutes} 分钟内有效`,
})}
${t.renderField({ label: '备注（可选）', name: 'note', required: false, placeholder: '例如：对公转账尾号 1234' })}
<div class="actions"><button class="btn" type="submit">创建订单</button></div>
</div>
</form>`,
        t.renderSectionTitle('我的充值订单'),
        t.renderTable({
          columns: [
            { label: '单号' },
            { label: '金额', align: 'right' },
            { label: '状态' },
            { label: '支付方式' },
            { label: '创建时间（UTC）' },
            { label: '操作' },
          ],
          rows,
          empty: '还没有充值订单',
        }),
      ].join('\n'),
    )
  },

  actions: {
    create: async (ctx) => {
      const topup = ctx.services.topup
      if (topup === undefined) throw new WebError('WEB_NO_TOPUP', '充值订单服务未运行')
      const amountYuan = requiredString(ctx.form, 'amountYuan', '充值金额')
      const note = optionalString(ctx.form, 'note')
      const created = await topup.createOrder({
        userId: ctx.user.userId,
        amountYuan,
        ...(note === undefined ? {} : { note }),
      })
      const text = `订单 ${created.order.orderNo} 已创建：请按页面说明转账，管理员确认后到账`
      return `/console/top-up?ok=${encodeURIComponent(text)}&order=${encodeURIComponent(created.order.orderNo)}`
    },

    cancel: async (ctx) => {
      const topup = ctx.services.topup
      if (topup === undefined) throw new WebError('WEB_NO_TOPUP', '充值订单服务未运行')
      const orderNo = requiredString(ctx.form, 'orderNo', '订单号')
      topup.cancelMine(ctx.user.userId, orderNo)
      return `/console/top-up?ok=${encodeURIComponent(`订单 ${orderNo} 已取消`)}`
    },
  },
}
