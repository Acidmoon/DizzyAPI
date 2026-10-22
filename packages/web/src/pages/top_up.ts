/** 充值：支付模块未实现前保持占位，不伪造到账。 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'

export const topUpPage: PageModule = {
  path: '/console/top-up',
  area: 'console',
  title: '充值',
  auth: true,

  async render(ctx) {
    return renderConsoleShell(ctx, [
      pageHeader(ctx, '充值'),
      ctx.t.renderNotice({ kind: 'info', text: '在线充值与对公汇款尚未接入；当前不产生任何订单或余额变更。' }),
      ctx.t.renderEmpty('支付模块完成后，这里会显示金额选项与支付方式。'),
    ].join('\n'))
  },
}
