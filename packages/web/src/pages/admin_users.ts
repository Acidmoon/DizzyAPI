/** 管理台 · 用户：列表、启停、角色、余额调整、删除。 */
import { pageHeader, renderAdminShell, type PageModule } from '../layout.ts'
import { formatYuan, requiredString, WebError } from '../forms.ts'
import { WEB_ACTOR } from '../runtime.ts'
import { auditedAction } from '../audit.ts'

export const adminUsersPage: PageModule = {
  path: '/admin/users',
  area: 'admin',
  title: '用户',
  auth: true,
  admin: true,

  async render(ctx) {
    const t = ctx.t
    const users = ctx.services.user
    if (users === undefined) {
      return renderAdminShell(ctx, pageHeader(ctx, '用户') + t.renderNotice({ kind: 'err', text: '用户服务未运行' }))
    }
    const list = await users.list({ limit: 100 })
    const rows = list.map((user) => {
      const toggle = `<form class="inline-form" method="post" action="/admin/users?action=status">
<input type="hidden" name="id" value="${user.id}"><input type="hidden" name="status" value="${user.status === 'enabled' ? 'banned' : 'enabled'}">
<button class="btn small" type="submit">${user.status === 'enabled' ? '封禁' : '启用'}</button></form>`
      const role = `<form class="inline-form" method="post" action="/admin/users?action=role">
<input type="hidden" name="id" value="${user.id}"><input type="hidden" name="role" value="${user.role === 'admin' ? 'user' : 'admin'}">
<button class="btn small" type="submit">${user.role === 'admin' ? '降为用户' : '设为管理员'}</button></form>`
      const remove = `<form class="inline-form" method="post" action="/admin/users?action=remove" data-confirm="删除用户不可恢复，确定？">
<input type="hidden" name="id" value="${user.id}">
<button class="btn small danger" type="submit">删除</button></form>`
      return [
        String(user.id),
        t.escapeText(user.name),
        user.role === 'admin' ? t.renderBadge('管理员', 'ok') : t.renderBadge('用户'),
        user.status === 'enabled' ? t.renderBadge('正常', 'ok') : t.renderBadge('已封禁', 'err'),
        t.escapeText(formatYuan(user.balance)),
        `<div class="actions">${toggle}${role}${remove}</div>`,
      ]
    })

    return renderAdminShell(ctx, [
      pageHeader(ctx, '用户', `共 ${list.length} 个用户；余额以整数微元存储。`),
      t.renderTable({
        columns: [
          { label: 'ID' },
          { label: '名称' },
          { label: '角色' },
          { label: '状态' },
          { label: '余额', align: 'right' },
          { label: '操作' },
        ],
        rows,
        empty: '还没有用户',
      }),
      t.renderSectionTitle('调整余额'),
      `<form class="form" method="post" action="/admin/users?action=balance">
<div class="row">
${t.renderField({ label: '用户 ID', name: 'id', required: true })}
${t.renderField({ label: '增减（元）', name: 'deltaYuan', required: true, placeholder: '10 或 -5.5' })}
${t.renderField({ label: '原因', name: 'reason', required: true, placeholder: '例如：充值' })}
<div class="actions"><button class="btn" type="submit">提交</button></div>
</div>
</form>`,
    ].join('\n'))
  },

  actions: {
    status: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      const status = ctx.form.get('status') === 'banned' ? 'banned' : 'enabled'
      await auditedAction(
        ctx,
        {
          action: 'user.status.set',
          targetType: 'user',
          targetId: String(id),
          summary: `把用户 #${id} 的状态改为 ${status}`,
          metadata: { status },
        },
        () => users.setStatus(WEB_ACTOR, id, status),
      )
      return '/admin/users?ok=' + encodeURIComponent('状态已更新')
    },

    role: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      const role = ctx.form.get('role') === 'admin' ? 'admin' : 'user'
      await auditedAction(
        ctx,
        {
          action: 'user.role.set',
          targetType: 'user',
          targetId: String(id),
          summary: `把用户 #${id} 的角色改为 ${role}`,
          metadata: { role },
        },
        () => users.setRole(WEB_ACTOR, id, role),
      )
      return '/admin/users?ok=' + encodeURIComponent('角色已更新')
    },

    balance: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      const deltaYuan = requiredString(ctx.form, 'deltaYuan', '增减金额')
      const reason = requiredString(ctx.form, 'reason', '原因')
      const delta = parseYuanToMicros(deltaYuan)
      await auditedAction(
        ctx,
        {
          action: 'user.balance.adjust',
          targetType: 'user',
          targetId: String(id),
          summary: `调整用户 #${id} 的余额（${deltaYuan} 元）：${reason}`,
          // 金额一律整数最小单位：变化量与变动后余额都记十进制字符串。
          metadata: { deltaMicros: delta.toString(), reason },
          metadataOf: (after) => ({ balanceAfterMicros: after.toString() }),
        },
        () => users.adjustBalance(WEB_ACTOR, id, delta, reason),
      )
      return '/admin/users?ok=' + encodeURIComponent('余额已调整')
    },

    remove: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const id = Number(requiredString(ctx.form, 'id', '用户 ID'))
      await auditedAction(
        ctx,
        {
          action: 'user.remove',
          targetType: 'user',
          targetId: String(id),
          summary: `删除用户 #${id}`,
        },
        () => users.remove(WEB_ACTOR, id),
      )
      return '/admin/users?ok=' + encodeURIComponent('用户已删除')
    },
  },
}

/** `10` / `-5.5` → 微元；拒绝超过两位小数。 */
function parseYuanToMicros(text: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) throw new WebError('WEB_BAD_AMOUNT', '金额最多两位小数')
  const negative = text.startsWith('-')
  const [yuan, fraction = ''] = (negative ? text.slice(1) : text).split('.')
  const micros = BigInt(yuan) * 1_000_000n + BigInt(fraction.padEnd(2, '0')) * 10_000n
  return negative ? -micros : micros
}
