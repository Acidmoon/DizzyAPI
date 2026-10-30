/**
 * 侧栏 + 主列外壳：**导航的结构与它的三条交互契约**都在这里。
 *
 * 为什么从 `shell.ts` 拆出来：那个文件同时装「外壳（侧栏 + 主列）」与
 * 「通用组件（卡片 / 表格 / 表单 / 图表卡）」两类东西，第 4 批给导航加了
 * boost 属性、拖动钩子、主列标题/路径后顶过 400 行软上限（§5.6）。
 * 拆开之后：改导航（谁可拖、谁可局部刷新）不用翻一堆组件渲染代码。
 *
 * 三条契约（都是第 4 批定的，改动前先看这里）：
 * 1. **主列由 `renderMainColumn` 产出**：整页与 htmx 片段共用同一段，
 *    片段直接从整页里切（`extractMainColumn`），不另拼一份；
 * 2. **`navArea` 是「局部刷新 + 拖动排序」的总开关**：不给就输出与第 4 批之前
 *    逐字一致的纯链接（登录 / 注册卡不走这里，但缺省值必须是「什么都不加」）；
 * 3. **底部链接不 boost、不拖动**：里面挂着 `/logout`（GET + 303 到登录页）
 *    与跨区链接（管理台 ↔ 用户站，侧栏本身会整套换掉）。
 */
import { escapeAttr, escapeText } from './escape.ts'
import { renderMainColumn } from './main-column.ts'
import {
  iconBars,
  iconCard,
  iconChat,
  iconDoc,
  iconHelp,
  iconReceipt,
  iconSearch,
  iconTag,
} from './icons.ts'

/** 侧栏图标名；未知值回退成圆点（与 deepseek-usage 的容错一致）。 */
export type NavIconName = 'bars' | 'search' | 'card' | 'receipt' | 'doc' | 'help' | 'tag' | 'chat'

const NAV_ICONS: Readonly<Record<NavIconName, () => string>> = {
  bars: iconBars,
  search: iconSearch,
  card: iconCard,
  receipt: iconReceipt,
  doc: iconDoc,
  help: iconHelp,
  tag: iconTag,
  chat: iconChat,
}

/** 侧栏 / 底部链接。 */
export interface NavItem {
  readonly label: string
  readonly href: string
  readonly icon?: NavIconName
  /** 当前页：加 `aria-current="page"`，图标变强调色。 */
  readonly current?: boolean
  /** 外链：新窗口打开并带 `rel="noreferrer"`。 */
  readonly external?: boolean
}

export interface BrandOptions {
  readonly word: string
  /** 品牌名后的小徽标，例如「开放平台」。 */
  readonly badge?: string
  readonly href: string
}

export interface UserOptions {
  readonly name: string
  readonly href: string
  /** 没有头像时显示「?」占位。 */
  readonly avatarUrl?: string | null
}

export interface ShellOptions {
  readonly brand: BrandOptions
  readonly nav: readonly NavItem[]
  /** 分隔线以下的次级链接。 */
  readonly foot?: readonly NavItem[]
  readonly user?: UserOptions
  /** 主列内容。 */
  readonly content: string
  /**
   * 整页 `<title>` 的文本。写进 `<main data-page-title>`，
   * htmx 换入主列后由脚本同步 `document.title`（**与 `DocumentOptions.title` 同一来源**）。
   */
  readonly pageTitle?: string
  /** 当前页路径。写进 `<main data-page-path>`，脚本据此同步侧栏高亮。 */
  readonly pagePath?: string
  /**
   * 侧栏拖动排序**落库地址**（例如 `/console/profile?action=nav-order`）。
   *
   * 不给就不启用拖动：`page-template` 是纯渲染能力，**不知道** `web` 的路由，
   * 所以地址由调用方给，脚本只读 `data-nav-order-url`。
   */
  readonly navOrderAction?: string
  /** 拖动排序的作用域（用户站 / 管理台各一套侧栏）。缺省不启用局部刷新与拖动。 */
  readonly navArea?: 'console' | 'admin'
}

/** 外壳：侧栏 + 主列。 */
export function renderShell(options: ShellOptions): string {
  // 跳过链接必须是**正文里第一个可聚焦元素**：键盘 / 读屏用户按一下 Tab 就能
  // 越过 12 个侧栏项直达主列（指南 Accessibility 一条的硬要求）。
  // 平时用 transform 移出视口（只动合成器属性），聚焦时才滑下来，见 a11y.ts。
  return `<div class="shell">
<a class="skip-link" href="#main-content">跳到主内容</a>
${renderSidebar(options)}
${renderMainColumn({
    content: options.content,
    ...(options.pageTitle === undefined ? {} : { pageTitle: options.pageTitle }),
    ...(options.pagePath === undefined ? {} : { pagePath: options.pagePath }),
  })}
</div>`
}

/** 侧栏：品牌、导航、底部链接与用户行。 */
export function renderSidebar(options: ShellOptions): string {
  const { brand, nav, foot, user } = options
  const badge = brand.badge === undefined
    ? ''
    : `<span class="side-badge">${escapeText(brand.badge)}</span>`
  const avatar = user === undefined
    ? ''
    : user.avatarUrl === undefined || user.avatarUrl === null
      ? '<span class="side-avatar" aria-hidden="true">?</span>'
      : `<span class="side-avatar"><img src="${escapeAttr(user.avatarUrl)}" alt=""></span>`
  const footBlock = foot === undefined || foot.length === 0
    ? ''
    : `<div class="side-sep"></div>
${foot.map((item) => renderNavLink(item)).join('\n')}`
  const userBlock = user === undefined
    ? ''
    : `<a class="side-user" href="${escapeAttr(user.href)}">${avatar}<span class="side-name">${escapeText(user.name)}</span></a>`
  // htmx 的公共属性只写在**导航容器**上，由子链接继承（少写 4×N 份）：
  // - `hx-target="main"` + `hx-swap="outerHTML"`：只换主列；
  // - `hx-push-url="true"`：地址栏跟上（可分享 / 可刷新）；后退 / 前进由 `app.js`
  //   配成整页重载（关掉 htmx 的 history 缓存，理由见 client-boost.ts）。
  // **只有主导航的链接**带 `hx-boost`：底部链接里有 `/logout`（GET + 303 到登录页）
  // 与跨区链接（管理台 ↔ 用户站，侧栏本身会整套换掉），这两类必须整页跳。
  //
  // `navArea` 是这一整套（boost + 拖动）的开关：给了才启用。登录 / 注册卡不走
  // `renderShell`，所以这里缺省时页面必须与第 4 批之前逐字一致（无 hx-*、无 data-*）。
  const boost = options.navArea !== undefined
  const boostAttrs = boost ? ' hx-target="main" hx-swap="outerHTML" hx-push-url="true"' : ''
  const navOrderAttrs = boost && options.navOrderAction !== undefined
    ? ` data-nav-area="${escapeAttr(options.navArea ?? 'console')}" data-nav-order-url="${escapeAttr(options.navOrderAction)}"`
    : ''
  return `<aside class="side">
<div class="side-top">
<a class="side-logo" href="${escapeAttr(brand.href)}">
<span class="side-word">${escapeText(brand.word)}</span>${badge}
</a>
</div>
<nav class="side-nav"${boostAttrs}${navOrderAttrs}>
${nav.map((item) => renderNavLink(item, boost)).join('\n')}
${footBlock}
</nav>
<div class="side-foot">
${userBlock}
</div>
</aside>`
}

/**
 * 一个侧栏链接。
 *
 * @param boost 这一项走不走 htmx 局部刷新、参不参与拖动排序。主导航为 true，
 *        底部链接（退出登录、跨区跳转）为 false——见 `renderSidebar` 里关于
 *        `hx-boost` 的注释：把 `/logout` 塞进拖动排序会是灾难。
 */
function renderNavLink(item: NavItem, boost = false): string {
  const icon = item.icon === undefined ? '' : NAV_ICONS[item.icon]?.() ?? ''
  const current = item.current === true ? ' aria-current="page"' : ''
  const target = item.external === true ? ' target="_blank" rel="noreferrer"' : ''
  const sortable = boost && item.external !== true
  const hx = sortable ? ' hx-boost="true"' : ''
  // `data-nav-path`：拖动排序与「换入后同步高亮」都按它认项，不解析 href。
  // **只加在主导航项上**：底部还挂着 `退出登录`，它绝不能进拖动范围。
  const key = sortable ? ` data-nav-path="${escapeAttr(item.href)}"` : ''
  // `draggable="false"` **是关掉**浏览器的原生拖拽，不是用它：
  // `<a>` 默认 draggable，按下再移动时浏览器会起一次原生 DnD，把我们的
  // pointermove 变成 pointercancel（实机验证：不写这句，拖动完全不动）。
  // 排序本身走 Pointer Events（client-nav-order.ts），触屏上原生 DnD 本来也不触发。
  const noDrag = sortable ? ' draggable="false"' : ''
  return `<a class="side-link"${current} href="${escapeAttr(item.href)}"${target}${hx}${key}${noDrag}>${icon}<span>${escapeText(item.label)}</span></a>`
}
