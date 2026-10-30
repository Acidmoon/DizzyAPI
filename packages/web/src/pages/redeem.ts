/**
 * 兑换：输入兑换码加余额（表单 POST + 303 PRG），并显示「我的兑换记录」。
 *
 * 结果与当前余额都从服务取值后渲染：兑换成功后 303 回本页，金额进 `ok` 提示，
 * 余额由会话里的用户视图给出（`user` 是余额唯一写者，本页不自己算）。
 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { formatYuan, requiredString, WebError } from '../forms.ts'

export const redeemPage: PageModule = {
  path: '/console/redeem',
  area: 'console',
  title: '兑换',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const header = pageHeader(
      ctx,
      '兑换',
      '兑换码只在兑换成功时增加余额；余额按整数微元记账（1 元 = 1,000,000 微元）。',
    )
    const redeem = ctx.services.redeem
    if (redeem === undefined) {
      return renderConsoleShell(
        ctx,
        `${header}\n${t.renderNotice({ kind: 'err', text: '兑换码服务未运行，暂时无法兑换' })}`,
      )
    }

    const balanceCards = t.renderStatCards(
      [{ label: '当前余额', value: formatYuan(ctx.user.user.balance), unit: 'CNY' }],
      'balances',
    )

    let items: Awaited<ReturnType<typeof redeem.listMyRedemptions>>
    try {
      items = await redeem.listMyRedemptions(ctx.user.userId, 20)
    } catch {
      return renderConsoleShell(
        ctx,
        `${header}\n${t.renderNotice({ kind: 'err', text: '兑换记录读取失败，请稍后再试' })}`,
      )
    }

    const rows = items.map((item) => [
      `<code class="mono">${t.escapeText(item.codeMask)}</code>`,
      t.escapeText(formatYuan(item.amountMicro)),
      t.escapeText(item.batchName ?? '—'),
      t.escapeText(item.redeemedAt === null ? '—' : item.redeemedAt.slice(0, 19).replace('T', ' ')),
      t.renderBadge('已兑换', 'ok'),
    ])

    return renderConsoleShell(
      ctx,
      [
        header,
        balanceCards,
        `<form class="form form--wide form--spaced" method="post" action="/console/redeem?action=redeem">
<div class="row">
${t.renderField({
  label: '兑换码',
  name: 'code',
  required: true,
  placeholder: '例如：ABCD-EFGH-JKMN',
  hint: '不区分大小写，分隔符可以省略',
})}
<div class="actions"><button class="btn" type="submit">兑换</button></div>
</div>
</form>`,
        t.renderSectionTitle('我的兑换记录'),
        t.renderTable({
          columns: [
            { label: '兑换码' },
            { label: '额度', align: 'right' },
            { label: '批次' },
            { label: '兑换时间' },
            { label: '状态' },
          ],
          rows,
          empty: '还没有兑换记录',
        }),
      ].join('\n'),
    )
  },

  actions: {
    redeem: async (ctx) => {
      const redeem = ctx.services.redeem
      if (redeem === undefined) throw new WebError('WEB_NO_REDEEM', '兑换码服务未运行')
      const code = requiredString(ctx.form, 'code', '兑换码')
      const result = await redeem.redeemCode({ userId: ctx.user.userId, code })
      const text = `兑换成功：${formatYuan(result.amount)} 已到账，当前余额 ${formatYuan(result.balance)}`
      return `/console/redeem?ok=${encodeURIComponent(text)}`
    },
  },
}
