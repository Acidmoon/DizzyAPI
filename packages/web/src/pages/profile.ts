/** 个人资料：用户名、头像、改密码、界面偏好（字号 / 字距）。 */
import { ADMIN_NAV, CONSOLE_NAV, pageHeader, renderConsoleShell, type PageModule } from '../layout.ts'
import { requiredString, WebError } from '../forms.ts'
import { normalizeNavOrder, splitNavOrder } from '../nav-order.ts'
import {
  DEFAULT_THEME_PREFERENCES,
  FONT_SCALE_VALUES,
  LETTER_SPACING_EM,
} from '@dizzyapi/plugin-page-template'

/** 字号档位的中文标签（与 `FONT_SCALE_VALUES` 一一对应）。 */
const FONT_SCALE_LABELS: Readonly<Record<string, string>> = {
  '0.875': '小（正文 14px）',
  '1': '标准（正文 16px）— 默认',
  '1.25': '大（正文 20px）',
  '1.5': '特大（正文 24px）',
}

const LETTER_SPACING_LABELS: Readonly<Record<string, string>> = {
  tight: '紧凑',
  normal: '标准 — 默认',
  wide: '宽松',
}

export const profilePage: PageModule = {
  path: '/console/profile',
  area: 'console',
  title: '个人资料',
  auth: true,

  async render(ctx) {
    const t = ctx.t
    const user = ctx.user.user
    const avatar = ctx.t.renderBadge(user.avatar === null ? '未设置' : '已设置')
    // 偏好读不到只回落默认——这一块绝不能把整页拖挂（`getUiPreferences` 本身也不抛）。
    const users = ctx.services.user
    const preferences = users === undefined
      ? DEFAULT_THEME_PREFERENCES
      : await users.getUiPreferences(ctx.user.userId).catch(() => DEFAULT_THEME_PREFERENCES)
    const fontScaleOptions = FONT_SCALE_VALUES.map((value) => ({
      value: String(value),
      label: FONT_SCALE_LABELS[String(value)] ?? String(value),
      selected: value === preferences.fontScale,
    }))
    const spacingOptions = Object.keys(LETTER_SPACING_EM).map((key) => ({
      value: key,
      label: LETTER_SPACING_LABELS[key] ?? key,
      selected: key === preferences.letterSpacing,
    }))
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
      t.renderSectionTitle('界面偏好'),
      `<p class="page-note p--tight">只影响你自己：字号与字距按账号保存，换设备也一致。</p>
<form class="form form--inline" method="post" action="/console/profile?action=appearance">
<div class="field"><label for="f-fontScale">字号</label>${t.renderSelect({ name: 'fontScale', id: 'f-fontScale', allowEmpty: false, options: fontScaleOptions })}</div>
<div class="field"><label for="f-letterSpacing">字距</label>${t.renderSelect({ name: 'letterSpacing', id: 'f-letterSpacing', allowEmpty: false, options: spacingOptions })}</div>
<div class="actions"><button class="btn" type="submit">保存偏好</button><button class="btn small" type="submit" name="reset" value="1">恢复默认</button></div>
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

    appearance: async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      // 「恢复默认」= 同一张表单多带一个 reset 字段：不新增路由，也不做 GET 副作用
      // （GET 会带来「预取 / 爬虫改设置」那一类问题）。
      if (ctx.form.get('reset') === '1') {
        await users.setUiPreferences(ctx.user.userId, { ...DEFAULT_THEME_PREFERENCES })
        return '/console/profile?ok=' + encodeURIComponent('界面偏好已恢复默认')
      }
      const fontScale = ctx.form.get('fontScale') ?? ''
      const letterSpacing = ctx.form.get('letterSpacing') ?? ''
      // 非法值由 user 插件校验后抛 `USER_UI_PREFERENCES_INVALID`，页面给人话。
      await users.setUiPreferences(ctx.user.userId, {
        fontScale: Number(fontScale),
        letterSpacing,
      })
      return '/console/profile?ok=' + encodeURIComponent('界面偏好已保存')
    },

    password: async (ctx) => {
      const auth = ctx.services.auth
      if (auth === undefined) throw new WebError('WEB_NO_AUTH', '鉴权服务未运行')
      const currentPassword = requiredString(ctx.form, 'currentPassword', '当前密码')
      const newPassword = requiredString(ctx.form, 'newPassword', '新密码')
      await auth.changePassword({ token: ctx.token, currentPassword, newPassword })
      return '/console/profile?ok=' + encodeURIComponent('密码已更新')
    },

    /**
     * 侧栏拖动排序落库（第 12 条）。
     *
     * 由 `client-nav-order.ts` 用 `fetch` 调用，带 `X-Requested-With: dizzyapi`，
     * 所以 `handleAction` 会回 204 而不是 303（避免 fetch 跟着重定向把整页拉一遍）。
     *
     * 校验分两层，**各自干自己懂的**：
     * - 这里只知道「哪些路径属于这次拖动的区域」（`CONSOLE_NAV` / `ADMIN_NAV`），
     *   所以只过滤未知路径；
     * - 「是不是合法路径、要不要去重限长」是数据层的事，交给 `user` 插件。
     *
     * 落库失败直接抛：前端会 `catch` 到并**回滚成服务端顺序**（不许只改 DOM 假装成功）。
     */
    'nav-order': async (ctx) => {
      const users = ctx.services.user
      if (users === undefined) throw new WebError('WEB_NO_USER', '用户服务未运行')
      const area = ctx.form.get('area') === 'admin' ? 'admin' : 'console'
      const defaults = area === 'admin' ? ADMIN_NAV : CONSOLE_NAV
      const submitted = splitNavOrder(ctx.form.get('navOrder'))
      await users.setUiPreferences(ctx.user.userId, { navOrder: normalizeNavOrder(defaults, submitted) })
      return '/console/profile?ok=' + encodeURIComponent('侧栏顺序已保存')
    },
  },
}
