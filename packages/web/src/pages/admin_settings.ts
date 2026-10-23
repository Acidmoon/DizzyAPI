/** 管理台 · 设置：只读展示各命名空间；写入仍由设置面板 / settings 服务负责。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'

export const adminSettingsPage: PageModule = {
  path: '/admin/settings',
  area: 'admin',
  title: '设置',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const settings = ctx.services.settings
    if (settings === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '设置') + t.renderNotice({ kind: 'err', text: '设置服务未运行' }))
    }
    const namespaces = await settings.describe()
    const blocks = namespaces.map((ns) => {
      const rows = ns.fields.map((field) => [
        t.escapeText(field.path),
        t.escapeText(field.label),
        t.escapeText(field.kind),
        field.secret === true
          ? t.renderBadge(field.configured === true ? '已配置' : '未配置', field.configured === true ? 'ok' : 'warn')
          : t.escapeText(field.value === undefined || field.value === null ? '—' : String(field.value)),
        field.writable ? t.renderBadge('可写', 'ok') : t.renderBadge('只读'),
      ])
      const table = t.renderTable({
        columns: [{ label: '字段' }, { label: '名称' }, { label: '类型' }, { label: '当前值' }, { label: '写' }],
        rows,
        empty: '没有字段',
      })
      const badges = [
        ns.active ? t.renderBadge('活动', 'ok') : t.renderBadge('未活动'),
        ns.overridden ? t.renderBadge('有覆盖', 'ok') : '',
        ns.pending ? t.renderBadge('待应用', 'warn') : '',
      ].filter((item) => item !== '').join(' ')
      return `${t.renderSectionTitle(ns.ns)}<p class="muted">${t.escapeText(ns.plugin)} · ${badges}${ns.revision === null ? '' : ` · revision ${t.escapeText(ns.revision)}`}</p>${table}`
    })
    return renderAdminShell(ctx, [
      pageHeader(ctx, '设置', '秘密字段只显示状态，不回显值。'),
      ...(blocks.length === 0 ? [t.renderEmpty('没有可展示的命名空间')] : blocks),
    ].join('\n'))
  },
}
