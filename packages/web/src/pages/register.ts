/** 注册页：先申请验证码，再确认。两步共用一个文件。 */
import { fontCssOf, renderAuthShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { sessionCookie } from '../session.ts'

export const registerPage: PageModule = {
  path: '/register',
  area: 'console',
  title: '注册',
  auth: false,

  async render(ctx) {
    const t = ctx.t
    const confirm = ctx.query.get('step') === 'confirm'
    const email = ctx.query.get('email') ?? ''

    if (confirm) {
      return renderAuthShell(t, {
      fontCss: fontCssOf(ctx),
        title: '输入验证码',
        subtitle: `验证码已发往 ${email || '你的邮箱'}，10 分钟内有效。`,
        content: `<form class="form" method="post" action="/register?action=confirm">
<input type="hidden" name="email" value="${t.escapeAttr(email)}">
${t.renderField({ label: '验证码', name: 'code', required: true, autocomplete: 'one-time-code', hint: '6 位数字' })}
<div class="actions"><button class="btn" type="submit">完成注册</button></div>
</form>`,
        footer: `<span>没收到？</span><a href="/register">重新填写</a>`,
      })
    }

    return renderAuthShell(t, {
      fontCss: fontCssOf(ctx),
      title: '注册 DizzyAPI',
      subtitle: '验证码会发到邮箱；首个注册用户自动成为管理员。',
      content: `<form class="form" method="post" action="/register?action=request">
${t.renderField({ label: '邮箱', name: 'email', type: 'email', required: true, autocomplete: 'email' })}
${t.renderField({ label: '用户名', name: 'name', autocomplete: 'nickname' })}
${t.renderField({ label: '密码', name: 'password', type: 'password', required: true, autocomplete: 'new-password', hint: '至少 8 位' })}
<div class="actions"><button class="btn" type="submit">发送验证码</button></div>
</form>`,
      footer: `<span>已有账号？</span><a href="/login">登录</a>`,
    })
  },

  actions: {
    request: async (ctx) => {
      const auth = ctx.services.auth
      if (auth === undefined) throw new WebError('WEB_NO_AUTH', '鉴权服务未运行')
      const email = requiredString(ctx.form, 'email', '邮箱')
      const password = requiredString(ctx.form, 'password', '密码')
      const name = ctx.form.get('name')?.trim() || undefined
      await auth.requestRegistration({ email, password, ...(name === undefined ? {} : { name }) })
      return `/register?step=confirm&email=${encodeURIComponent(email)}`
    },

    confirm: async (ctx) => {
      const auth = ctx.services.auth
      if (auth === undefined) throw new WebError('WEB_NO_AUTH', '鉴权服务未运行')
      const email = requiredString(ctx.form, 'email', '邮箱')
      const code = requiredString(ctx.form, 'code', '验证码')
      const result = await auth.confirmRegistration({ email, code })
      ctx.setCookie(sessionCookie(ctx.cookieName, result.token, result.expiresAt, ctx.secure))
      return '/console/usage'
    },
  },
}
