/** 管理台 · 插件目录：只读快照。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'

export const adminCatalogPage: PageModule = {
  path: '/admin/catalog',
  area: 'admin',
  title: '插件目录',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const catalog = ctx.services.catalog
    if (catalog === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '插件目录') + t.renderNotice({ kind: 'err', text: '目录服务未运行' }))
    }
    const snapshot = await catalog.snapshot()
    const rows = snapshot.plugins.map((plugin) => [
      t.escapeText(plugin.id),
      t.escapeText(plugin.name ?? '—'),
      t.escapeText(plugin.status ?? '—'),
      t.escapeText((plugin.capabilities ?? []).join(', ') || '—'),
    ])
    return renderAdminShell(ctx, [
      pageHeader(ctx, '插件目录', `共 ${snapshot.plugins.length} 个插件。`),
      t.renderTable({
        columns: [{ label: 'ID' }, { label: '名称' }, { label: '状态' }, { label: '能力' }],
        rows,
        empty: '没有插件',
      }),
    ].join('\n'))
  },
}
