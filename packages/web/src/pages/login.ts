/** 登录页。 */
import { renderAuthShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { sessionCookie } from '../session.ts'

export const loginPage: PageModule = {
  path: '/login',
  area: 'console',
  title: '登录',
  auth: false,

  async render(ctx) {
    const t = ctx.t
    return renderAuthShell(t, {
      title: '登录 DizzyAPI',
      subtitle: '使用注册邮箱和密码登录。',
      content: `<form class="form" method="post" action="/login?action=login">
${t.renderField({ label: '邮箱', name: 'email', type: 'email', required: true, autocomplete: 'username' })}
${t.renderField({ label: '密码', name: 'password', type: 'password', required: true, autocomplete: 'current-password' })}
<div class="actions"><button class="btn" type="submit">登录</button></div>
</form>`,
      footer: `<span>还没有账号？</span><a href="/register">注册</a>`,
    })
  },

  actions: {
    login: async (ctx) => {
      const auth = ctx.services.auth
      if (auth === undefined) throw new WebError('WEB_NO_AUTH', '鉴权服务未运行')
      const email = requiredString(ctx.form, 'email', '邮箱')
      const password = requiredString(ctx.form, 'password', '密码')
      const result = await auth.login({ email, password })
      ctx.setCookie(sessionCookie(ctx.cookieName, result.token, result.expiresAt, ctx.secure))
      return '/console/usage'
    },
  },
}
