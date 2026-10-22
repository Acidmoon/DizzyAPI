/** 账单：数据来自余额流水，暂无独立账单域。 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'

export const transactionsPage: PageModule = {
  path: '/console/transactions',
  area: 'console',
  title: '账单',
  auth: true,

  async render(ctx) {
    return renderConsoleShell(ctx, [
      pageHeader(ctx, '账单'),
      ctx.t.renderNotice({ kind: 'info', text: '账单 / 发票模块尚未实现；余额变更可在用户管理中查看流水。' }),
      ctx.t.renderEmpty('暂无可展示的账单。'),
    ].join('\n'))
  },
}
