/** API keys：列表、创建、启停、轮换、删除。 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'

export const keysPage: PageModule = {
  path: '/console/api-keys',
  area: 'console',
  title: 'API keys',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const keys = ctx.services.apiKey
    if (keys === undefined) {
      return renderConsoleShell(ctx, pageHeader(ctx, 'API keys') + t.renderNotice({ kind: 'err', text: 'API key 服务未运行' }))
    }
    const items = await keys.list(ctx.user.userId)
    const secret = ctx.query.get('new') === undefined ? undefined : ctx.takeSecret()

    const secretBlock = secret === undefined
      ? ''
      : `${t.renderNotice({ kind: 'ok', text: '新的 API key 已生成，只显示这一次，请立即保存。' })}
<div class="panel" style="padding:16px;margin-bottom:24px"><code class="mono">${t.escapeText(secret)}</code></div>`

    const rows = items.map((key) => {
      const toggle = `<form class="inline-form" method="post" action="/console/api-keys?action=toggle">
<input type="hidden" name="id" value="${t.escapeAttr(key.id)}">
<input type="hidden" name="enabled" value="${key.enabled ? '0' : '1'}">
<button class="btn small" type="submit">${key.enabled ? '停用' : '启用'}</button></form>`
      const rotate = `<form class="inline-form" method="post" action="/console/api-keys?action=rotate" data-confirm="轮换后旧 key 立即失效，确定？">
<input type="hidden" name="id" value="${t.escapeAttr(key.id)}">
<button class="btn small" type="submit">轮换</button></form>`
      const remove = `<form class="inline-form" method="post" action="/console/api-keys?action=remove" data-confirm="删除后不可恢复，确定？">
<input type="hidden" name="id" value="${t.escapeAttr(key.id)}">
<button class="btn small danger" type="submit">删除</button></form>`
      return [
        t.escapeText(key.name),
        `<code class="mono">${t.escapeText(key.masked)}</code>`,
        key.enabled ? t.renderBadge('启用', 'ok') : t.renderBadge('停用'),
        t.escapeText(key.createdAt.slice(0, 10)),
        t.escapeText(key.lastUsedAt === null ? '—' : key.lastUsedAt.slice(0, 10)),
        `<div class="actions">${toggle}${rotate}${remove}</div>`,
      ]
    })

    return renderConsoleShell(ctx, [
      pageHeader(ctx, 'API keys', '完整 key 只在创建 / 轮换时显示一次；列表里随时可复制。'),
      secretBlock,
      `<form class="form" method="post" action="/console/api-keys?action=create" style="max-width:none;margin-bottom:24px">
<div class="row">
${t.renderField({ label: '名称', name: 'name', required: true, placeholder: '例如：本地开发' })}
<div class="actions"><button class="btn" type="submit">创建 API key</button></div>
</div>
</form>`,
      t.renderTable({
        columns: [
          { label: '名称' },
          { label: 'Key' },
          { label: '状态' },
          { label: '创建' },
          { label: '最近使用' },
          { label: '操作' },
        ],
        rows,
        empty: '还没有 API key',
      }),
    ].join('\n'))
  },

  actions: {
    create: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const name = requiredString(ctx.form, 'name', '名称')
      const created = await keys.create(ctx.user.userId, { name })
      const id = ctx.stashSecret(created.secret)
      return `/console/api-keys?new=${encodeURIComponent(id)}`
    },

    toggle: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      const enabled = ctx.form.get('enabled') === '1'
      await keys.update(ctx.user.userId, id, { enabled })
      return `/console/api-keys?ok=${encodeURIComponent(enabled ? '已启用' : '已停用')}`
    },

    rotate: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      const rotated = await keys.rotate(ctx.user.userId, id)
      const secretId = ctx.stashSecret(rotated.secret)
      return `/console/api-keys?new=${encodeURIComponent(secretId)}`
    },

    remove: async (ctx) => {
      const keys = ctx.services.apiKey
      if (keys === undefined) throw new WebError('WEB_NO_APIKEY', 'API key 服务未运行')
      const id = requiredString(ctx.form, 'id', 'key')
      await keys.remove(ctx.user.userId, id)
      return `/console/api-keys?ok=${encodeURIComponent('已删除')}`
    },
  },
}
