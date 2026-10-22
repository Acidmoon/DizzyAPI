/** 个人资料：用户名、头像、改密码。 */
import { pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'

export const profilePage: PageModule = {
  path: '/console/profile',
  area: 'console',
  title: '个人资料',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const user = ctx.user.user
    const avatar = ctx.t.renderBadge(user.avatar === null ? '未设置' : '已设置')
    return renderConsoleShell(ctx, [
      pageHeader(ctx, '个人资料'),
      t.renderStatCards([
        { label: '用户 ID', value: String(user.id) },
        { label: '角色', value: user.role === 'admin' ? '管理员' : '用户' },
        { label: '状态', value: user.status === 'enabled' ? '正常' : '已封禁' },
      ], 'metrics'),
      t.renderSectionTitle('基本资料'),
      `<form class="form" method="post" action="/console/profile?action=profile">
${t.renderField({ label: '用户名', name: 'name', value: user.name, required: true })}
${t.renderField({ label: '头像 URL', name: 'avatar', value: user.avatar ?? '', placeholder: 'https://…', hint: '只接受 http(s) 链接；留空清除' })}
<div class="actions"><button class="btn" type="submit">保存</button>${avatar}</div>
</form>`,
      t.renderSectionTitle('修改密码'),
      `<form class="form" method="post" action="/console/profile?action=password">
${t.renderField({ label: '当前密码', name: 'currentPassword', type: 'password', required: true, autocomplete: 'current-password' })}
${t.renderField({ label: '新密码', name: 'newPassword', type: 'password', required: true, autocomplete: 'new-password', hint: '至少 8 位' })}
<div class="actions"><button class="btn" type="submit">更新密码</button></div>
</form>`,
    ].join('\n'))
  },

  actions: {
    profile: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const name = requiredString(ctx.form, 'name', '用户名')
      const avatar = ctx.form.get('avatar')?.trim() ?? ''
      await users.updateProfile(ctx.user.userId, { name, avatar: avatar === '' ? null : avatar })
      return '/console/profile?ok=' + encodeURIComponent('资料已保存')
    },

    password: async (ctx) => {
      const auth = ctx.services.auth
      if (auth === undefined) throw new WebError('WEB_NO_AUTH', '鉴权服务未运行')
      const currentPassword = requiredString(ctx.form, 'currentPassword', '当前密码')
      const newPassword = requiredString(ctx.form, 'newPassword', '新密码')
      await auth.changePassword({ token: ctx.token, currentPassword, newPassword })
      return '/console/profile?ok=' + encodeURIComponent('密码已更新')
    },
  },
}
