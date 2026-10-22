/** 管理台 · 上游账号：列表、启停、连通性测试。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'

export const adminAccountsPage: PageModule = {
  path: '/admin/accounts',
  area: 'admin',
  title: '上游账号',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const admin = ctx.services.accountAdmin
    if (admin === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '上游账号') + t.renderNotice({ kind: 'err', text: '账号服务未运行' }))
    }
    const accounts = admin.list()
    const rows = accounts.map((account) => {
      const toggle = `<form class="inline-form" method="post" action="/admin/accounts?action=toggle">
<input type="hidden" name="id" value="${t.escapeAttr(account.id)}">
<input type="hidden" name="enabled" value="${account.enabled ? '0' : '1'}">
<button class="btn small" type="submit">${account.enabled ? '停用' : '启用'}</button></form>`
      const test = `<form class="inline-form" method="post" action="/admin/accounts?action=test">
<input type="hidden" name="id" value="${t.escapeAttr(account.id)}">
<button class="btn small" type="submit">测试连接</button></form>`
      const testState = account.lastTestOk === null
        ? '未测试'
        : account.lastTestOk
          ? `成功 ${account.lastTestLatencyMs ?? 0}ms`
          : `失败：${account.lastTestError ?? '未知错误'}`
      return [
        t.escapeText(account.label),
        t.escapeText(`${account.provider} / ${account.kind}`),
        account.enabled ? t.renderBadge('启用', 'ok') : t.renderBadge('停用'),
        account.credentialConfigured ? t.renderBadge('已配置', 'ok') : t.renderBadge('缺凭据', 'warn'),
        String(account.priority),
        t.escapeText(testState),
        `<div class="actions">${toggle}${test}</div>`,
      ]
    })

    return renderAdminShell(ctx, [
      pageHeader(ctx, '上游账号', '测试会向上游发一条最小真实请求，结果写回账号。'),
      t.renderTable({
        columns: [
          { label: '名称' },
          { label: '类型' },
          { label: '状态' },
          { label: '凭据' },
          { label: '优先级', align: 'right' },
          { label: '最近测试' },
          { label: '操作' },
        ],
        rows,
        empty: '还没有上游账号',
      }),
    ].join('\n'))
  },

  actions: {
    toggle: async (ctx) => {
      const admin = ctx.services.accountAdmin
      if (admin === undefined) throw new WebError('WEB_NO_ACCOUNT', '账号服务未运行')
      const id = requiredString(ctx.form, 'id', '账号')
      await admin.update(id, { enabled: ctx.form.get('enabled') === '1' })
      return '/admin/accounts?ok=' + encodeURIComponent('账号状态已更新')
    },

    test: async (ctx) => {
      const admin = ctx.services.accountAdmin
      if (admin === undefined) throw new WebError('WEB_NO_ACCOUNT', '账号服务未运行')
      const id = requiredString(ctx.form, 'id', '账号')
      const result = await admin.testConnection(id)
      const message = result.ok ? `连接成功（${result.latencyMs}ms）` : `连接失败：${result.error ?? '未知错误'}`
      return `/admin/accounts?${result.ok ? 'ok' : 'err'}=${encodeURIComponent(message)}`
    },
  },
}
