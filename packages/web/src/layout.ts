/**
 * 布局：侧栏导航 + 主列外壳。页面只负责主列内容。
 */
import type { PageTemplateService, NavItem } from '@dizzyapi/plugin-page-template'
import type { SessionView, WebRuntime } from './runtime.ts'
import { formatYuan } from './forms.ts'

export interface PageContext {
  readonly path: string
  readonly title: string
  readonly query: URLSearchParams
  /** 已登录会话；登录页不经过这里。 */
  readonly user: SessionView
  readonly t: PageTemplateService
  readonly services: WebRuntime
  readonly notice: { readonly kind: 'ok' | 'err'; readonly text: string } | null
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

const CONSOLE_NAV: readonly { label: string; path: string; icon: NavItem['icon'] }[] = [
  { label: '用量信息', path: '/console/usage', icon: 'bars' },
  { label: '模型广场', path: '/console/models', icon: 'tag' },
  { label: 'API 文档', path: '/console/api-docs', icon: 'doc' },
  { label: 'API keys', path: '/console/api-keys', icon: 'search' },
  { label: '充值', path: '/console/top-up', icon: 'card' },
  { label: '兑换', path: '/console/redeem', icon: 'receipt' },
  { label: '账单', path: '/console/transactions', icon: 'receipt' },
  { label: '个人资料', path: '/console/profile', icon: 'tag' },
]

const ADMIN_NAV: readonly { label: string; path: string; icon: NavItem['icon'] }[] = [
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
  { label: '运维总览', path: '/admin/observability', icon: 'bars' },
]

function navFor(area: 'console' | 'admin', current: string, isAdmin: boolean): NavItem[] {
  const items = (area === 'console' ? CONSOLE_NAV : ADMIN_NAV).map((item) => ({
    label: item.label,
    href: item.path,
    icon: item.icon,
    current: current === item.path,
  }))
  return items
}

function userLine(t: PageTemplateService, user: SessionView): string {
  const name = user.user.name
  const balance = user.user.balanceEnabled ? ` · ${formatYuan(user.user.balance)}` : ''
  return `${name}${balance}`
}

/** 样式与脚本走外链，CSP 保持 `'self'`（不放开 inline）。 */
export const ASSET_CSS = '/assets/app.css'
export const ASSET_JS = '/assets/app.js'

const DOC_ASSETS = { cssHref: ASSET_CSS, jsHref: ASSET_JS }

/** 用户站外壳。 */
export function renderConsoleShell(ctx: PageContext, content: string): string {
  const isAdmin = ctx.user.user.role === 'admin'
  return ctx.t.renderDocument({
    title: `${ctx.title} · DizzyAPI`,
    assets: DOC_ASSETS,
    body: ctx.t.renderShell({
      brand: { word: 'Dizzy', badge: 'API', href: '/console/usage' },
      nav: navFor('console', ctx.path, isAdmin),
      foot: [
        ...(isAdmin ? [{ label: '管理台', href: '/admin/users', icon: 'doc' as const }] : []),
        { label: '退出登录', href: '/logout', icon: 'help' as const },
      ],
      user: { name: userLine(ctx.t, ctx.user), href: '/console/profile', avatarUrl: ctx.user.user.avatar },
      content,
    }),
  })
}

/** 管理台外壳。 */
export function renderAdminShell(ctx: PageContext, content: string): string {
  return ctx.t.renderDocument({
    title: `管理台 · DizzyAPI`,
    assets: DOC_ASSETS,
    body: ctx.t.renderShell({
      brand: { word: 'Dizzy', badge: '管理台', href: '/admin/users' },
      nav: navFor('admin', ctx.path, true),
      foot: [
        { label: '返回用户站', href: '/console/usage', icon: 'chat' as const },
        { label: '退出登录', href: '/logout', icon: 'help' as const },
      ],
      user: { name: userLine(ctx.t, ctx.user), href: '/console/profile', avatarUrl: ctx.user.user.avatar },
      content,
    }),
  })
}

/** 登录 / 注册外壳：没有侧栏。 */
export function renderAuthShell(t: PageTemplateService, options: {
  readonly title: string
  readonly subtitle?: string
  readonly content: string
  readonly footer?: string
}): string {
  return t.renderDocument({
    title: `${options.title} · DizzyAPI`,
    assets: DOC_ASSETS,
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

/** 页面标题 + 提示条。 */
export function pageHeader(ctx: PageContext, title: string, note?: string): string {
  const header = ctx.t.renderPageHeader({ title, ...(note === undefined ? {} : { note }) })
  if (ctx.notice === null) return header
  return `${header}\n${ctx.t.renderNotice({ kind: ctx.notice.kind, text: ctx.notice.text })}`
}
