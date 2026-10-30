/**
 * 布局：侧栏导航 + 主列外壳。页面只负责主列内容。
 */
import type { PageTemplateService, NavItem } from '@dizzyapi/plugin-page-template'
import { needsTooltips, vendorHref, vendorScriptsFor } from '@dizzyapi/plugin-page-template'
import { APP_JS_HREF, appCssHref, themeCssHref } from './asset-version.ts'
import type { SessionView, WebRuntime } from './runtime.ts'
import { formatYuan } from './forms.ts'
import { applyNavOrder } from './nav-order.ts'

export interface PageContext {
  readonly path: string
  readonly title: string
  readonly query: URLSearchParams
  /** 已登录会话；登录页不经过这里。 */
  readonly user: SessionView
  readonly t: PageTemplateService
  readonly services: WebRuntime
  readonly notice: { readonly kind: 'ok' | 'err'; readonly text: string } | null
  /**
   * 失败动作**属于哪个字段**（`?err=…&field=…` 里的 `field`）。
   *
   * 只带字段名与文案，不带渲染位置：服务端把 `data-field` 交给提示条，
   * 客户端脚本负责把它搬到字段下方（`client-feedback.ts`）。
   * 这样「错误就地显示」不必让 20 多个页面各写一遍。
   */
  readonly fieldError: { readonly field: string; readonly text: string } | null
  /**
   * 当前用户的界面偏好 CSS（`/assets/theme.css` 的正文）。
   *
   * 由 `web` 在构建上下文时按会话读一次（`user.getUiPreferences`），所以渲染层保持纯同步。
   * 未登录 / 没设过偏好时是空串——那种情况下页面**不引用**主题表，等于站 defaults。
   */
  readonly themeCss: string
  /**
   * 当前用户的侧栏顺序（`ui_preferences.navOrder`）。
   *
   * 由 `web` 构建上下文时读一次，渲染层保持纯同步；空数组 = 站默认顺序。
   * 「未知路径丢弃 + 缺的补到末尾」在 `applyNavOrder` 里做（`nav-order.ts`）。
   */
  readonly navOrder: readonly string[]
  /** 一次性 secret：创建 key 后第一次渲染可取出，之后拿不到。 */
  takeSecret(): string | undefined
}

export interface ActionContext extends PageContext {
  readonly form: URLSearchParams
  readonly cookieName: string
  readonly secure: boolean
  /** 当前会话 token（改密码等需要）。 */
  readonly token: string
  setCookie(cookie: string): void
  stashSecret(secret: string): string
}

/** 动作返回重定向地址（PRG）。 */
export type PageAction = (ctx: ActionContext) => Promise<string>

export interface PageModule {
  readonly path: string
  readonly area: 'console' | 'admin'
  readonly title: string
  /** 需要登录。 */
  readonly auth: boolean
  /** 需要管理员。 */
  readonly admin?: boolean
  render(ctx: PageContext): Promise<string>
  readonly actions?: Readonly<Record<string, PageAction>>
}

/** 用户站侧栏的**站默认顺序**（`navOrder` 的唯一真相；新加页面改这里就自动出现）。 */
export const CONSOLE_NAV: readonly { label: string; path: string; icon: NavItem['icon'] }[] = [
  { label: '用量信息', path: '/console/usage', icon: 'bars' },
  { label: '模型广场', path: '/console/models', icon: 'tag' },
  { label: 'API 文档', path: '/console/api-docs', icon: 'doc' },
  { label: 'API keys', path: '/console/api-keys', icon: 'search' },
  { label: '充值', path: '/console/top-up', icon: 'card' },
  { label: '兑换', path: '/console/redeem', icon: 'receipt' },
  { label: '账单', path: '/console/transactions', icon: 'receipt' },
  { label: '个人资料', path: '/console/profile', icon: 'tag' },
]

/** 管理台侧栏的站默认顺序。 */
export const ADMIN_NAV: readonly { label: string; path: string; icon: NavItem['icon'] }[] = [
  { label: '用户', path: '/admin/users', icon: 'search' },
  { label: '上游账号', path: '/admin/accounts', icon: 'doc' },
  { label: '插件目录', path: '/admin/catalog', icon: 'tag' },
  { label: '设置', path: '/admin/settings', icon: 'help' },
  { label: '全站用量', path: '/admin/usage', icon: 'bars' },
  { label: '模型价格', path: '/admin/pricing', icon: 'card' },
  { label: '结算', path: '/admin/billing', icon: 'card' },
  { label: '充值订单', path: '/admin/topup-orders', icon: 'card' },
  { label: '兑换码', path: '/admin/redeem-codes', icon: 'receipt' },
  { label: '操作审计', path: '/admin/audit', icon: 'doc' },
  { label: '内容审核', path: '/admin/content-audit', icon: 'help' },
  { label: '运维总览', path: '/admin/observability', icon: 'bars' },
]

/** 侧栏顺序的落库地址（`profile` 页面的动作）。 */
export const NAV_ORDER_ACTION = '/console/profile?action=nav-order'

function navFor(
  area: 'console' | 'admin',
  current: string,
  navOrder: readonly string[],
): NavItem[] {
  const defaults = area === 'console' ? CONSOLE_NAV : ADMIN_NAV
  return applyNavOrder(defaults, navOrder).map((item) => ({
    label: item.label,
    href: item.path,
    icon: item.icon,
    current: current === item.path,
  }))
}

function userLine(t: PageTemplateService, user: SessionView): string {
  const name = user.user.name
  const balance = user.user.balanceEnabled ? ` · ${formatYuan(user.user.balance)}` : ''
  return `${name}${balance}`
}

/**
 * 样式与脚本走外链，CSP 保持 `'self'`（不放开 inline）。
 *
 * **地址一律带内容哈希**（见 `asset-version.ts`）：这些字节用 `immutable` 发出去，
 * 路径固定就会被浏览器缓存一年，改完样式等于没改。
 */
export const ASSET_JS = APP_JS_HREF

/**
 * 脚本顺序**是契约**（见 `DocumentOptions.assets.jsHrefs` 的注释）：
 * 1. vendor 库按 `VENDOR_SCRIPT_ORDER`（顺序只有那一个源），**只放这一页真的用到的**：
 *    - `boost`：整页外壳（有侧栏）= htmx 的局部刷新；登录 / 注册卡没有侧栏，不引；
 *    - `tooltips`：主列里真有 `data-tooltip` 才引 floating-ui（22 KB）。
 * 2. `/assets/app.js` **必须最后**：它初始化控件，并在 htmx 已加载的前提下把
 *    `htmx.config.includeIndicatorStyles` 关掉。顺序反过来 htmx 会注入内联 `<style>`（被 CSP 拦）。
 */
function docScripts(options: { readonly boost?: boolean; readonly tooltips?: boolean }): readonly string[] {
  return [
    ...vendorScriptsFor(options).map((name) => vendorHref(name)),
    ASSET_JS,
  ]
}

/**
 * 页面文档级的 assets（**导出版**：`web` 渲染 404 时没有 `PageContext`，自己算字体 CSS）。
 *
 * `cssHref` 必须**按当前字体 CSS 惰性算**：`/assets/app.css` 的正文末尾会追加
 * `fontSmiley.css()`，字体块一变（改 `scope` / 换字体字节）地址就得变，否则 `immutable`
 * 缓存会让回访浏览器一直用旧 CSS。脚本地址是常量（正文不含运行时内容）。
 *
 * @param options.boost 这一页有没有侧栏（决定要不要引 htmx）。
 * @param options.tooltips 这一页里有没有 `data-tooltip`（决定要不要引 Floating UI）。
 *        调用方用 `needsTooltips(body)` 从**已渲染的 HTML** 判，不靠页面清单。
 */
export function documentAssets(
  fontCss: string,
  themeCss = '',
  options: { readonly boost?: boolean; readonly tooltips?: boolean } = {},
): {
  cssHref: string
  themeCssHref?: string
  jsHrefs: readonly string[]
} {
  return {
    cssHref: appCssHref(fontCss),
    // 主题表按用户生成，地址同样走内容哈希（与 app.css 同一套规则，见 asset-version.ts）；
    // 空偏好时干脆不引用，省一个请求。
    ...(themeCss === '' ? {} : { themeCssHref: themeCssHref(themeCss) }),
    jsHrefs: docScripts(options),
  }
}

/** 当前页面该用的字体 CSS（没装载 font-smiley 时为空串）。 */
export function fontCssOf(ctx: PageContext): string {
  const font = ctx.services.fontSmiley
  return font === undefined ? '' : font.css()
}

/** 用户站外壳。 */
export function renderConsoleShell(ctx: PageContext, content: string): string {
  const isAdmin = ctx.user.user.role === 'admin'
  const title = `${ctx.title} · DizzyAPI`
  return ctx.t.renderDocument({
    title,
    // htmx 跟着侧栏走：这一页有侧栏，就有 `hx-boost` 的链接。
    assets: documentAssets(fontCssOf(ctx), ctx.themeCss, { boost: true, tooltips: needsTooltips(content) }),
    body: ctx.t.renderShell({
      brand: { word: 'Dizzy', badge: 'API', href: '/console/usage' },
      nav: navFor('console', ctx.path, ctx.navOrder),
      foot: [
        ...(isAdmin ? [{ label: '管理台', href: '/admin/users', icon: 'doc' as const }] : []),
        { label: '退出登录', href: '/logout', icon: 'help' as const },
      ],
      user: { name: userLine(ctx.t, ctx.user), href: '/console/profile', avatarUrl: ctx.user.user.avatar },
      content,
      // 与 `<title>` 同一个 `title` 变量：片段里的 data-page-title 必然是整页标题。
      pageTitle: title,
      pagePath: ctx.path,
      navArea: 'console',
      navOrderAction: NAV_ORDER_ACTION,
    }),
  })
}

/** 管理台外壳。 */
export function renderAdminShell(ctx: PageContext, content: string): string {
  // 标题带上页面名：否则管理台 12 个页面在标签栏 / 历史里全都叫「管理台 · DizzyAPI」，
  // 局部刷新后 `document.title` 也不会变（第 4 批的标题同步就失去意义了）。
  const title = `${ctx.title} · 管理台 · DizzyAPI`
  return ctx.t.renderDocument({
    title,
    assets: documentAssets(fontCssOf(ctx), ctx.themeCss, { boost: true, tooltips: needsTooltips(content) }),
    body: ctx.t.renderShell({
      brand: { word: 'Dizzy', badge: '管理台', href: '/admin/users' },
      nav: navFor('admin', ctx.path, ctx.navOrder),
      foot: [
        { label: '返回用户站', href: '/console/usage', icon: 'chat' as const },
        { label: '退出登录', href: '/logout', icon: 'help' as const },
      ],
      user: { name: userLine(ctx.t, ctx.user), href: '/console/profile', avatarUrl: ctx.user.user.avatar },
      content,
      pageTitle: title,
      pagePath: ctx.path,
      navArea: 'admin',
      navOrderAction: NAV_ORDER_ACTION,
    }),
  })
}

/** 登录 / 注册外壳：没有侧栏。 */
export function renderAuthShell(t: PageTemplateService, options: {
  readonly title: string
  readonly subtitle?: string
  readonly content: string
  readonly footer?: string
  /** 当前字体 CSS；**必须传**，否则这一页的 `app.css` 地址会与发出的正文对不上。 */
  readonly fontCss: string
  /** 当前用户的界面偏好 CSS（登录页通常是空串：那时还没有会话）。 */
  readonly themeCss?: string
}): string {
  return t.renderDocument({
    title: `${options.title} · DizzyAPI`,
    // 登录 / 注册页没有任何 tooltip（内容是卡片表单），不引 Floating UI。
    assets: documentAssets(options.fontCss, options.themeCss ?? ''),
    body: t.renderAuthPage(options),
  })
}

/** 从查询串读一次性提示（PRG 的 ok / err）。 */
export function readNotice(query: URLSearchParams): PageContext['notice'] {
  const ok = query.get('ok')
  if (ok !== null && ok !== '') return { kind: 'ok', text: ok }
  const err = query.get('err')
  if (err !== null && err !== '') return { kind: 'err', text: err }
  return null
}

/**
 * 失败动作的字段名（`handleAction` 在 303 里带过来的 `field`）。
 *
 * 只有 `err` 与 `field` 同时在时才算「字段级错误」——单独一个 `field` 没有意义。
 */
export function readFieldError(query: URLSearchParams): PageContext['fieldError'] {
  const err = query.get('err')
  const field = query.get('field')
  if (err === null || err === '' || field === null || field === '') return null
  return { field, text: err }
}

/** 页面标题 + 提示条。 */
export function pageHeader(ctx: PageContext, title: string, note?: string): string {
  const header = ctx.t.renderPageHeader({ title, ...(note === undefined ? {} : { note }) })
  if (ctx.notice === null) return header
  // 字段级错误把字段名一起交出去：客户端脚本据此把这条提示搬到字段下方。
  const field = ctx.fieldError === null ? undefined : ctx.fieldError.field
  return `${header}\n${ctx.t.renderNotice({
    kind: ctx.notice.kind,
    text: ctx.notice.text,
    ...(field === undefined ? {} : { field }),
  })}`
}
