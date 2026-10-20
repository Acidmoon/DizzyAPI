/**
 * SPA 入口。零构建、零运行时依赖：
 * - 路由来自服务端 manifest 的 `pages`，不是硬编码的页面表；
 * - 数据来自 `FrontendApis`（REST 或 mock），页面只依赖契约；
 * - 插件被禁用时，它的页面 / 设置卡在 manifest 里就不存在，前端不做特判。
 *
 * 缺少参考设计的地方刻意保留 `placeholder` 页面与 DESIGN.md 的提示，不猜视觉稿。
 */
import { createRouter } from './lib/router.js'
import { ApiError, createHttpApis, createMockApis } from './lib/api.js'

/** @typedef {import('../src/contracts.ts').FrontendApis} FrontendApis */
/** @typedef {import('../src/contracts.ts').AccountSummary} AccountSummary */
/** @typedef {import('../src/contracts.ts').SettingsNamespaceView} SettingsNamespaceView */
/** @typedef {import('../src/contracts.ts').SettingsFieldView} SettingsFieldView */
/** @typedef {import('../src/contracts.ts').GatewayHealth} GatewayHealth */
/** @typedef {import('../src/contracts.ts').UsageResponse} UsageResponse */
/** @typedef {import('../src/contracts.ts').UsageDailyPoint} UsageDailyPoint */
/** @typedef {import('../src/contracts.ts').UsageRange} UsageRange */
/** @typedef {import('../src/contracts.ts').UsageMetric} UsageMetric */
/** @typedef {import('../src/contracts.ts').ApiKeySummary} ApiKeySummary */
/** @typedef {import('../src/contracts.ts').CreatedApiKey} CreatedApiKey */
/** @typedef {import('../src/contracts.ts').TopupOptions} TopupOptions */
/** @typedef {import('../src/contracts.ts').TopupOrder} TopupOrder */
/** @typedef {import('../src/contracts.ts').PaymentMethod} PaymentMethod */
/** @typedef {import('../src/contracts.ts').SessionResponse} SessionResponse */
/** @typedef {import('../src/contracts.ts').SessionUser} SessionUser */
/** @typedef {import('../src/contracts.ts').AdminUserSummary} AdminUserSummary */
/** @typedef {import('../src/manifest.ts').FrontendManifest} FrontendManifest */
/** @typedef {import('../src/manifest.ts').FrontendPage} FrontendPage */
/** @typedef {import('../src/manifest.ts').FrontendSettingsCard} FrontendSettingsCard */
/** @typedef {import('../src/manifest.ts').FrontendSlot} FrontendSlot */
/** @typedef {import('../src/manifest.ts').FrontendArea} FrontendArea */

/**
 * @typedef {{
 *   appName?: string,
 *   mode?: 'rest' | 'mock',
 *   apiBase?: string,
 *   basePath?: string,
 *   publicBase?: string,
 *   assetBase?: string,
 *   assetVersion?: string,
 *   mockLatencyMs?: number,
 * }} Bootstrap
 * @typedef {{ readonly class?: string, readonly text?: string | number, readonly attrs?: Readonly<Record<string, string | number | boolean | undefined>>, readonly on?: Readonly<Record<string, EventListener>>, readonly dataset?: Readonly<Record<string, string>> }} ElProps
 * @typedef {'auto' | 'light' | 'dark'} Theme
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const boot = /** @type {Bootstrap} */ (/** @type {any} */ (window).__DIZZY_CONSOLE__ ?? {})
const appRoot = document.getElementById('app')

/** @type {FrontendApis | null} */
let apis = null
/** @type {FrontendManifest | null} */
let currentManifest = null
/** @type {ReturnType<typeof createRouter> | null} */
let router = null
/** @type {number} */
let renderToken = 0
/** @type {(() => void | Promise<void>) | null} */
let pageCleanup = null
/** @type {number | undefined} */
let healthTimer = undefined
/** @type {SessionResponse | null} */
let currentSession = null
/** @type {(() => void) | null} */
let routerStop = null

// ─────────────────────────────── 小工具 ───────────────────────────────

/**
 * @param {string} tag
 * @param {ElProps} [props]
 * @param {...(Node | string | number | false | null | undefined)} children
 * @returns {HTMLElement}
 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  if (props.class !== undefined) node.className = props.class
  if (props.text !== undefined) node.textContent = String(props.text)
  if (props.attrs !== undefined) {
    for (const [name, value] of Object.entries(props.attrs)) {
      if (value === undefined || value === false) continue
      node.setAttribute(name, value === true ? '' : String(value))
    }
  }
  if (props.dataset !== undefined) Object.assign(node.dataset, props.dataset)
  if (props.on !== undefined) {
    for (const [name, handler] of Object.entries(props.on)) node.addEventListener(name, handler)
  }
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue
    node.append(typeof child === 'number' ? String(child) : child)
  }
  return node
}

/**
 * 线稿图标；颜色跟随 currentColor，尺寸由 CSS 控制。
 * 未知图标回退成圆点，避免 manifest 里写错一个名字就让整页崩掉。
 * @param {string} name
 * @returns {SVGSVGElement}
 */
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('icon')
  /** @type {Record<string, string[]>} */
  const paths = {
    sun: ['M12 4v2', 'M12 18v2', 'M4 12h2', 'M18 12h2', 'M6.3 6.3l1.4 1.4', 'M16.3 16.3l1.4 1.4', 'M17.7 6.3l-1.4 1.4', 'M7.7 16.3l-1.4 1.4'],
    moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z'],
    auto: ['M4 12h16', 'M12 4v16', 'M7 7l10 10', 'M17 7L7 17'],
    refresh: ['M20 12a8 8 0 1 1-2.3-5.7', 'M20 4v4h-4'],
    arrow: ['M5 12h14', 'M13 6l6 6-6 6'],
    'arrow-left': ['M19 12H5', 'M11 18l-6-6 6-6'],
    'chevron-right': ['M9 6l6 6-6 6'],
    dot: ['M12 12h.01'],
    mark: ['M4 4h16v16H4z', 'M4 9h16', 'M9 9v11'],
    usage: ['M4 20V11', 'M10 20V5', 'M16 20v-6', 'M22 20H2'],
    keys: ['M14.5 8.5a4 4 0 1 1-3.2 6.4L5 21H2v-3l6.1-6.1a4 4 0 0 1 6.4-3.4Z'],
    topup: ['M3 7h18v12H3z', 'M3 10h18', 'M16 14h3'],
    billing: ['M6 3h12v18l-3-2-3 2-3-2-3 2z', 'M9 8h6', 'M9 12h6'],
    overview: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
    catalog: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
    accounts: ['M16 20v-1a4 4 0 0 0-8 0v1', 'M20 20v-1a3 3 0 0 0-2-2.8', 'M8 20v-1a3 3 0 0 1 2-2.8'],
    strategies: ['M4 7h8', 'M18 7h2', 'M4 17h2', 'M12 17h8'],
    settings: ['M12 3v2', 'M12 19v2', 'M3 12h2', 'M19 12h2', 'M5.6 5.6l1.4 1.4', 'M17 17l1.4 1.4', 'M18.4 5.6L17 7', 'M7 17l-1.4 1.4'],
    docs: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
    help: ['M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7', 'M12 17h.01'],
    price: ['M3 12V4h8l10 10-8 8L3 12z'],
    chat: ['M4 5h16v11H9l-5 4z'],
    external: ['M14 4h6v6', 'M20 4l-9 9', 'M20 14v6H4V4h6'],
    plus: ['M12 5v14', 'M5 12h14'],
    edit: ['M4 20h4L20 8l-4-4L4 16z', 'M13 6l5 5'],
    trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
    copy: ['M8 8h12v12H8z', 'M4 16V4h12'],
    check: ['M5 12l4 4L19 6'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    user: ['M5 20v-1a7 7 0 0 1 14 0v1'],
    lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
  }
  const drawn = paths[name] ?? paths.dot
  for (const d of drawn) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  /** @param {number} cx @param {number} cy @param {number} r @param {boolean} [filled] */
  const circle = (cx, cy, r, filled = false) => {
    const node = document.createElementNS(SVG_NS, 'circle')
    node.setAttribute('cx', String(cx))
    node.setAttribute('cy', String(cy))
    node.setAttribute('r', String(r))
    if (filled) node.setAttribute('fill', 'currentColor')
    svg.append(node)
  }
  if (name === 'sun') circle(12, 12, 3.5)
  if (name === 'settings') circle(12, 12, 3.5)
  if (name === 'keys') circle(15.5, 8.5, 1.5)
  if (name === 'help') circle(12, 12, 9)
  if (name === 'price') circle(7.5, 7.5, 1)
  if (name === 'user') circle(12, 8, 3)
  if (name === 'dot') circle(12, 12, 2, true)
  if (name === 'strategies') {
    circle(16, 7, 2)
    circle(8, 17, 2)
  }
  return svg
}

/** @param {string} iso @returns {string} */
function formatTime(iso) {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at))
}

/** @param {string | null} iso @returns {string} */
function formatRelative(iso) {
  if (iso === null || iso === '') return '—'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '—'
  const delta = at - Date.now()
  const absolute = Math.abs(delta)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const value =
    absolute < minute
      ? `${Math.round(absolute / 1000)} 秒`
      : absolute < hour
        ? `${Math.round(absolute / minute)} 分钟`
        : absolute < day
          ? `${Math.round(absolute / hour)} 小时`
          : `${Math.round(absolute / day)} 天`
  return `${delta >= 0 ? '还有 ' : '已过 '}${value}`
}

/** @param {number} seconds @returns {string} */
function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—'
  const day = Math.floor(seconds / 86_400)
  const hour = Math.floor((seconds % 86_400) / 3_600)
  const minute = Math.floor((seconds % 3_600) / 60)
  if (day > 0) return `${day} 天 ${hour} 小时`
  if (hour > 0) return `${hour} 小时 ${minute} 分`
  return `${minute} 分 ${Math.floor(seconds % 60)} 秒`
}

/** @param {unknown} value @returns {string} */
function display(value) {
  if (value === undefined || value === null || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** 整数分 → `¥1,234.56`；不经过浮点累加（D10）。 */
/** @param {number} cents @returns {string} */
function formatCny(cents) {
  const value = Math.trunc(cents)
  const sign = value < 0 ? '-' : ''
  const absolute = Math.abs(value)
  const yuan = Math.floor(absolute / 100)
  const fen = absolute % 100
  return `${sign}¥${yuan.toLocaleString('zh-CN')}.${String(fen).padStart(2, '0')}`
}

/** @param {number} value @returns {string} */
function formatInteger(value) {
  return Math.trunc(value).toLocaleString('zh-CN')
}

/** 轴刻度用的紧凑数字；正文仍用完整数字。 */
/** @param {number} value @returns {string} */
function formatCompact(value) {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

/** `2026-10-19` → `10/19`。 */
/** @param {string} date @returns {string} */
function formatShortDate(date) {
  const parts = date.split('-')
  return parts.length === 3 ? `${Number(parts[1])}/${Number(parts[2])}` : date
}

/** @param {string} name @returns {string} */
function initials(name) {
  const trimmed = name.trim()
  if (trimmed === '') return '?'
  return trimmed.slice(0, 2).toUpperCase()
}

/**
 * @param {string} text
 * @param {'ok' | 'warn' | 'bad' | 'neutral' | 'accent'} [tone]
 * @returns {HTMLElement}
 */
function badge(text, tone = 'neutral') {
  return el('span', { class: `badge tone-${tone}`, text })
}

/** @param {string} state @returns {'ok' | 'warn' | 'bad' | 'neutral'} */
function healthTone(state) {
  if (state === 'ok') return 'ok'
  if (state === 'degraded') return 'warn'
  if (state === 'down') return 'bad'
  return 'neutral'
}

/** @param {string} state @returns {'ok' | 'warn' | 'bad' | 'neutral'} */
function accountTone(state) {
  if (state === 'active') return 'ok'
  if (state === 'needs_reauth') return 'bad'
  return 'neutral'
}

/** @returns {FrontendApis} */
function api() {
  if (apis === null) throw new Error('API 尚未初始化')
  return apis
}

/** @returns {FrontendManifest} */
function manifest() {
  if (currentManifest === null) throw new Error('manifest 尚未加载')
  return currentManifest
}

/** @returns {SessionResponse} */
function session() {
  if (currentSession === null) throw new Error('会话尚未加载')
  return currentSession
}

/** 管理操作之后重读会话：改自己的角色 / 状态时权限要立刻反映到界面上。 */
async function refreshCurrentSession() {
  try {
    currentSession = await api().session.get()
  } catch (error) {
    if (!isUnauthorized(error)) throw error
    showLogin('会话已过期，请重新登录')
  }
}

/** @param {unknown} error @returns {boolean} */
function isUnauthorized(error) {
  return error instanceof ApiError && error.status === 401
}

/** @returns {ReturnType<typeof createRouter>} */
function routes() {
  if (router === null) throw new Error('router 尚未初始化')
  return router
}

/** @param {unknown} error @returns {string} */
function errorMessage(error) {
  if (error instanceof ApiError) {
    return `${error.code}${error.status > 0 ? ` · HTTP ${error.status}` : ''}：${error.message}`
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * @param {string} message
 * @param {'ok' | 'bad'} [tone]
 */
function toast(message, tone = 'ok') {
  let host = document.getElementById('toasts')
  if (host === null) {
    host = el('div', { class: 'toasts', attrs: { id: 'toasts', role: 'status', 'aria-live': 'polite' } })
    document.body.append(host)
  }
  const node = el('div', { class: `toast tone-${tone}`, text: message })
  host.append(node)
  setTimeout(() => node.remove(), tone === 'bad' ? 6500 : 2800)
}

/** @param {string} path @returns {FrontendArea} */
function areaOfPath(path) {
  return path === '/admin' || path.startsWith('/admin/') ? 'admin' : 'console'
}

/** @param {FrontendManifest} data @param {FrontendArea} area @returns {FrontendPage | undefined} */
function areaRoot(data, area) {
  return data.pages.find((page) => page.area === area && page.path === data.areas[area].root)
}

// ─────────────────────────────── 主题 ───────────────────────────────

/** @returns {Theme} */
function readTheme() {
  try {
    const stored = localStorage.getItem('dizzyapi.theme')
    return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto'
  } catch {
    return 'auto'
  }
}

/** @param {Theme} theme */
function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.dataset.theme = theme
  try {
    localStorage.setItem('dizzyapi.theme', theme)
  } catch {
    // 隐私模式禁用 localStorage：主题只影响本次页面，不报错。
  }
}

/** @param {Theme} theme @returns {string} */
function themeLabel(theme) {
  return theme === 'light' ? '亮色' : theme === 'dark' ? '暗色' : '自动'
}

/** @param {Theme} theme @returns {Theme} */
function nextTheme(theme) {
  return theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto'
}

// ─────────────────────────────── 骨架 ───────────────────────────────

/** @param {string} label @returns {HTMLElement} */
function loadingState(label) {
  return el('div', { class: 'loading' }, el('span', { class: 'loading-line' }), el('span', { text: label }))
}

/**
 * @param {unknown} error
 * @param {() => void} [retry]
 * @returns {HTMLElement}
 */
function errorState(error, retry) {
  const code = error instanceof ApiError ? error.code : 'FRONTEND_ERROR'
  const children = [
    el('div', { class: 'error-code', text: code }),
    el('p', { class: 'error-message', text: errorMessage(error) }),
  ]
  if (isUnauthorized(error)) {
    queueMicrotask(() => showLogin('会话已过期，请重新登录'))
  }
  if (retry !== undefined) {
    children.push(el('button', { class: 'btn', text: '重试', attrs: { type: 'button' }, on: { click: retry } }))
  }
  return el('div', { class: 'error-state', attrs: { role: 'alert' } }, ...children)
}

/** @param {string} label @param {string} value @returns {HTMLElement} */
function metric(label, value) {
  return el(
    'div',
    { class: 'metric' },
    el('div', { class: 'metric-label', text: label }),
    el('div', { class: 'metric-value', text: value }),
  )
}

/** @param {FrontendPage} page @returns {HTMLElement} */
function pageHead(page) {
  return el('header', { class: 'page-head' }, el('h1', { text: page.title }))
}

/**
 * @param {FrontendSlot[]} slots
 * @returns {HTMLElement | null}
 */
function slotList(slots) {
  if (slots.length === 0) return null
  return el(
    'div',
    { class: 'slot-list' },
    ...slots.map((slot) => {
      const body = el(
        'div',
        { class: 'slot-body' },
        el('div', { class: 'slot-title', text: slot.title }),
      )
      if (slot.href !== undefined) {
        return el(
          'a',
          { class: 'slot', attrs: { href: routes().href(slot.href) } },
          body,
          el('span', { class: 'slot-arrow' }, icon('arrow')),
        )
      }
      return el('div', { class: 'slot' }, body)
    }),
  )
}

const RESOURCE_LINKS = [
  { icon: 'docs', label: '接口文档' },
  { icon: 'help', label: '帮助与反馈' },
  { icon: 'price', label: '产品定价' },
  { icon: 'chat', label: '网页版免费对话' },
]

/**
 * 渲染整个外壳。路由切换会重建外壳，保证导航 `aria-current` 与页面一致。
 * 结构对齐参考页：固定左栏（品牌 / 主导航 / 次级链接 / 工具 / 用户）+
 * 居中的约 960px 主列。
 * @param {FrontendManifest} data
 * @param {ReturnType<ReturnType<typeof createRouter>['resolve']>} match
 */
function renderShell(data, match) {
  const page = match === null ? undefined : asPage(match.route.data)
  const area = page === undefined ? areaOfPath(window.location.pathname) : page.area
  const info = data.areas[area]
  const navPages = data.pages.filter((item) => item.area === area && item.hidden !== true)
  const otherArea = /** @type {FrontendArea} */ (area === 'console' ? 'admin' : 'console')
  const otherRoot = areaRoot(data, otherArea)

  const theme = readTheme()
  const themeButton = el(
    'button',
    {
      class: 'theme-toggle',
      attrs: { type: 'button', title: `主题：${themeLabel(theme)}（点击切换）`, 'aria-label': `主题：${themeLabel(theme)}` },
      on: {
        click: () => {
          const next = nextTheme(readTheme())
          applyTheme(next)
          themeButton.replaceChildren(icon(next === 'dark' ? 'moon' : next === 'light' ? 'sun' : 'auto'), el('span', { text: themeLabel(next) }))
          themeButton.setAttribute('title', `主题：${themeLabel(next)}（点击切换）`)
        },
      },
    },
    icon(theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'auto'),
    el('span', { text: themeLabel(theme) }),
  )

  const primaryLinks = navPages.map((item) =>
    el(
      'a',
      {
        class: page !== undefined && item.path === page.path ? 'primary-link active' : 'primary-link',
        attrs: {
          href: routes().href(item.path),
          ...(page !== undefined && item.path === page.path ? { 'aria-current': 'page' } : {}),
        },
      },
      icon(item.icon ?? 'dot'),
      el('span', { text: item.nav }),
    ),
  )

  const secondaryLinks = RESOURCE_LINKS.map((item) =>
    el(
      'button',
      {
        class: 'secondary-link',
        attrs: { type: 'button' },
        on: { click: () => toast(`${item.label}：外链尚未接入`) },
      },
      icon(item.icon),
      el('span', { text: item.label }),
    ),
  )

  const activeUser = currentSession?.user
  const userLabel = activeUser?.name ?? (boot.mode === 'mock' ? '预览用户' : '当前会话')
  const userSub =
    activeUser === undefined
      ? boot.mode === 'mock'
        ? 'mock 数据 · 不接触真实账户'
        : '登录态由网关提供'
      : `${activeUser.role === 'admin' ? '管理员' : '用户'}${currentSession?.email === null || currentSession?.email === undefined ? '' : ` · ${currentSession.email}`}`
  const avatarNode =
    activeUser?.avatar !== null && activeUser?.avatar !== undefined
      ? el('img', { class: 'avatar avatar-image', attrs: { src: activeUser.avatar, alt: `${activeUser.name} 的头像` } })
      : el('span', { class: 'avatar', text: initials(userLabel) })

  const main = el('main', { class: 'main', attrs: { id: 'main', tabindex: '-1' } })
  main.append(el('div', { class: 'page' }, loadingState('正在渲染页面…')))

  appRoot?.replaceChildren(
    el(
      'div',
      { class: 'app-shell' },
      el(
        'aside',
        { class: 'sidebar' },
        el(
          'a',
          { class: 'wordmark', attrs: { href: routes().href(areaRoot(data, area)?.path ?? info.root) } },
          el('span', { class: 'wordmark-mark' }, icon('mark')),
          el('span', { text: 'DizzyAPI' }),
          el('span', { class: 'wordmark-badge', text: 'API' }),
        ),
        el('nav', { class: 'primary-nav', attrs: { 'aria-label': `${info.label}导航` } }, ...primaryLinks),
        el('div', { class: 'sidebar-spacer' }),
        el('nav', { class: 'secondary-nav', attrs: { 'aria-label': '资源链接' } }, ...secondaryLinks),
        el(
          'div',
          { class: 'sidebar-utility' },
          el(
            'span',
            { class: 'gateway-status', attrs: { id: 'gateway-health', title: '网关健康' } },
            el('span', { class: 'status-dot' }),
            el('span', { text: '检查中' }),
          ),
          themeButton,
        ),
        otherRoot === undefined || (area === 'console' && currentSession?.permissions.admin !== true)
          ? null
          : el(
              'a',
              { class: 'area-switch', attrs: { href: routes().href(otherRoot.path) } },
              icon(area === 'console' ? 'settings' : 'arrow-left'),
              el('span', { text: area === 'console' ? '管理台' : '返回用户站' }),
            ),
        el(
          'a',
          {
            class: 'user-row',
            attrs: {
              href: routes().href(data.pages.find((item) => item.path === '/console/profile')?.path ?? '/console'),
            },
          },
          avatarNode,
          el('span', {}, el('div', { class: 'user-name', text: userLabel }), el('div', { class: 'user-sub', text: userSub })),
        ),
        el(
          'button',
          {
            class: 'secondary-link logout-link',
            attrs: { type: 'button' },
            on: { click: () => void logout() },
          },
          icon('arrow-left'),
          el('span', { text: '退出登录' }),
        ),
      ),
      main,
      el('div', { class: 'toasts', attrs: { id: 'toasts', role: 'status', 'aria-live': 'polite' } }),
    ),
  )
  void refreshHealth()
}

/** @param {unknown} value @returns {FrontendPage | undefined} */
function asPage(value) {
  if (value === null || typeof value !== 'object') return undefined
  const page = /** @type {FrontendPage} */ (value)
  return typeof page.path === 'string' && typeof page.title === 'string' ? page : undefined
}

// ─────────────────────────────── 健康 ───────────────────────────────

async function refreshHealth() {
  const indicator = document.getElementById('gateway-health')
  if (indicator === null) return
  try {
    const health = await api().health.get()
    indicator.replaceChildren(el('span', { class: `status-dot tone-${healthTone(health.state)}` }), el('span', { text: healthLabel(health.state) }))
    indicator.setAttribute('title', `gatewayd ${health.version} · 运行 ${formatDuration(health.uptimeSec)} · 描述符 ${health.descriptorRevision ?? '—'}`)
  } catch {
    indicator.replaceChildren(el('span', { class: 'status-dot tone-bad' }), el('span', { text: '网关不可达' }))
    indicator.setAttribute('title', '健康接口请求失败')
  }
}

/** @param {string} state @returns {string} */
function healthLabel(state) {
  if (state === 'ok') return '网关正常'
  if (state === 'degraded') return '网关降级'
  return '网关不可达'
}

// ─────────────────────────────── 页面 ───────────────────────────────

/**
 * @param {FrontendPage} page
 * @param {NonNullable<ReturnType<ReturnType<typeof createRouter>['resolve']>>} match
 * @returns {Promise<HTMLElement>}
 */
async function renderPage(page, match) {
  if (page.area === 'admin' && currentSession?.permissions.admin !== true) {
    return renderForbidden(page)
  }
  switch (page.view.kind) {
    case 'overview':
      return renderOverview(page)
    case 'usage':
      return renderUsage(page)
    case 'keys':
      return renderKeys(page)
    case 'topup':
      return renderTopup(page)
    case 'redirect':
      return renderRedirect(page)
    case 'accounts':
      return renderAccounts(page)
    case 'users':
      return renderUsers(page)
    case 'profile':
      return renderProfile(page)
    case 'catalog':
      return renderCatalog(page)
    case 'settings':
      return renderSettings(page, match)
    case 'placeholder':
      return renderPlaceholder(page)
    case 'remote':
      return renderRemote(page)
    default:
      return el('section', { class: 'page' }, pageHead(page), el('div', { class: 'empty', text: '未知页面类型' }))
  }
}

/**
 * 非管理员访问 /admin/*：不渲染任何业务内容，也不假装页面不存在。
 * @param {FrontendPage} page
 * @returns {HTMLElement}
 */
function renderForbidden(page) {
  return el(
    'section',
    { class: 'page' },
    pageHead(page),
    el(
      'div',
      { class: 'empty', attrs: { role: 'alert' } },
      el('div', { class: 'error-code', text: 'API_FORBIDDEN' }),
      el('p', { class: 'error-message', text: '当前账号不是管理员，不能访问管理台页面。' }),
    ),
  )
}

/**
 * 个人资料：头像、用户名、邮箱 / 角色 / 余额，以及修改密码。
 * 令牌、密码哈希永远不出现在这里；余额只在服务端允许时才返回。
 * @param {FrontendPage} page
 * @returns {Promise<HTMLElement>}
 */
async function renderProfile(page) {
  const me = session()
  const user = me.user
  const section = el(
    'section',
    { class: 'page' },
    pageHead(page),
  )

  const avatarHost = el('div', { class: 'profile-avatar' })
  const renderAvatar = () => {
    avatarHost.replaceChildren(
      user.avatar === null
        ? el('span', { class: 'avatar avatar-large', text: initials(user.name) })
        : el('img', {
            class: 'avatar avatar-large avatar-image',
            attrs: { src: user.avatar, alt: `${user.name} 的头像` },
          }),
    )
  }
  renderAvatar()

  const fileInput = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' },
  }))
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]
    if (file === undefined) return
    if (file.size > 256 * 1024) {
      toast('头像不能超过 256 KiB', 'bad')
      fileInput.value = ''
      return
    }
    try {
      const avatar = await readFileAsDataUrl(file)
      const updated = await api().session.updateProfile({ avatar })
      currentSession = currentSession === null ? null : { ...currentSession, user: updated }
      toast('头像已更新')
      await rerender()
    } catch (error) {
      toast(errorMessage(error), 'bad')
    } finally {
      fileInput.value = ''
    }
  })

  const nameInput = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'text', value: user.name, maxlength: '64' },
  }))
  const nameError = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const saveName = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light',
    attrs: { type: 'submit' },
    text: '保存用户名',
  }))
  const nameForm = el(
    'form',
    {},
    el('div', { class: 'form-field' }, el('label', { text: '用户名' }), nameInput),
    nameError,
    el('div', { class: 'dialog-actions' }, saveName),
  )
  nameForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    nameError.hidden = true
    saveName.disabled = true
    try {
      const updated = await api().session.updateProfile({ name: nameInput.value })
      currentSession = currentSession === null ? null : { ...currentSession, user: updated }
      toast('用户名已更新')
      await rerender()
    } catch (error) {
      nameError.textContent = errorMessage(error)
      nameError.hidden = false
      saveName.disabled = false
    }
  })

  const currentPassword = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: 'current-password' },
  }))
  const newPassword = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: 'new-password' },
  }))
  const confirmPassword = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: 'new-password' },
  }))
  const passwordError = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const savePassword = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light',
    attrs: { type: 'submit' },
    text: '修改密码',
  }))
  const passwordForm = /** @type {HTMLFormElement} */ (el(
    'form',
    {},
    el(
      'div',
      { class: 'profile-form-grid' },
      el('div', { class: 'form-field' }, el('label', { text: '当前密码' }), currentPassword),
      el('div', { class: 'form-field' }, el('label', { text: '新密码' }), newPassword),
      el('div', { class: 'form-field' }, el('label', { text: '确认新密码' }), confirmPassword),
    ),
    passwordError,
    el('div', { class: 'dialog-actions' }, savePassword),
  ))
  passwordForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    passwordError.hidden = true
    if (newPassword.value !== confirmPassword.value) {
      passwordError.textContent = '两次输入的新密码不一致'
      passwordError.hidden = false
      return
    }
    savePassword.disabled = true
    try {
      const result = await api().session.changePassword({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
      })
      passwordForm.reset()
      toast(`密码已修改；其它会话作废 ${result.revokedSessions} 个`)
    } catch (error) {
      passwordError.textContent = errorMessage(error)
      passwordError.hidden = false
    } finally {
      savePassword.disabled = false
    }
  })

  const facts = el(
    'div',
    { class: 'profile-facts' },
    profileFact('邮箱', me.email ?? '—'),
    profileFact('角色', user.role === 'admin' ? '管理员' : '普通用户'),
    profileFact('用户 ID', `#${user.id}`),
    user.balanceCents === null ? null : profileFact('余额', formatCny(user.balanceCents)),
  )

  section.append(
    el(
      'div',
      { class: 'profile-grid' },
      el(
        'div',
        { class: 'card profile-card' },
        el('h2', { text: '头像' }),
        avatarHost,
        el('div', { class: 'form-field' }, el('label', { text: '上传图片（≤ 256 KiB）' }), fileInput),
      ),
      el('div', { class: 'card profile-card' }, el('h2', { text: '账户' }), facts, nameForm),
    ),
    el('div', { class: 'card profile-card section' }, el('h2', { text: '修改密码' }), passwordForm),
  )
  return section
}

/**
 * @param {string} label
 * @param {string} value
 * @returns {HTMLElement}
 */
function profileFact(label, value) {
  return el(
    'div',
    { class: 'profile-fact' },
    el('span', { class: 'profile-fact-label', text: label }),
    el('strong', { text: value }),
  )
}

/** @param {File} file @returns {Promise<string>} */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result)
      else reject(new Error('读取图片失败'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderUsage(page) {
  /** @type {{ range: UsageRange, apiKeyId: string, metric: UsageMetric }} */
  const state = { range: '30d', apiKeyId: '', metric: 'cost' }
  /** @type {UsageResponse | null} */
  let usage = null
  /** @type {readonly ApiKeySummary[]} */
  let keys = []

  const section = el('section', { class: 'page' }, pageHead(page))
  const balancesHost = el('div', { class: 'stat-grid' })
  const metricsHost = el('div', { class: 'metrics' })
  const chartHost = el('div', {})
  const modelsHost = el('div', {})
  const rangeSelect = /** @type {HTMLSelectElement} */ (el(
    'select',
    {},
    el('option', { text: '近 7 天', attrs: { value: '7d' } }),
    el('option', { text: '近 30 天', attrs: { value: '30d' } }),
    el('option', { text: '近 90 天', attrs: { value: '90d' } }),
  ))
  rangeSelect.value = state.range
  const keySelect = /** @type {HTMLSelectElement} */ (el('select', {}, el('option', { text: '全部', attrs: { value: '' } })))
  const exportButton = el('button', { class: 'btn btn-small', attrs: { type: 'button' } }, icon('external'), el('span', { text: '导出' }))
  const filters = el(
    'div',
    { class: 'filters' },
    el('label', { class: 'filter' }, el('span', { text: '时间维度' }), rangeSelect),
    el('label', { class: 'filter' }, el('span', { text: 'API Key' }), keySelect),
    el('span', { class: 'spacer' }),
    exportButton,
  )
  section.append(balancesHost, filters, metricsHost, chartHost, modelsHost)

  const load = async () => {
    filters.classList.add('is-loading')
    try {
      usage = await api().usage.get({
        range: state.range,
        ...(state.apiKeyId === '' ? {} : { apiKeyId: state.apiKeyId }),
      })
      renderBalances()
      renderMetrics()
      renderChart()
      renderModels()
    } catch (error) {
      metricsHost.replaceChildren(errorState(error, () => void load()))
      balancesHost.replaceChildren()
      chartHost.replaceChildren()
      modelsHost.replaceChildren()
    } finally {
      filters.classList.remove('is-loading')
    }
  }

  const renderBalances = () => {
    if (usage === null) return
    balancesHost.replaceChildren(
      balanceCard('充值余额', usage.balances.paidCents, el('a', { class: 'btn btn-small', attrs: { href: routes().href('/console/top_up') }, text: '去充值' })),
      balanceCard('累计消费金额', usage.balances.spentCents),
      balanceCard('赠送余额', usage.balances.grantedCents),
    )
  }

  const renderMetrics = () => {
    if (usage === null) return
    metricsHost.replaceChildren(
      metric('消费金额', formatCny(usage.totals.costCents)),
      metric('API 请求次数', formatInteger(usage.totals.requests)),
      metric('Tokens', formatInteger(usage.totals.tokens)),
    )
  }

  const renderChart = () => {
    if (usage === null) return
    chartHost.replaceChildren(renderUsageChart(usage.daily, state.metric, (metric) => {
      state.metric = metric
      renderChart()
    }))
  }

  const renderModels = () => {
    if (usage === null) return
    const grid = el('div', { class: 'model-grid' })
    if (usage.models.length === 0) {
      modelsHost.replaceChildren(el('div', { class: 'section' }, el('div', { class: 'section-head' }, el('h2', { text: '按模型' })), el('div', { class: 'empty', text: '这个时间窗口没有模型用量。' })))
      return
    }
    for (const model of usage.models) {
      grid.append(
        el(
          'div',
          { class: 'card model-card metric-card' },
          el('div', { class: 'model-name', text: model.model }),
          el(
            'div',
            { class: 'model-stats' },
            modelStat('API 请求次数', formatInteger(model.requests)),
            modelStat('Tokens', formatInteger(model.tokens)),
            modelStat('消费金额', formatCny(model.costCents)),
          ),
        ),
      )
    }
    modelsHost.replaceChildren(
      el(
        'div',
        { class: 'section' },
        el('div', { class: 'section-head' }, el('h2', { text: '按模型' })),
        grid,
      ),
      slotList(manifest().slots.filter((slot) => slot.slot === 'console.overview.after')) ?? el('span'),
    )
  }

  rangeSelect.addEventListener('change', () => {
    state.range = /** @type {UsageRange} */ (rangeSelect.value)
    void load()
  })
  keySelect.addEventListener('change', () => {
    state.apiKeyId = keySelect.value
    void load()
  })
  exportButton.addEventListener('click', () => {
    toast('导出接口待接入：预期 GET /api/usage/export')
  })

  try {
    keys = (await api().keys.list()).items
    for (const key of keys) keySelect.append(el('option', { text: key.name, attrs: { value: key.id } }))
  } catch {
    // 没有 keys 接口时仍展示全部用量；筛选器只剩「全部」。
  }
  await load()
  return section
}

/**
 * @param {string} label
 * @param {number} cents
 * @param {HTMLElement} [action]
 * @returns {HTMLElement}
 */
function balanceCard(label, cents, action) {
  return el(
    'div',
    { class: 'stat-card' },
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-foot' }, el('div', { class: 'stat-value-row' }, el('span', { class: 'stat-value', text: formatCny(cents) }), el('span', { class: 'stat-unit', text: 'CNY' })), action ?? null),
  )
}

/** @param {string} label @param {string} value @returns {HTMLElement} */
function modelStat(label, value) {
  return el('div', { class: 'model-stat' }, el('span', { text: label }), el('strong', { text: value }))
}

/**
 * 单序列柱状图。零依赖 SVG；单序列不画图例，标题就是身份。
 * 每根柱子都有透明的键盘可聚焦命中层 + tooltip；下方提供表格视图。
 * @param {readonly UsageDailyPoint[]} daily
 * @param {UsageMetric} metric
 * @param {(metric: UsageMetric) => void} onChange
 * @returns {HTMLElement}
 */
function renderUsageChart(daily, metric, onChange) {
  const card = el('div', { class: 'chart-card card' })
  const label = metric === 'cost' ? '消费金额（CNY）' : metric === 'requests' ? 'API 请求次数' : 'Tokens'
  const values = daily.map((point) => (metric === 'cost' ? point.costCents : metric === 'requests' ? point.requests : point.tokens))
  const total = values.reduce((sum, value) => sum + value, 0)
  const totalText = metric === 'cost' ? formatCny(total) : formatInteger(total)

  const tabs = el(
    'div',
    { class: 'chart-tabs', attrs: { role: 'tablist', 'aria-label': '图表指标' } },
    ...[
      ['cost', '消费金额'],
      ['requests', '请求次数'],
      ['tokens', 'Tokens'],
    ].map(([id, text]) =>
      el('button', {
        class: id === metric ? 'chart-tab active' : 'chart-tab',
        attrs: { type: 'button', role: 'tab', 'aria-selected': id === metric ? 'true' : 'false' },
        text,
        on: { click: () => onChange(/** @type {UsageMetric} */ (id)) },
      }),
    ),
  )
  card.append(
    el('div', { class: 'chart-head' }, el('span', { class: 'chart-title', text: label }), el('span', { class: 'chart-total', text: totalText }), tabs),
  )

  const width = 800
  const height = 260
  const pad = { top: 22, right: 12, bottom: 30, left: 58 }
  const innerW = width - pad.left - pad.right
  const innerH = height - pad.top - pad.bottom
  const baseline = pad.top + innerH
  const max = niceMax(Math.max(...values, 0))
  const slot = innerW / Math.max(daily.length, 1)
  const barWidth = Math.min(24, Math.max(3, slot * 0.62))
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
  svg.setAttribute('class', 'chart-svg')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', `${label}，近 ${daily.length} 天，合计 ${totalText}`)

  /** @param {number} x @param {number} y @param {string} text @param {string} [anchor] */
  const axis = (x, y, text, anchor) => {
    const node = document.createElementNS(SVG_NS, 'text')
    node.setAttribute('x', String(x))
    node.setAttribute('y', String(y))
    node.setAttribute('class', 'chart-axis')
    if (anchor !== undefined) node.setAttribute('text-anchor', anchor)
    node.textContent = text
    svg.append(node)
  }

  for (let tick = 0; tick <= 2; tick++) {
    const value = (max / 2) * tick
    const y = baseline - (value / max) * innerH
    const line = document.createElementNS(SVG_NS, 'line')
    line.setAttribute('x1', String(pad.left))
    line.setAttribute('x2', String(width - pad.right))
    line.setAttribute('y1', String(y))
    line.setAttribute('y2', String(y))
    line.setAttribute('class', 'chart-grid')
    svg.append(line)
    axis(pad.left - 9, y + 3, formatTick(value, metric), 'end')
  }

  const wrapper = el('div', { class: 'chart-wrap' })
  const tooltip = el('div', { class: 'chart-tooltip', attrs: { role: 'status' } })
  wrapper.append(tooltip)

  let peakIndex = 0
  for (let index = 1; index < values.length; index++) if (values[index] > values[peakIndex]) peakIndex = index

  daily.forEach((point, index) => {
    const value = values[index] ?? 0
    const x = pad.left + index * slot + (slot - barWidth) / 2
    const barHeight = (value / max) * innerH
    const y = baseline - barHeight
    const bar = document.createElementNS(SVG_NS, 'path')
    bar.setAttribute('d', barPath(x, y, barWidth, barHeight, baseline))
    bar.setAttribute('class', 'chart-bar')
    svg.append(bar)

    if (index === peakIndex && value > 0) {
      const peak = document.createElementNS(SVG_NS, 'text')
      peak.setAttribute('x', String(x + barWidth / 2))
      peak.setAttribute('y', String(Math.max(12, y - 6)))
      peak.setAttribute('text-anchor', 'middle')
      peak.setAttribute('class', 'chart-peak')
      peak.textContent = formatTick(value, metric)
      svg.append(peak)
    }

    const hit = document.createElementNS(SVG_NS, 'rect')
    hit.setAttribute('x', String(pad.left + index * slot))
    hit.setAttribute('y', String(pad.top))
    hit.setAttribute('width', String(Math.max(slot, 6)))
    hit.setAttribute('height', String(innerH))
    hit.setAttribute('class', 'chart-hit')
    hit.setAttribute('tabindex', '0')
    hit.setAttribute('role', 'img')
    hit.setAttribute('aria-label', `${point.date} ${formatValue(value, metric)}`)
    const show = () => {
      const wrapRect = wrapper.getBoundingClientRect()
      const hitRect = hit.getBoundingClientRect()
      const scale = hitRect.height / innerH
      const left = hitRect.left - wrapRect.left + hitRect.width / 2
      const top = hitRect.top - wrapRect.top + Math.max(0, (y - pad.top) * scale)
      tooltip.style.left = `${Math.min(Math.max(left, 46), Math.max(wrapRect.width - 46, 46))}px`
      tooltip.style.top = `${top}px`
      tooltip.replaceChildren(
        el('strong', { text: formatValue(value, metric) }),
        el('span', { text: point.date }),
      )
      tooltip.classList.add('show')
      bar.setAttribute('opacity', '0.78')
    }
    const hide = () => {
      tooltip.classList.remove('show')
      bar.removeAttribute('opacity')
    }
    hit.addEventListener('pointerenter', show)
    hit.addEventListener('pointerleave', hide)
    hit.addEventListener('focus', show)
    hit.addEventListener('blur', hide)
    svg.append(hit)
  })

  const labelIndexes = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])].filter((index) => index >= 0)
  for (const index of labelIndexes) {
    const point = daily[index]
    if (point === undefined) continue
    const anchor = index === 0 ? 'start' : index === daily.length - 1 ? 'end' : 'middle'
    const x = index === 0 ? pad.left : index === daily.length - 1 ? width - pad.right : pad.left + index * slot + slot / 2
    axis(x, height - 8, formatShortDate(point.date), anchor)
  }

  wrapper.insertBefore(svg, tooltip)
  card.append(wrapper)

  const table = el(
    'details',
    { class: 'chart-table' },
    el('summary', { text: '表格视图' }),
    el(
      'div',
      { class: 'table-wrap' },
      el(
        'table',
        { class: 'data-table' },
        el('thead', {}, el('tr', {}, el('th', { text: '日期' }), el('th', { text: '消费金额' }), el('th', { text: '请求次数' }), el('th', { text: 'Tokens' }))),
        el(
          'tbody',
          {},
          ...daily.map((point) =>
            el('tr', {}, el('td', { text: point.date }), el('td', { class: 'num', text: formatCny(point.costCents) }), el('td', { class: 'num', text: formatInteger(point.requests) }), el('td', { class: 'num', text: formatInteger(point.tokens) })),
          ),
        ),
      ),
    ),
  )
  card.append(table)
  return card
}

/** @param {number} value @returns {number} */
function niceMax(value) {
  if (!Number.isFinite(value) || value <= 0) return 10
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  const fraction = value / base
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10
  return nice * base
}

/** 轴刻度 / 峰值：短标签，不把货币符号塞满坐标轴。 */
/** @param {number} value @param {UsageMetric} metric @returns {string} */
function formatTick(value, metric) {
  return formatCompact(metric === 'cost' ? value / 100 : value)
}

/** tooltip / aria：完整值。 */
/** @param {number} value @param {UsageMetric} metric @returns {string} */
function formatValue(value, metric) {
  if (metric === 'cost') return formatCny(Math.round(value))
  return formatInteger(Math.round(value))
}

/**
 * 柱子：顶部 4px 圆角，底部贴基线保持直角。
 * @param {number} x @param {number} y @param {number} width @param {number} height @param {number} baseline
 * @returns {string}
 */
function barPath(x, y, width, height, baseline) {
  if (height <= 0.5) return `M${x},${baseline} L${x + width},${baseline}`
  const radius = Math.min(4, height / 2, width / 2)
  return [
    `M${x},${baseline}`,
    `L${x},${y + radius}`,
    `Q${x},${y} ${x + radius},${y}`,
    `L${x + width - radius},${y}`,
    `Q${x + width},${y} ${x + width},${y + radius}`,
    `L${x + width},${baseline}`,
    'Z',
  ].join(' ')
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderKeys(page) {
  const section = el('section', { class: 'page' }, pageHead(page))
  const tableHost = el('div', { class: 'table-card' })
  const actions = el(
    'div',
    { class: 'filters' },
    el('span', { class: 'spacer' }),
    el('button', {
      class: 'btn',
      attrs: { type: 'button' },
      text: '按 API Key 查看用量',
      on: { click: () => toast('在「用量信息」页的 API Key 下拉框里选择具体 key。') },
    }),
    el('button', {
      class: 'btn btn-light',
      attrs: { type: 'button' },
      text: '创建 API key',
      on: { click: () => openCreateKeyDialog(load) },
    }),
  )
  section.append(actions, tableHost)
  tableHost.append(loadingState('正在读取 API keys…'))

  const load = async () => {
    tableHost.replaceChildren(loadingState('正在读取 API keys…'))
    try {
      const response = await api().keys.list()
      if (response.items.length === 0) {
        tableHost.replaceChildren(el('div', { class: 'empty', text: '还没有 API key。创建后完整 key 只显示一次。' }))
        return
      }
      tableHost.replaceChildren(
        el(
          'div',
          { class: 'table-wrap' },
          el(
            'table',
            { class: 'data-table key-table' },
            el(
              'colgroup',
              {},
              el('col', { class: 'col-name' }),
              el('col', { class: 'col-tracking' }),
              el('col', { class: 'col-key' }),
              el('col', { class: 'col-created' }),
              el('col', { class: 'col-used' }),
              el('col', { class: 'col-actions' }),
            ),
            el(
              'thead',
              {},
              el('tr', {}, el('th', { text: '名称' }), el('th', { text: 'Tracking ID' }), el('th', { text: 'Key' }), el('th', { text: '创建日期' }), el('th', { text: '最近使用日期' }), el('th', { text: '' })),
            ),
            el('tbody', {}, ...response.items.map((key) => keyRow(key, load))),
          ),
        ),
      )
    } catch (error) {
      tableHost.replaceChildren(errorState(error, () => void load()))
    }
  }
  await load()
  return section
}

/**
 * @param {ApiKeySummary} key
 * @param {() => Promise<void>} reload
 * @returns {HTMLElement}
 */
function keyRow(key, reload) {
  const edit = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon',
    attrs: { type: 'button', title: key.appManaged ? 'App-managed key 不能改名' : '改名' },
    on: { click: () => openEditKeyDialog(key, reload) },
  }))
  edit.append(icon('edit'))
  edit.disabled = key.appManaged

  const remove = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon btn-danger',
    attrs: { type: 'button', title: key.appManaged ? 'App-managed key 不能删除' : '删除' },
    on: {
      click: async () => {
        if (!window.confirm(`删除 API key「${key.name}」？正在使用它的客户端会立刻失败。`)) return
        remove.disabled = true
        try {
          await api().keys.remove(key.id)
          toast(`${key.name} 已删除`)
          await reload()
        } catch (error) {
          remove.disabled = false
          toast(errorMessage(error), 'bad')
        }
      },
    },
  }))
  remove.append(icon('trash'))

  const rotate = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon',
    attrs: { type: 'button', title: key.appManaged ? 'App-managed key 不能轮换' : '轮换密钥（旧 secret 立刻失效）' },
    on: {
      click: () => {
        if (!window.confirm(`轮换「${key.name}」？旧 secret 会立刻失效，正在使用它的客户端需要换成新 key。`)) return
        const dialog = openDialog('轮换 API key', el('div', {}))
        void api()
          .keys.rotate(key.id)
          .then(async (created) => {
            showCreatedKey(dialog, created)
            await reload()
          })
          .catch((error) => {
            dialog.close()
            toast(errorMessage(error), 'bad')
          })
      },
    },
  }))
  rotate.append(icon('refresh'))
  rotate.disabled = key.appManaged

  const enabled = key.enabled !== false
  const toggle = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon',
    attrs: { type: 'button', title: key.appManaged ? 'App-managed key 不能启停' : enabled ? '停用' : '启用' },
    on: {
      click: async () => {
        toggle.disabled = true
        try {
          await api().keys.update(key.id, { enabled: !enabled })
          toast(enabled ? `${key.name} 已停用` : `${key.name} 已启用`)
          await reload()
        } catch (error) {
          toggle.disabled = false
          toast(errorMessage(error), 'bad')
        }
      },
    },
  }))
  toggle.append(icon(enabled ? 'close' : 'check'))
  toggle.disabled = key.appManaged

  return el(
    'tr',
    { class: key.appManaged || !enabled ? 'row-muted' : '' },
    el(
      'td',
      {},
      el('div', { class: 'cell-title', text: key.name }),
      key.appManaged
        ? el('div', { class: 'cell-sub' }, badge('App-managed', 'accent'))
        : enabled
          ? null
          : el('div', { class: 'cell-sub' }, badge('已停用', 'neutral')),
    ),
    el('td', {}, el('code', { text: key.trackingId })),
    el(
      'td',
      {},
      el(
        'div',
        { class: 'table-actions start' },
        el('code', { text: key.maskedKey }),
        key.secret === null
          ? null
          : el('button', {
              class: 'btn btn-icon',
              attrs: { type: 'button', title: '复制完整 key' },
              on: {
                click: async () => {
                  try {
                    await navigator.clipboard.writeText(/** @type {string} */ (key.secret))
                    toast('完整 API key 已复制')
                  } catch {
                    toast('复制失败：请手动选择', 'bad')
                  }
                },
              },
            }, icon('copy')),
      ),
    ),
    el('td', { text: formatTime(key.createdAt) }),
    el('td', { text: key.lastUsedAt === null ? '—' : formatTime(key.lastUsedAt) }),
    el('td', { class: 'cell-actions' }, el('div', { class: 'table-actions' }, edit, rotate, toggle, remove)),
  )
}

/**
 * @param {() => Promise<void>} reload
 */
function openCreateKeyDialog(reload) {
  const input = /** @type {HTMLInputElement} */ (el('input', { attrs: { type: 'text', placeholder: '例如 ci-runner', maxlength: '80' } }))
  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const cancel = el('button', { class: 'btn', attrs: { type: 'button' }, text: '取消' })
  const create = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-light', attrs: { type: 'submit' }, text: '创建' }))
  const form = el(
    'form',
    {},
    el('div', { class: 'form-field' }, el('label', { text: '名称' }), input),
    error,
    el('div', { class: 'dialog-actions' }, cancel, create),
  )
  const dialog = openDialog('创建 API key', form)
  cancel.addEventListener('click', () => dialog.close())
  input.focus()
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    create.disabled = true
    try {
      const created = await api().keys.create({ name: input.value })
      showCreatedKey(dialog, created)
      await reload()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      create.disabled = false
    }
  })
}

/**
 * @param {HTMLDialogElement} dialog
 * @param {CreatedApiKey} created
 */
function showCreatedKey(dialog, created) {
  const copy = el('button', { class: 'btn btn-small', attrs: { type: 'button' } }, icon('copy'), el('span', { text: '复制完整 key' }))
  const close = el('button', { class: 'btn btn-small', attrs: { type: 'button' }, text: '我已保存' })
  const secret = el('code', { class: 'secret-value', text: created.secret })
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(created.secret)
      toast('完整 API key 已复制')
    } catch {
      toast('复制失败：请手动选择并复制', 'bad')
    }
  })
  close.addEventListener('click', () => dialog.close())
  const body = el(
    'div',
    { class: 'dialog-body' },
    el('h2', { text: 'API key 已创建' }),
    el('p', { text: `${created.name} · ${created.maskedKey}` }),
    el('div', { class: 'secret-box' }, secret, el('span', { class: 'secret-warning', text: '只显示这一次。关闭后无法再次查看；丢失只能重新创建。' }), el('div', { class: 'secret-actions' }, copy)),
    el('div', { class: 'dialog-actions' }, close),
  )
  dialog.replaceChildren(body)
}

/**
 * @param {ApiKeySummary} key
 * @param {() => Promise<void>} reload
 */
function openEditKeyDialog(key, reload) {
  const input = /** @type {HTMLInputElement} */ (el('input', { attrs: { type: 'text', value: key.name, maxlength: '80' } }))
  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const cancel = el('button', { class: 'btn', attrs: { type: 'button' }, text: '取消' })
  const save = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-light', attrs: { type: 'submit' }, text: '保存' }))
  const form = el(
    'form',
    {},
    el('div', { class: 'form-field' }, el('label', { text: '名称' }), input),
    error,
    el('div', { class: 'dialog-actions' }, cancel, save),
  )
  const dialog = openDialog('重命名 API key', form)
  cancel.addEventListener('click', () => dialog.close())
  input.focus()
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    save.disabled = true
    try {
      await api().keys.update(key.id, { name: input.value })
      toast('名称已更新')
      dialog.close()
      await reload()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      save.disabled = false
    }
  })
}

/**
 * @param {string} title
 * @param {HTMLElement} form
 * @param {{ wide?: boolean }} [options]
 * @returns {HTMLDialogElement}
 */
function openDialog(title, form, options = {}) {
  const dialog = /** @type {HTMLDialogElement} */ (document.createElement('dialog'))
  dialog.className = options.wide === true ? 'dialog dialog-wide' : 'dialog'
  const close = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon dialog-close',
    attrs: { type: 'button', title: '关闭', 'aria-label': '关闭' },
    on: { click: () => dialog.close() },
  }))
  close.append(icon('close'))
  dialog.append(
    el(
      'div',
      { class: 'dialog-body' },
      el('div', { class: 'dialog-head' }, el('h2', { text: title }), close),
      form,
    ),
  )
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
  return dialog
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderTopup(page) {
  const section = el('section', { class: 'page' }, pageHead(page))
  const formHost = el('div', {})
  section.append(formHost)
  formHost.append(loadingState('正在读取充值选项…'))

  let options
  try {
    options = await api().topup.options()
  } catch (error) {
    formHost.replaceChildren(errorState(error, () => void rerender()))
    return section
  }

  /** @type {{ amountCents: number, method: PaymentMethod, custom: string }} */
  const state = { amountCents: options.amountsCents[0] ?? options.minCents, method: options.methods.find((item) => item.enabled)?.id ?? 'alipay', custom: '' }
  const resultHost = el('div', {})
  const tabs = el(
    'div',
    { class: 'segmented', attrs: { role: 'tablist', 'aria-label': '充值方式' } },
    el('button', { class: 'segment active', attrs: { type: 'button', role: 'tab' }, text: '在线充值' }),
    el('button', {
      class: 'segment',
      attrs: { type: 'button', role: 'tab' },
      text: '对公汇款',
      on: { click: () => toast('对公汇款契约尚未提供；DESIGN.md 已列出所需接口。') },
    }),
  )

  const amounts = el('div', { class: 'amounts' })
  const custom = /** @type {HTMLInputElement} */ (el('input', { class: 'amount-custom', attrs: { type: 'number', min: '1', step: '0.01', placeholder: '自定义金额', 'aria-label': '自定义金额' } }))
  custom.hidden = true
  const chips = options.amountsCents.map((amount) =>
    el('button', {
      class: amount === state.amountCents ? 'amount-chip active' : 'amount-chip',
      attrs: { type: 'button' },
      text: `¥${formatInteger(amount / 100)}`,
    }),
  )
  const customChip = el('button', { class: 'amount-chip', attrs: { type: 'button' }, text: '自定义' })
  for (let index = 0; index < chips.length; index++) {
    const chip = chips[index]
    const amount = options.amountsCents[index]
    chip.addEventListener('click', () => {
      for (const item of chips) item.classList.toggle('active', item === chip)
      customChip.classList.remove('active')
      custom.hidden = true
      state.amountCents = amount
      state.custom = ''
      custom.value = ''
      updatePayButton()
    })
  }
  customChip.addEventListener('click', () => {
    for (const item of chips) item.classList.remove('active')
    customChip.classList.add('active')
    custom.hidden = false
    state.custom = custom.value
    state.amountCents = 0
    custom.focus()
    updatePayButton()
  })
  amounts.append(...chips, customChip, custom)

  const methods = el('div', { class: 'pay-methods' })
  const methodInputs = options.methods.map((method) => {
    const radio = /** @type {HTMLInputElement} */ (el('input', { attrs: { type: 'radio', name: 'pay-method', value: method.id } }))
    radio.checked = method.id === state.method
    radio.disabled = !method.enabled
    const card = el(
      'label',
      { class: radio.checked ? 'pay-method active' : 'pay-method' },
      radio,
      el('span', { class: 'pay-icon', text: method.id === 'alipay' ? '支' : '微' }),
      el('span', {}, el('div', { class: 'pay-method-label', text: method.label })),
    )
    radio.addEventListener('change', () => {
      state.method = method.id
      for (const item of methodInputs) item.card.classList.toggle('active', item.radio.checked)
    })
    methods.append(card)
    return { card, radio }
  })

  const pay = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-light pay-button', attrs: { type: 'button' }, text: '去支付' }))
  const amountHint = el('span', { class: 'muted', text: '' })
  const updatePayButton = () => {
    amountHint.textContent = `当前金额 ${formatCny(state.amountCents)}`
  }
  updatePayButton()

  custom.addEventListener('input', () => {
    state.custom = custom.value
    const yuan = Number(custom.value)
    if (custom.value !== '' && Number.isFinite(yuan)) {
      state.amountCents = Math.round(yuan * 100)
      for (const chip of chips) chip.classList.remove('active')
    } else {
      state.amountCents = 0
    }
    updatePayButton()
  })

  pay.addEventListener('click', async () => {
    if (state.custom !== '') {
      const yuan = Number(state.custom)
      if (!Number.isFinite(yuan) || yuan <= 0) {
        toast('请输入有效金额', 'bad')
        return
      }
      state.amountCents = Math.round(yuan * 100)
    }
    if (state.amountCents < options.minCents || state.amountCents > options.maxCents) {
      toast(`金额必须在 ${formatCny(options.minCents)} 到 ${formatCny(options.maxCents)} 之间`, 'bad')
      return
    }
    pay.disabled = true
    try {
      const order = await api().topup.createOrder({ amountCents: state.amountCents, method: state.method })
      resultHost.replaceChildren(renderTopupOrder(order))
      toast('订单已创建')
    } catch (error) {
      toast(errorMessage(error), 'bad')
    } finally {
      pay.disabled = false
    }
  })

  formHost.replaceChildren(
    tabs,
    el(
      'div',
      { class: 'topup-form' },
      el(
        'div',
        { class: 'topup-field' },
        el('span', { class: 'topup-label', text: '支付金额' }),
        amounts,
        el(
          'div',
          { class: 'filters tight' },
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'btn btn-small',
            attrs: { type: 'button' },
            text: '查看价格',
            on: { click: () => toast('价格页契约尚未提供；DESIGN.md 已列出所需接口。') },
          }),
        ),
      ),
      el('div', { class: 'topup-field' }, el('span', { class: 'topup-label', text: '支付方式' }), methods),
      pay,
      el('div', { class: 'topup-field' }, amountHint),
      resultHost,
    ),
  )
  return section
}

/** @param {TopupOrder} order @returns {HTMLElement} */
function renderTopupOrder(order) {
  const rows = el(
    'div',
    { class: 'result-rows' },
    resultRow('订单号', order.orderId),
    resultRow('金额', formatCny(order.amountCents)),
    resultRow('支付方式', order.method),
    resultRow('状态', order.status),
    resultRow('有效期', formatTime(order.expiresAt)),
  )
  return el(
    'div',
    { class: 'topup-result' },
    el('h3', { text: '订单已创建' }),
    rows,
    order.payUrl === null
      ? null
      : el('a', { class: 'btn btn-light', attrs: { href: order.payUrl, target: '_blank', rel: 'noopener noreferrer' }, text: '前往支付' }),
  )
}

/** @param {string} label @param {string} value @returns {HTMLElement} */
function resultRow(label, value) {
  return el('div', { class: 'result-row' }, el('span', { text: label }), el('code', { text: value }))
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderOverview(page) {
  const section = el('section', { class: 'page' }, pageHead(page))
  const content = el('div', { class: 'stack' })
  section.append(content)
  const healthResult = await api().health.get().then(
    (health) => ({ health, error: null }),
    (error) => ({ health: null, error }),
  )
  if (healthResult.error !== null) {
    content.append(errorState(healthResult.error, () => void rerender()))
    return section
  }
  const health = /** @type {GatewayHealth} */ (healthResult.health)
  content.append(
    el(
      'div',
      { class: 'metrics' },
      metric('状态', healthLabel(health.state)),
      metric('已运行', formatDuration(health.uptimeSec)),
      metric('描述符', health.descriptorRevision ?? '—'),
      metric('控制桥', health.bridge.connected ? '已连接' : '未连接'),
    ),
  )

  const components = el(
    'div',
    { class: 'section' },
    el('div', { class: 'section-head' }, el('h2', { text: '组件' })),
    el(
      'div',
      { class: 'table-wrap table-card' },
      el(
        'table',
        { class: 'data-table' },
        el('thead', {}, el('tr', {}, el('th', { text: '组件' }), el('th', { text: '状态' }), el('th', { text: '说明' }))),
        el(
          'tbody',
          {},
          ...health.components.map((component) =>
            el(
              'tr',
              {},
              el('td', {}, el('code', { text: component.name })),
              el('td', {}, badge(component.state, healthTone(component.state))),
              el('td', { class: 'muted', text: component.detail ?? '—' }),
            ),
          ),
        ),
      ),
    ),
  )
  content.append(components)

  if (page.view.kind === 'overview' && page.view.flavor === 'admin') {
    const catalogResult = await api().catalog.list().then(
      (catalog) => ({ catalog, error: null }),
      (error) => ({ catalog: null, error }),
    )
    if (catalogResult.error === null && catalogResult.catalog !== null) {
      const modules = catalogResult.catalog.modules
      const active = modules.filter((module) => module.state === 'active').length
      const disabled = modules.filter((module) => module.state === 'disabled').length
      content.append(
        el(
          'div',
          { class: 'section' },
          el(
            'div',
            { class: 'section-head' },
            el('h2', { text: '模块' }),
            el('a', { class: 'btn btn-small', attrs: { href: routes().href('/admin/catalog') }, text: '查看目录' }),
          ),
          el(
            'div',
            { class: 'module-strip' },
            ...modules.slice(0, 8).map((module) =>
              el(
                'div',
                { class: 'module-chip' },
                el('span', { class: 'module-state' }, badge(module.state, module.state === 'active' ? 'ok' : module.state === 'disabled' ? 'neutral' : 'warn')),
                el('span', { text: module.id }),
                el('code', { text: module.package }),
              ),
            ),
          ),
        ),
      )
    }
  }

  const slots = slotList(manifest().slots.filter((slot) => slot.slot === `${page.area}.overview.after`))
  if (slots !== null) content.append(slots)
  return section
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderAccounts(page) {
  const section = el('section', { class: 'page' }, pageHead(page))
  const results = el('div', { class: 'results' })
  const provider = /** @type {HTMLSelectElement} */ (el(
    'select',
    { class: 'select', attrs: { 'aria-label': '上游筛选' } },
    el('option', { text: '全部上游', attrs: { value: '' } }),
    el('option', { text: 'Claude', attrs: { value: 'claude' } }),
    el('option', { text: 'OpenAI / Codex', attrs: { value: 'openai' } }),
    el('option', { text: 'custom', attrs: { value: 'custom' } }),
  ))
  const status = /** @type {HTMLSelectElement} */ (el(
    'select',
    { class: 'select', attrs: { 'aria-label': '状态筛选' } },
    el('option', { text: '全部状态', attrs: { value: '' } }),
    el('option', { text: 'active', attrs: { value: 'active' } }),
    el('option', { text: 'needs_reauth', attrs: { value: 'needs_reauth' } }),
  ))
  const refresh = el('button', { class: 'btn btn-small', attrs: { type: 'button' } }, icon('refresh'), el('span', { text: '刷新' }))
  const add = el('button', { class: 'btn btn-light', attrs: { type: 'button' } }, icon('plus'), el('span', { text: '添加账号' }))
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('label', { class: 'field-inline' }, el('span', { text: '上游' }), provider),
    el('label', { class: 'field-inline' }, el('span', { text: '状态' }), status),
    el('span', { class: 'toolbar-spacer' }),
    refresh,
    add,
  )
  section.append(toolbar, results)

  const load = async () => {
    results.replaceChildren(loadingState('正在读取账号…'))
    try {
      const response = await api().accounts.list({
        ...(provider.value === '' ? {} : { provider: /** @type {any} */ (provider.value) }),
        ...(status.value === '' ? {} : { status: /** @type {any} */ (status.value) }),
        limit: 100,
      })
      if (response.items.length === 0) {
        results.replaceChildren(el('div', { class: 'empty', text: '没有符合条件的账号。' }))
        return
      }
      results.replaceChildren(
        el(
          'div',
          { class: 'table-wrap table-card' },
          el(
            'table',
            { class: 'data-table account-table' },
            el(
              'colgroup',
              {},
              el('col', { class: 'col-account' }),
              el('col', { class: 'col-upstream' }),
              el('col', { class: 'col-state' }),
              el('col', { class: 'col-expires' }),
              el('col', { class: 'col-refresh' }),
              el('col', { class: 'col-failure' }),
              el('col', { class: 'col-actions' }),
            ),
            el(
              'thead',
              {},
              el('tr', {}, el('th', { text: '账号' }), el('th', { text: '上游' }), el('th', { text: '状态' }), el('th', { text: '令牌到期' }), el('th', { text: '下次刷新' }), el('th', { text: '失败' }), el('th', { text: '' })),
            ),
            el('tbody', {}, ...response.items.map((account) => accountRow(account, load))),
          ),
        ),
      )
    } catch (error) {
      results.replaceChildren(errorState(error, () => void load()))
    }
  }

  provider.addEventListener('change', () => void load())
  status.addEventListener('change', () => void load())
  refresh.addEventListener('click', () => void load())
  add.addEventListener('click', () => openCreateAccountDialog(load))
  void load()
  return section
}

/**
 * @param {AccountSummary} account
 * @param {() => Promise<void>} reload
 * @returns {HTMLElement}
 */
function accountRow(account, reload) {
  const toggle = /** @type {HTMLButtonElement} */ (el(
    'button',
    {
      class: account.enabled ? 'btn btn-icon' : 'btn btn-icon btn-primary',
      attrs: { type: 'button', title: account.enabled ? '停用' : '启用' },
      on: {
        click: async () => {
          toggle.disabled = true
          try {
            await api().accounts.update(account.id, { enabled: !account.enabled })
            toast(`${account.label} 已${account.enabled ? '停用' : '启用'}`)
            await reload()
          } catch (error) {
            toggle.disabled = false
            toast(errorMessage(error), 'bad')
          }
        },
      },
    },
  ))
  toggle.append(icon(account.enabled ? 'close' : 'check'))
  const edit = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon',
    attrs: { type: 'button', title: '编辑账号' },
    on: { click: () => openEditAccountDialog(account, reload) },
  }))
  edit.append(icon('edit'))
  const credential = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon',
    attrs: { type: 'button', title: '导入凭据' },
    on: { click: () => openImportCredentialsDialog(account, reload) },
  }))
  credential.append(icon('lock'))
  const remove = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-icon btn-danger',
    attrs: { type: 'button', title: '删除账号' },
    on: {
      click: async () => {
        if (!window.confirm(`删除账号「${account.label}」？`)) return
        remove.disabled = true
        try {
          await api().accounts.remove(account.id)
          toast(`${account.label} 已删除`)
          await reload()
        } catch (error) {
          remove.disabled = false
          toast(errorMessage(error), 'bad')
        }
      },
    },
  }))
  remove.append(icon('trash'))
  return el(
    'tr',
    { class: account.enabled ? '' : 'row-muted' },
    el(
      'td',
      {},
      el(
        'div',
        { class: 'cell-title' },
        el('span', { text: account.label }),
        account.priority > 0 ? badge(`P${account.priority}`, 'accent') : null,
      ),
    ),
    el(
      'td',
      { attrs: account.baseUrl === null ? {} : { title: account.baseUrl } },
      el('div', { text: account.provider }),
      el('span', { class: 'muted', text: account.kind }),
    ),
    el('td', {}, badge(account.status, accountTone(account.status))),
    el('td', {}, el('div', { text: formatRelative(account.accessExpiresAt) })),
    el('td', { text: formatRelative(account.refreshDueAt) }),
    el('td', {}, el('div', { text: String(account.failureCount) }), account.lastError === null ? null : el('code', { class: 'tone-bad-text', text: account.lastError })),
    el('td', { class: 'cell-actions' }, el('div', { class: 'table-actions' }, edit, credential, toggle, remove)),
  )
}

/**
 * 新增账号：平台 / 认证方式用选择卡，API Key 与 OAuth 凭据分开输入。
 * 上游地址与优先级随账号一起入库；凭据只上行，不保存、不回显。
 * @param {() => Promise<void>} reload
 */
function openCreateAccountDialog(reload) {
  const label = /** @type {HTMLInputElement} */ (el('input', {
    attrs: { type: 'text', maxlength: '200', placeholder: '例如 Claude 主账号', required: '' },
  }))

  let provider = /** @type {import('../src/contracts.ts').AccountProvider} */ ('openai')
  let kind = /** @type {import('../src/contracts.ts').AccountKind} */ ('api_key')
  const defaultBaseUrls = {
    openai: 'https://api.openai.com/v1',
    claude: '',
    custom: '',
  }
  const baseUrl = /** @type {HTMLInputElement} */ (el('input', {
    attrs: { type: 'text', placeholder: 'https://api.openai.com/v1' },
  }))
  baseUrl.value = defaultBaseUrls.openai
  baseUrl.addEventListener('input', () => {
    baseUrl.dataset.touched = '1'
  })

  const defaultProtocols = {
    openai: 'openai-chat',
    claude: 'anthropic',
    custom: '',
  }
  const protocol = /** @type {HTMLSelectElement} */ (el('select', { class: 'input' }))
  for (const [value, text] of [
    ['', '未声明'],
    ['openai-chat', 'OpenAI Chat'],
    ['openai-responses', 'OpenAI Responses'],
    ['anthropic', 'Anthropic'],
  ]) {
    protocol.append(el('option', { attrs: { value }, text }))
  }
  protocol.value = defaultProtocols.openai
  protocol.addEventListener('change', () => {
    protocol.dataset.touched = '1'
  })

  const apiKey = /** @type {HTMLInputElement} */ (el('input', {
    attrs: { type: 'password', autocomplete: 'off', placeholder: 'sk-...' },
  }))
  const oauth = /** @type {HTMLTextAreaElement} */ (el('textarea', {
    class: 'input',
    attrs: { rows: '6', placeholder: '{"access_token":"...","refresh_token":"..."}', hidden: '' },
  }))
  const credentialLabel = el('label', { text: 'API Key' })
  const credentialField = el(
    'div',
    { class: 'form-field span-2' },
    credentialLabel,
    apiKey,
    oauth,
  )

  const providerCards = new Map()
  const providerGrid = el('div', { class: 'choice-grid', attrs: { role: 'radiogroup', 'aria-label': '平台' } })
  for (const [value, text] of [
    ['openai', 'OpenAI / Codex'],
    ['claude', 'Claude'],
    ['custom', '自定义上游'],
  ]) {
    const card = /** @type {HTMLButtonElement} */ (el('button', {
      class: 'choice-card',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false' },
      text,
      on: { click: () => setProvider(/** @type {any} */ (value)) },
    }))
    providerCards.set(value, card)
    providerGrid.append(card)
  }

  const kindCards = new Map()
  const kindGrid = el('div', { class: 'choice-grid', attrs: { role: 'radiogroup', 'aria-label': '认证方式' } })
  for (const [value, text] of [
    ['oauth', 'OAuth 订阅'],
    ['api_key', 'API Key'],
  ]) {
    const card = /** @type {HTMLButtonElement} */ (el('button', {
      class: 'choice-card',
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false' },
      text,
      on: { click: () => setKind(/** @type {any} */ (value)) },
    }))
    kindCards.set(value, card)
    kindGrid.append(card)
  }

  function renderChoices() {
    for (const [value, card] of providerCards) {
      const active = value === provider
      card.classList.toggle('active', active)
      card.setAttribute('aria-checked', active ? 'true' : 'false')
    }
    for (const [value, card] of kindCards) {
      const active = value === kind
      const disabled = provider === 'custom' && value === 'oauth'
      card.classList.toggle('active', active)
      card.setAttribute('aria-checked', active ? 'true' : 'false')
      card.disabled = disabled
    }
    apiKey.hidden = kind !== 'api_key'
    oauth.hidden = kind !== 'oauth'
    credentialLabel.textContent = kind === 'api_key' ? 'API Key' : 'OAuth 凭据 JSON'
    apiKey.required = kind === 'api_key'
    oauth.required = kind === 'oauth'
  }

  /** @param {import('../src/contracts.ts').AccountProvider} next */
  function setProvider(next) {
    const previousDefault = defaultBaseUrls[provider]
    provider = next
    if (baseUrl.dataset.touched !== '1' || baseUrl.value.trim() === previousDefault) {
      baseUrl.value = defaultBaseUrls[next]
      delete baseUrl.dataset.touched
    }
    baseUrl.placeholder =
      defaultBaseUrls[next] || (next === 'custom' ? 'https://your-upstream.example/v1' : '')
    if (protocol.dataset.touched !== '1') protocol.value = defaultProtocols[next]
    if (next === 'custom' && kind === 'oauth') kind = 'api_key'
    renderChoices()
  }

  /** @param {import('../src/contracts.ts').AccountKind} next */
  function setKind(next) {
    if (provider === 'custom' && next === 'oauth') return
    kind = next
    renderChoices()
  }

  const priority = /** @type {HTMLInputElement} */ (el('input', {
    attrs: { type: 'number', min: '0', max: '1000', step: '1', value: '0' },
  }))
  const enabled = /** @type {HTMLInputElement} */ (el('input', {
    class: 'checkbox',
    attrs: { type: 'checkbox' },
  }))
  enabled.checked = true

  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const cancel = el('button', { class: 'btn', attrs: { type: 'button' }, text: '取消' })
  const create = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light',
    attrs: { type: 'submit' },
    text: '添加账号',
  }))

  const form = el(
    'form',
    {},
    el('div', { class: 'form-section-title', text: '基础信息' }),
    el(
      'div',
      { class: 'form-grid' },
      el('div', { class: 'form-field span-2' }, el('label', { text: '名称' }), label),
      el(
        'div',
        { class: 'form-field span-2' },
        el('label', { text: '平台' }),
        providerGrid,
      ),
      el(
        'div',
        { class: 'form-field span-2' },
        el('label', { text: '认证方式' }),
        kindGrid,
      ),
    ),
    el('div', { class: 'form-section-title', text: '连接与调度' }),
    el(
      'div',
      { class: 'form-grid' },
      el('div', { class: 'form-field' }, el('label', { text: 'Base URL' }), baseUrl),
      el('div', { class: 'form-field' }, el('label', { text: '上游协议' }), protocol),
      el('div', { class: 'form-field' }, el('label', { text: '优先级' }), priority),
      credentialField,
      el(
        'div',
        { class: 'form-field span-2 switch-row' },
        enabled,
        el('label', { text: '启用该账号' }),
      ),
    ),
    error,
    el('div', { class: 'dialog-actions' }, cancel, create),
  )

  const dialog = openDialog('添加账号', form, { wide: true })
  cancel.addEventListener('click', () => dialog.close())
  renderChoices()
  label.focus()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    if (provider === 'custom' && baseUrl.value.trim() === '') {
      error.textContent = '自定义上游必须填写 Base URL'
      error.hidden = false
      return
    }
    create.disabled = true
    try {
      const payload = kind === 'api_key' ? apiKey.value.trim() : oauth.value.trim()
      /** @type {import('../src/contracts.ts').CreateAccountInput} */
      const input = {
        provider,
        kind,
        label: label.value,
        priority: Number(priority.value === '' ? '0' : priority.value),
        enabled: enabled.checked,
        ...(baseUrl.value.trim() === '' ? {} : { baseUrl: baseUrl.value.trim() }),
        ...(protocol.value === ''
          ? {}
          : { protocol: /** @type {import('../src/contracts.ts').AccountProtocol} */ (protocol.value) }),
        ...(payload === ''
          ? {}
          : {
              credential: {
                payload,
                format: kind === 'api_key' ? 'api-key' : 'auto',
              },
            }),
      }
      await api().accounts.create(input)
      toast('账号已添加')
      dialog.close()
      await reload()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      create.disabled = false
    }
  })
}

/**
 * 编辑账号的非秘密字段与调度参数。
 * @param {AccountSummary} account
 * @param {() => Promise<void>} reload
 */
function openEditAccountDialog(account, reload) {
  const label = /** @type {HTMLInputElement} */ (el('input', {
    attrs: { type: 'text', maxlength: '200', value: account.label, required: '' },
  }))
  const baseUrl = /** @type {HTMLInputElement} */ (el('input', {
    attrs: {
      type: 'text',
      value: account.baseUrl ?? '',
      placeholder: 'https://your-upstream.example/v1',
    },
  }))
  const priority = /** @type {HTMLInputElement} */ (el('input', {
    attrs: { type: 'number', min: '0', max: '1000', step: '1', value: String(account.priority) },
  }))
  const protocol = /** @type {HTMLSelectElement} */ (el('select', { class: 'input' }))
  for (const [value, text] of [
    ['', '未声明'],
    ['openai-chat', 'OpenAI Chat'],
    ['openai-responses', 'OpenAI Responses'],
    ['anthropic', 'Anthropic'],
  ]) {
    protocol.append(el('option', { attrs: { value }, text }))
  }
  protocol.value = account.protocol ?? ''
  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const cancel = el('button', { class: 'btn', attrs: { type: 'button' }, text: '取消' })
  const save = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light',
    attrs: { type: 'submit' },
    text: '保存',
  }))
  const form = el(
    'form',
    {},
    el('div', { class: 'form-grid' },
      el('div', { class: 'form-field span-2' }, el('label', { text: '名称' }), label),
      el('div', { class: 'form-field span-2' }, el('label', { text: 'Base URL' }), baseUrl),
      el('div', { class: 'form-field' }, el('label', { text: '上游协议' }), protocol),
      el('div', { class: 'form-field' }, el('label', { text: '优先级' }), priority),
    ),
    error,
    el('div', { class: 'dialog-actions' }, cancel, save),
  )
  const dialog = openDialog(`编辑账号 · ${account.label}`, form, { wide: true })
  cancel.addEventListener('click', () => dialog.close())
  label.focus()
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    save.disabled = true
    try {
      await api().accounts.update(account.id, {
        label: label.value,
        baseUrl: baseUrl.value.trim() === '' ? null : baseUrl.value.trim(),
        protocol: protocol.value === '' ? null : /** @type {import('../src/contracts.ts').AccountProtocol} */ (protocol.value),
        priority: Number(priority.value === '' ? '0' : priority.value),
      })
      toast('账号已更新')
      dialog.close()
      await reload()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      save.disabled = false
    }
  })
}

/**
 * 给已有账号导入 / 重新授权凭据。
 * @param {AccountSummary} account
 * @param {() => Promise<void>} reload
 */
function openImportCredentialsDialog(account, reload) {
  const credential = /** @type {HTMLTextAreaElement} */ (el('textarea', {
    class: 'input',
    attrs: { rows: '6', placeholder: 'API Key 或 OAuth JSON', required: '' },
  }))
  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const cancel = el('button', { class: 'btn', attrs: { type: 'button' }, text: '取消' })
  const save = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-light', attrs: { type: 'submit' }, text: '导入' }))
  const form = el(
    'form',
    {},
    el('div', { class: 'form-field' }, el('label', { text: '凭据' }), credential),
    error,
    el('div', { class: 'dialog-actions' }, cancel, save),
  )
  const dialog = openDialog(`导入凭据 · ${account.label}`, form)
  cancel.addEventListener('click', () => dialog.close())
  credential.focus()
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    save.disabled = true
    try {
      await api().accounts.importCredentials(account.id, { payload: credential.value, format: 'auto' })
      toast('凭据已导入')
      dialog.close()
      await reload()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      save.disabled = false
    }
  })
}

/**
 * 管理台用户页：列表、启用 / 封禁、设为 / 取消 admin、余额显示开关、调整余额、删除。
 * 余额在界面上按「最小单位 → 分」换算显示；输入框明确要求最小单位。
 * @param {FrontendPage} page
 * @returns {Promise<HTMLElement>}
 */
async function renderUsers(page) {
  const section = el(
    'section',
    { class: 'page' },
    pageHead(page),
  )
  if (currentSession?.permissions.admin !== true) {
    section.append(renderForbidden(page))
    return section
  }

  const statusSelect = /** @type {HTMLSelectElement} */ (el(
    'select',
    { class: 'select', attrs: { 'aria-label': '用户状态筛选' } },
    el('option', { text: '全部状态', attrs: { value: '' } }),
    el('option', { text: '启用', attrs: { value: 'enabled' } }),
    el('option', { text: '封禁', attrs: { value: 'banned' } }),
  ))
  const refresh = el('button', { class: 'btn btn-small', attrs: { type: 'button' } }, icon('refresh'), el('span', { text: '刷新' }))
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('label', { class: 'field-inline' }, el('span', { text: '状态' }), statusSelect),
    el('span', { class: 'toolbar-spacer' }),
    refresh,
  )
  const results = el('div', { class: 'results' })
  section.append(toolbar, results)

  const load = async () => {
    results.replaceChildren(loadingState('正在读取用户…'))
    try {
      const response = await api().users.list({
        ...(statusSelect.value === ''
          ? {}
          : { status: /** @type {'enabled' | 'banned'} */ (statusSelect.value) }),
        limit: 200,
      })
      if (response.items.length === 0) {
        results.replaceChildren(el('div', { class: 'empty', text: '没有符合条件的用户。' }))
        return
      }
      results.replaceChildren(
        el(
          'div',
          { class: 'table-wrap table-card' },
          el(
            'table',
            { class: 'data-table user-table' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: '用户' }),
                el('th', { text: '状态' }),
                el('th', { text: '角色' }),
                el('th', { text: '余额' }),
                el('th', { text: '余额可见' }),
                el('th', { text: '' }),
              ),
            ),
            el('tbody', {}, ...response.items.map((user) => userRow(user, load))),
          ),
        ),
      )
    } catch (error) {
      results.replaceChildren(errorState(error, () => void load()))
    }
  }

  statusSelect.addEventListener('change', () => void load())
  refresh.addEventListener('click', () => void load())
  await load()
  return section
}

/**
 * @param {AdminUserSummary} user
 * @param {() => Promise<void>} reload
 * @returns {HTMLElement}
 */
function userRow(user, reload) {
  const act = async (/** @type {() => Promise<unknown>} */ task, /** @type {string} */ message) => {
    try {
      await task()
      await refreshCurrentSession()
      toast(message)
      await reload()
    } catch (error) {
      toast(errorMessage(error), 'bad')
    }
  }

  const toggleStatus = el('button', {
    class: 'btn btn-small',
    attrs: { type: 'button' },
    text: user.status === 'enabled' ? '封禁' : '启用',
    on: {
      click: () =>
        void act(
          () => api().users.update(user.id, { status: user.status === 'enabled' ? 'banned' : 'enabled' }),
          user.status === 'enabled' ? '用户已封禁' : '用户已启用',
        ),
    },
  })
  const toggleRole = el('button', {
    class: 'btn btn-small',
    attrs: { type: 'button' },
    text: user.role === 'admin' ? '取消管理员' : '设为管理员',
    on: {
      click: () =>
        void act(
          () => api().users.update(user.id, { role: user.role === 'admin' ? 'user' : 'admin' }),
          user.role === 'admin' ? '已取消管理员' : '已设为管理员',
        ),
    },
  })
  const toggleBalance = el('button', {
    class: 'btn btn-small',
    attrs: { type: 'button' },
    text: user.balanceEnabled ? '隐藏余额' : '显示余额',
    on: {
      click: () =>
        void act(
          () => api().users.update(user.id, { balanceEnabled: !user.balanceEnabled }),
          user.balanceEnabled ? '余额已隐藏' : '余额已可见',
        ),
    },
  })
  const adjust = el('button', {
    class: 'btn btn-small',
    attrs: { type: 'button' },
    text: '调整余额',
    on: { click: () => openAdjustBalanceDialog(user, reload) },
  })
  const remove = el('button', {
    class: 'btn btn-small btn-danger',
    attrs: { type: 'button' },
    text: '删除',
    on: {
      click: async () => {
        if (!window.confirm(`删除用户「${user.name}」（#${user.id}）？余额不为零时服务端会拒绝。`)) return
        await act(() => api().users.remove(user.id), '用户已删除')
      },
    },
  })

  return el(
    'tr',
    { class: user.status === 'banned' ? 'row-muted' : '' },
    el('td', {}, el('div', { class: 'cell-title', text: user.name })),
    el('td', {}, badge(user.status, user.status === 'enabled' ? 'ok' : 'bad')),
    el('td', {}, badge(user.role === 'admin' ? 'admin' : 'user', user.role === 'admin' ? 'accent' : 'neutral')),
    el('td', {}, el('div', { text: formatMinor(user.balanceMinor) })),
    el('td', { text: user.balanceEnabled ? '显示' : '隐藏' }),
    el('td', { class: 'cell-actions' }, el('div', { class: 'table-actions' }, toggleStatus, toggleRole, toggleBalance, adjust, remove)),
  )
}

/**
 * @param {AdminUserSummary} user
 * @param {() => Promise<void>} reload
 */
function openAdjustBalanceDialog(user, reload) {
  const delta = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'text', inputmode: 'numeric', placeholder: '例如 1000000（= 1 元）' },
  }))
  const reason = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'text', placeholder: '例如 manual top-up' },
  }))
  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const cancel = el('button', { class: 'btn', attrs: { type: 'button' }, text: '取消' })
  const save = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-light', attrs: { type: 'submit' }, text: '应用' }))
  const form = el(
    'form',
    {},
    el(
      'div',
      { class: 'form-field' },
      el('label', { text: '增量（最小单位；1 元 = 1,000,000，负数表示扣减）' }),
      delta,
    ),
    el('div', { class: 'form-field' }, el('label', { text: '原因（必填，会写进余额流水）' }), reason),
    error,
    el('div', { class: 'dialog-actions' }, cancel, save),
  )
  const dialog = openDialog(`调整余额 · ${user.name}`, form)
  cancel.addEventListener('click', () => dialog.close())
  delta.focus()
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    const raw = delta.value.trim()
    if (!/^-?\d+$/.test(raw)) {
      error.textContent = '增量必须是十进制整数字符串（最小单位）'
      error.hidden = false
      return
    }
    if (reason.value.trim() === '') {
      error.textContent = '必须填写原因'
      error.hidden = false
      return
    }
    save.disabled = true
    try {
      const result = await api().users.adjustBalance(user.id, {
        deltaMinor: raw,
        reason: reason.value.trim(),
      })
      toast(`余额已更新：${result.balanceMinor} 最小单位`)
      dialog.close()
      await refreshCurrentSession()
      await reload()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      save.disabled = false
    }
  })
}

/** @param {string} minor @returns {string} */
function formatMinor(minor) {
  try {
    const cents = BigInt(minor) / 10_000n
    const value = Number(cents)
    return Number.isSafeInteger(value) ? formatCny(value) : `${minor} 最小单位`
  } catch {
    return minor
  }
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderCatalog(page) {
  const section = el('section', { class: 'page' }, pageHead(page))
  const results = el('div', { class: 'results' })
  section.append(results)
  results.replaceChildren(loadingState('正在读取模块目录…'))
  try {
    const catalog = await api().catalog.list()
    const counts = new Map()
    for (const module of catalog.modules) counts.set(module.state, (counts.get(module.state) ?? 0) + 1)
    results.replaceChildren(
      el(
        'div',
        { class: 'metrics compact' },
        ...[...counts.entries()].map(([state, count]) => metric(state, String(count))),
      ),
      el(
        'div',
        { class: 'table-wrap table-card' },
        el(
          'table',
          { class: 'data-table' },
          el('thead', {}, el('tr', {}, el('th', { text: '模块' }), el('th', { text: '包' }), el('th', { text: '类型' }), el('th', { text: '状态' }), el('th', { text: '提供' }), el('th', { text: '页面' }))),
          el(
            'tbody',
            {},
            ...catalog.modules.map((module) =>
              el(
                'tr',
                { class: module.state === 'disabled' ? 'row-muted' : '' },
                el('td', {}, el('div', { class: 'cell-title', text: module.id })),
                el('td', {}, el('code', { text: module.package })),
                el('td', { text: module.kind }),
                el('td', {}, badge(module.state, module.state === 'active' ? 'ok' : module.state === 'disabled' ? 'neutral' : 'warn')),
                el('td', {}, el('div', { class: 'tokens' }, ...module.provides.map((name) => el('code', { class: 'token', text: name })))),
                el('td', {}, el('div', { class: 'tokens' }, ...module.pages.map((path) => el('code', { class: 'token', text: path })))),
              ),
            ),
          ),
        ),
      ),
    )
  } catch (error) {
    results.replaceChildren(errorState(error, () => void rerender()))
  }
  return section
}

/**
 * @param {FrontendPage} page
 * @param {NonNullable<ReturnType<ReturnType<typeof createRouter>['resolve']>>} match
 * @returns {Promise<HTMLElement>}
 */
async function renderSettings(page, match) {
  const section = el('section', { class: 'page' }, pageHead(page))
  const cards = manifest().settingsCards
  if (cards.length === 0) {
    section.append(el('div', { class: 'empty', text: '当前没有已启用插件贡献设置卡。' }))
    return section
  }
  const layout = el('div', { class: 'settings-layout' })
  const index = el('aside', { class: 'settings-index' })
  const detail = el('div', { class: 'settings-detail' })
  layout.append(index, detail)
  section.append(layout)

  let namespaces = /** @type {SettingsNamespaceView[]} */ ([])
  let loaded = false
  const loadAll = async () => {
    detail.replaceChildren(loadingState('正在读取设置…'))
    try {
      namespaces = [...(await api().settings.describe()).namespaces]
      loaded = true
      renderIndex()
      renderDetail()
    } catch (error) {
      loaded = false
      detail.replaceChildren(errorState(error, () => void loadAll()))
    }
  }
  const selectedFromQuery = match.query.ns
  let selected = cards.some((card) => card.namespace === selectedFromQuery)
    ? /** @type {string} */ (selectedFromQuery)
    : cards[0].namespace

  const renderIndex = () => {
    index.replaceChildren(
      el('div', { class: 'index-head' }, el('span', { text: '命名空间' }), el('span', { class: 'index-count', text: String(cards.length) })),
      ...cards.map((card) => {
        const view = namespaces.find((item) => item.ns === card.namespace)
        const flags = []
        if (view?.pending === true) flags.push(badge('待应用', 'bad'))
        else if (view?.disabled === true) flags.push(badge('停用', 'neutral'))
        else if (view?.overridden === true) flags.push(badge('有覆盖', 'warn'))
        return el(
          'button',
          {
            class: card.namespace === selected ? 'settings-item active' : 'settings-item',
            attrs: { type: 'button', 'aria-current': card.namespace === selected ? 'true' : 'false' },
            on: {
              click: () => {
                selected = card.namespace
                window.history.replaceState(null, '', routes().href(page.path, { ns: selected }))
                renderIndex()
                renderDetail()
              },
            },
          },
          el('span', { class: 'settings-item-title', text: card.title }),
          el('code', { class: 'settings-item-ns', text: card.namespace }),
          el('span', { class: 'settings-item-flags' }, ...flags),
        )
      }),
    )
  }

  const renderDetail = () => {
    const card = cards.find((item) => item.namespace === selected)
    if (card === undefined) {
      detail.replaceChildren(el('div', { class: 'empty', text: '没有这个设置卡。' }))
      return
    }
    const view = namespaces.find((item) => item.ns === card.namespace)
    if (view === undefined) {
      detail.replaceChildren(
        el(
          'div',
          { class: 'settings-head' },
          el('div', {}, el('h2', { text: card.title })),
          badge('未装载', 'warn'),
        ),
        el('div', { class: 'empty', text: `命名空间 ${card.namespace} 当前不在设置接口的返回里。` }),
      )
      return
    }
    detail.replaceChildren(settingsDetail(card, view, loadAll))
  }

  await loadAll()
  if (loaded && namespaces.length === 0) {
    detail.replaceChildren(el('div', { class: 'empty', text: '设置接口没有返回任何命名空间。' }))
  }
  return section
}

/**
 * @param {FrontendSettingsCard} card
 * @param {SettingsNamespaceView} view
 * @param {() => Promise<void>} reload
 * @returns {HTMLElement}
 */
function settingsDetail(card, view, reload) {
  /** @type {{ input: HTMLInputElement | HTMLSelectElement, path: string, kind: string, initial: string }[]} */
  const inputs = []
  const fields = el('div', { class: 'field-list' })
  addFields(fields, view.fields, inputs, false)

  const save = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-primary', attrs: { type: 'button', disabled: view.writable ? undefined : true }, text: '保存' }))
  const reset = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn btn-danger', attrs: { type: 'button', disabled: view.overridden ? undefined : true }, text: '恢复基线' }))

  save.addEventListener('click', async () => {
    /** @type {Record<string, unknown>} */
    const patch = {}
    for (const input of inputs) {
      const value = readControl(input)
      const current = value === null ? '' : String(value)
      if (current === input.initial) continue
      putPath(patch, input.path, value)
    }
    if (Object.keys(patch).length === 0) {
      toast('没有改动')
      return
    }
    save.disabled = true
    try {
      await api().settings.update(view.ns, patch, view.revision ?? undefined)
      toast(`${view.ns} 已应用`)
      await reload()
    } catch (error) {
      save.disabled = false
      toast(errorMessage(error), 'bad')
      if (error instanceof ApiError && error.code === 'SETTINGS_CONFLICT') await reload()
    }
  })

  reset.addEventListener('click', async () => {
    if (!window.confirm(`清掉 ${view.ns} 的所有覆盖，回到 app.yml 的基线？`)) return
    reset.disabled = true
    try {
      await api().settings.reset(view.ns)
      toast(`${view.ns} 已恢复基线`)
      await reload()
    } catch (error) {
      reset.disabled = false
      toast(errorMessage(error), 'bad')
    }
  })

  const flags = []
  flags.push(badge(view.active ? 'active' : view.disabled ? 'disabled' : 'inactive', view.active ? 'ok' : 'warn'))
  if (view.overridden) flags.push(badge('有覆盖', 'warn'))
  if (view.pending) flags.push(badge(`待应用 · ${view.pendingReason ?? 'unknown'}`, 'bad'))

  return el(
    'div',
    { class: 'settings-detail-inner' },
    el(
      'div',
      { class: 'settings-head' },
      el(
        'div',
        {},
        el('h2', { text: card.title }),
        el('div', { class: 'settings-meta' }, el('code', { text: view.ns }), el('span', { class: 'muted', text: view.plugin }), ...flags),
      ),
      el('div', { class: 'settings-actions' }, el('span', { class: 'revision', text: view.revision === null ? '未覆盖' : `revision ${view.revision}` }), save, reset),
    ),
    fields,
  )
}

/**
 * @param {HTMLElement} host
 * @param {readonly SettingsFieldView[]} fields
 * @param {{ input: HTMLInputElement | HTMLSelectElement, path: string, kind: string, initial: string }[]} inputs
 * @param {boolean} nested
 */
function addFields(host, fields, inputs, nested) {
  for (const field of fields) {
    if (field.children !== undefined) {
      host.append(
        el(
          'div',
          { class: 'field-group' },
          el('span', { class: 'field-group-label', text: field.label }),
          el('code', { class: 'field-group-path', text: field.path }),
        ),
      )
      addFields(host, field.children, inputs, true)
      continue
    }

    const control = field.writable ? buildControl(field, inputs) : null
    let valueNode
    if (field.secret) {
      valueNode = control ?? badge(field.configured === true ? '已配置' : '未配置', field.configured === true ? 'ok' : 'neutral')
    } else if (control !== null) {
      valueNode = control
    } else {
      valueNode = el('code', { class: 'field-value', text: field.kind === 'object' ? '（对象）' : display(field.value) })
    }

    host.append(
      el(
        'div',
        { class: nested ? 'field-row nested' : 'field-row' },
        el('div', { class: 'field-key' }, el('span', { class: 'field-label', text: field.label }), el('code', { class: 'field-path', text: field.path })),
        el('div', { class: 'field-control' }, valueNode),
      ),
    )
  }
}

/**
 * @param {SettingsFieldView} field
 * @param {{ input: HTMLInputElement | HTMLSelectElement, path: string, kind: string, initial: string }[]} inputs
 * @returns {HTMLElement}
 */
function buildControl(field, inputs) {
  /** @type {HTMLInputElement | HTMLSelectElement} */
  let input
  if (field.kind === 'boolean') {
    const checkbox = /** @type {HTMLInputElement} */ (el('input', { class: 'checkbox', attrs: { type: 'checkbox' } }))
    checkbox.checked = field.value === true
    input = checkbox
  } else if (field.kind === 'enum' && field.values !== undefined) {
    const select = /** @type {HTMLSelectElement} */ (el('select', { class: 'select' }))
    select.append(el('option', { text: '（未设置）', attrs: { value: '' } }))
    for (const value of field.values) select.append(el('option', { text: value, attrs: { value } }))
    select.value = field.value === undefined || field.value === null ? '' : String(field.value)
    input = select
  } else if (field.kind === 'integer') {
    const number = /** @type {HTMLInputElement} */ (el('input', { class: 'input', attrs: { type: 'number', placeholder: '留空 = 删除该键' } }))
    if (field.value !== undefined && field.value !== null) number.value = String(field.value)
    if (field.min !== undefined) number.min = String(field.min)
    if (field.max !== undefined) number.max = String(field.max)
    input = number
  } else {
    const text = /** @type {HTMLInputElement} */ (el('input', { class: 'input', attrs: { type: 'text', placeholder: '留空 = 删除该键' } }))
    if (field.value !== undefined && field.value !== null) text.value = String(field.value)
    input = text
  }

  const initial = input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value
  inputs.push({ input, path: field.path, kind: field.kind, initial })
  input.dataset.path = field.path
  input.dataset.kind = field.kind
  const wrapper = el('div', { class: 'control' }, input)
  if (field.unit !== undefined) wrapper.append(el('span', { class: 'unit', text: field.unit }))
  return wrapper
}

/**
 * @param {{ input: HTMLInputElement | HTMLSelectElement, kind: string }} control
 * @returns {string | number | boolean | null}
 */
function readControl(control) {
  if (control.input instanceof HTMLInputElement && control.input.type === 'checkbox') return control.input.checked
  const raw = control.input.value.trim()
  if (raw === '') return null
  if (control.kind === 'integer') {
    const number = Number(raw)
    return Number.isFinite(number) ? number : raw
  }
  return raw
}

/**
 * @param {Record<string, unknown>} target
 * @param {string} path
 * @param {unknown} value
 */
function putPath(target, path, value) {
  const parts = path.split('.')
  let node = target
  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index]
    const next = node[key]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) node[key] = {}
    node = /** @type {Record<string, unknown>} */ (node[key])
  }
  node[parts[parts.length - 1]] = value
}

/** @param {FrontendPage} page @returns {HTMLElement} */
function renderRedirect(page) {
  if (page.view.kind !== 'redirect' || page.view.to === page.path) {
    return el('section', { class: 'page' }, pageHead(page), errorState(new Error('redirect 目标非法')))
  }
  routes().navigate(page.view.to, { replace: true })
  queueMicrotask(() => void rerender())
  return el('section', { class: 'page' }, loadingState(`正在转到 ${page.view.to}…`))
}

/** @param {FrontendPage} page @returns {HTMLElement} */
function renderPlaceholder(page) {
  return el(
    'section',
    { class: 'page' },
    pageHead(page),
    el(
      'div',
      { class: 'placeholder', attrs: { 'data-placeholder': 'reference-design-missing' } },
      el('div', { class: 'placeholder-label', text: '等待参考设计' }),
    ),
  )
}

/** @param {FrontendPage} page @returns {Promise<HTMLElement>} */
async function renderRemote(page) {
  const view = page.view
  if (view.kind !== 'remote') throw new Error('remote 页面类型不匹配')
  const url = new URL(view.module, window.location.origin)
  if (url.origin !== window.location.origin) {
    return el('section', { class: 'page' }, pageHead(page), errorState(new Error('远程页面模块必须与 SPA 同源')))
  }
  const module = await import(url.href)
  const mount = module[view.exportName ?? 'default']
  if (typeof mount !== 'function') {
    return el('section', { class: 'page' }, pageHead(page), errorState(new Error('远程页面模块没有导出 mount 函数')))
  }
  const host = el('div', { class: 'remote-page' })
  const section = el('section', { class: 'page' }, pageHead(page), host)
  const cleanup = await mount(host, {
    api: api(),
    page,
    manifest: manifest(),
    href: (/** @type {string} */ path) => routes().href(path),
    navigate: (/** @type {string} */ path) => routes().navigate(path),
  })
  if (typeof cleanup === 'function') pageCleanup = cleanup
  return section
}

/** @param {string} path @returns {HTMLElement} */
function renderNotFound(path) {
  const data = manifest()
  const links = /** @type {FrontendArea[]} */ (['console', 'admin']).flatMap((area) => {
    const root = areaRoot(data, area)
    return root === undefined ? [] : [el('a', { class: 'btn', attrs: { href: routes().href(root.path) }, text: data.areas[area].label })]
  })
  return el(
    'section',
    { class: 'page' },
    el(
      'header',
      { class: 'page-head' },
      el('div', { class: 'eyebrow' }, el('span', { class: 'eyebrow-path', text: path })),
      el('h1', { text: '没有这个页面' }),
    ),
    el('div', { class: 'not-found-actions' }, ...links),
  )
}

// ─────────────────────────────── 登录 / 注册 / 找回 ───────────────────────────────

/** 停掉外壳（路由、健康轮询、页面清理），回到登录界面时调用。 */
function teardownShell() {
  if (healthTimer !== undefined) {
    window.clearInterval(healthTimer)
    healthTimer = undefined
  }
  if (routerStop !== null) {
    routerStop()
    routerStop = null
  }
  if (pageCleanup !== null) {
    const cleanup = pageCleanup
    pageCleanup = null
    try {
      void cleanup()
    } catch {
      // 页面自己的清理失败不应阻断退出登录。
    }
  }
  renderToken += 1
  router = null
}

/** @param {string} message */
function showLogin(message) {
  teardownShell()
  currentSession = null
  if (appRoot === null) return
  applyTheme(readTheme())
  appRoot.replaceChildren(renderAuth('login', message))
}

async function logout() {
  try {
    await api().session.logout()
  } catch (error) {
    if (!isUnauthorized(error)) toast(errorMessage(error), 'bad')
  }
  showLogin('已退出登录')
}

/** 登录成功后读取完整会话（含权限与邮箱），再启动外壳。 */
async function finishLogin() {
  currentSession = await api().session.get()
  await startShell()
}

/**
 * @param {'login' | 'register' | 'reset'} [mode]
 * @param {string} [message]
 * @returns {HTMLElement}
 */
function renderAuth(mode = 'login', message) {
  const shell = el('div', { class: 'auth-shell' })
  const card = el('div', { class: 'auth-card card' })
  shell.append(card)

  const body = el('div', { class: 'auth-body' })
  const title =
    mode === 'register' ? '创建账号' : mode === 'reset' ? '找回密码' : '登录 DizzyAPI'
  const tabs = el(
    'div',
    { class: 'auth-tabs', attrs: { role: 'tablist', 'aria-label': '登录方式' } },
    authTab('登录', mode === 'login', () => appRoot?.replaceChildren(renderAuth('login'))),
    authTab('注册', mode === 'register', () => appRoot?.replaceChildren(renderAuth('register'))),
    authTab('找回密码', mode === 'reset', () => appRoot?.replaceChildren(renderAuth('reset'))),
  )

  /** @type {(Node | string)[]} */
  const head = [
    el(
      'div',
      { class: 'auth-head' },
      el('span', { class: 'wordmark-mark' }, icon('mark')),
      el('span', { class: 'auth-brand', text: 'DizzyAPI' }),
    ),
    el('h1', { class: 'auth-title', text: title }),
    tabs,
  ]
  if (message !== undefined) {
    head.push(el('p', { class: 'auth-message', attrs: { role: 'status' }, text: message }))
  }
  head.push(body)
  card.append(...head)

  if (mode === 'login') renderLoginForm(body)
  else if (mode === 'reset') renderResetForm(body)
  else renderRegisterForm(body)
  return shell
}

/**
 * @param {string} label
 * @param {boolean} active
 * @param {() => void} onClick
 * @returns {HTMLButtonElement}
 */
function authTab(label, active, onClick) {
  return /** @type {HTMLButtonElement} */ (el('button', {
    class: active ? 'auth-tab active' : 'auth-tab',
    attrs: { type: 'button', role: 'tab', 'aria-selected': active ? 'true' : 'false' },
    text: label,
    on: { click: onClick },
  }))
}

/**
 * @param {HTMLElement} host
 * @param {string} label
 * @param {HTMLInputElement} input
 * @returns {HTMLElement}
 */
function authField(host, label, input) {
  host.append(el('div', { class: 'form-field' }, el('label', { text: label }), input))
  return host
}

/** @param {HTMLElement} body */
function renderLoginForm(body) {
  const email = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'email', autocomplete: 'username', required: '' },
  }))
  const password = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: 'current-password', required: '' },
  }))
  const error = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const submit = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light auth-submit',
    attrs: { type: 'submit' },
    text: '登录',
  }))
  const form = el('form', { class: 'auth-form' })
  authField(form, '邮箱', email)
  authField(form, '密码', password)
  form.append(error, submit)
  body.append(form)
  email.focus()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    error.hidden = true
    submit.disabled = true
    try {
      await api().session.login({ email: email.value, password: password.value })
      await finishLogin()
    } catch (caught) {
      error.textContent = errorMessage(caught)
      error.hidden = false
      submit.disabled = false
    }
  })
}

/** @param {HTMLElement} body */
function renderRegisterForm(body) {
  const email = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'email', autocomplete: 'username', required: '' },
  }))
  const password = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: 'new-password', required: '' },
  }))
  const name = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'text', autocomplete: 'nickname', maxlength: '64', placeholder: '可选；默认取邮箱前缀' },
  }))
  const code = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6 位验证码' },
  }))
  const requestError = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const confirmError = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const request = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light auth-submit',
    attrs: { type: 'submit' },
    text: '发送验证码',
  }))
  const confirm = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light auth-submit',
    attrs: { type: 'submit' },
    text: '验证并注册',
  }))
  const requestForm = el('form', { class: 'auth-form' })
  authField(requestForm, '邮箱', email)
  authField(requestForm, '密码（至少 8 位）', password)
  authField(requestForm, '用户名', name)
  requestForm.append(requestError, request)

  const confirmForm = el('form', { class: 'auth-form', attrs: { hidden: '' } })
  authField(confirmForm, '验证码', code)
  confirmForm.append(confirmError, confirm)
  body.append(requestForm, confirmForm)

  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    requestError.hidden = true
    request.disabled = true
    try {
      await api().session.registerRequest({
        email: email.value,
        password: password.value,
        ...(name.value.trim() === '' ? {} : { name: name.value }),
      })
      requestForm.hidden = true
      confirmForm.hidden = false
      code.focus()
      toast('验证码已发送')
    } catch (caught) {
      requestError.textContent = errorMessage(caught)
      requestError.hidden = false
      request.disabled = false
    }
  })

  confirmForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    confirmError.hidden = true
    confirm.disabled = true
    try {
      await api().session.registerConfirm({ email: email.value, code: code.value })
      await finishLogin()
    } catch (caught) {
      confirmError.textContent = errorMessage(caught)
      confirmError.hidden = false
      confirm.disabled = false
    }
  })

  email.focus()
}

/** @param {HTMLElement} body */
function renderResetForm(body) {
  const email = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'email', autocomplete: 'username', required: '' },
  }))
  const code = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '6 位验证码' },
  }))
  const password = /** @type {HTMLInputElement} */ (el('input', {
    class: 'input',
    attrs: { type: 'password', autocomplete: 'new-password', required: '' },
  }))
  const requestError = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const confirmError = el('p', { class: 'error-message', attrs: { hidden: '' } })
  const request = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light auth-submit',
    attrs: { type: 'submit' },
    text: '发送验证码',
  }))
  const confirm = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-light auth-submit',
    attrs: { type: 'submit' },
    text: '重置密码',
  }))
  const requestForm = el('form', { class: 'auth-form' })
  authField(requestForm, '邮箱', email)
  requestForm.append(requestError, request)

  const confirmForm = el('form', { class: 'auth-form', attrs: { hidden: '' } })
  authField(confirmForm, '验证码', code)
  authField(confirmForm, '新密码（至少 8 位）', password)
  confirmForm.append(confirmError, confirm)

  body.append(requestForm, confirmForm)

  requestForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    requestError.hidden = true
    request.disabled = true
    try {
      await api().session.requestPasswordReset({ email: email.value })
      requestForm.hidden = true
      confirmForm.hidden = false
      code.focus()
      toast('验证码已发送')
    } catch (caught) {
      requestError.textContent = errorMessage(caught)
      requestError.hidden = false
      request.disabled = false
    }
  })

  confirmForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    confirmError.hidden = true
    confirm.disabled = true
    try {
      await api().session.confirmPasswordReset({
        email: email.value,
        code: code.value,
        password: password.value,
      })
      showLogin('密码已重置，请用新密码登录')
    } catch (caught) {
      confirmError.textContent = errorMessage(caught)
      confirmError.hidden = false
      confirm.disabled = false
    }
  })

  email.focus()
}

// ─────────────────────────────── 路由 ───────────────────────────────

async function rerender() {
  if (router === null) return
  await routeTo(router.resolve(window.location.pathname, window.location.search))
}

/**
 * @param {NonNullable<ReturnType<ReturnType<typeof createRouter>['resolve']>> | null} match
 */
async function routeTo(match) {
  const token = ++renderToken
  if (pageCleanup !== null) {
    try {
      await pageCleanup()
    } catch {
      // 页面自己的清理失败不应阻断导航。
    }
    pageCleanup = null
  }
  renderShell(manifest(), match)
  const main = document.getElementById('main')
  if (main === null) return
  if (match === null) {
    main.replaceChildren(renderNotFound(window.location.pathname))
    return
  }
  const page = asPage(match.route.data)
  if (page === undefined) {
    main.replaceChildren(renderNotFound(window.location.pathname))
    return
  }
  document.title = `${page.title} · DizzyAPI`
  try {
    const node = await renderPage(page, match)
    if (token !== renderToken) return
    main.replaceChildren(node)
    main.focus({ preventScroll: true })
    window.scrollTo({ top: 0, behavior: 'auto' })
  } catch (error) {
    if (token !== renderToken) return
    main.replaceChildren(errorState(error, () => void rerender()))
  }
}

// ─────────────────────────────── 启动 ───────────────────────────────

/**
 * 会话就绪后启动外壳。登录、注册、刷新页面最终都走这里。
 * 先 teardown 再建路由，避免退出登录后残留的 popstate 监听器把界面又拉回旧页面。
 */
async function startShell() {
  teardownShell()
  if (currentManifest === null) throw new Error('manifest 尚未加载')
  router = createRouter({
    base: boot.basePath ?? '',
    routes: currentManifest.pages.map((page) => ({ path: page.path, data: page })),
  })
  routerStop = router.start((match) => {
    void routeTo(match)
  })
  await routeTo(router.resolve(window.location.pathname, window.location.search))
  healthTimer = window.setInterval(() => void refreshHealth(), 30_000)
}

async function bootApp() {
  applyTheme(readTheme())
  apis = boot.mode === 'mock' ? createMockApis({ latencyMs: boot.mockLatencyMs ?? 120 }) : createHttpApis({ baseUrl: boot.apiBase ?? '/api' })
  if (appRoot === null) throw new Error('缺少 #app 容器')
  try {
    currentManifest = await api().console.manifest()
  } catch (error) {
    appRoot.replaceChildren(
      el(
        'div',
        { class: 'fatal' },
        el('div', { class: 'fatal-mark' }, icon('mark')),
        el('h1', { text: '前端清单加载失败' }),
        errorState(error, () => window.location.reload()),
      ),
    )
    return
  }

  try {
    currentSession = await api().session.get()
  } catch (error) {
    if (isUnauthorized(error)) {
      appRoot.replaceChildren(renderAuth('login'))
      return
    }
    appRoot.replaceChildren(
      el(
        'div',
        { class: 'fatal' },
        el('div', { class: 'fatal-mark' }, icon('mark')),
        el('h1', { text: '会话加载失败' }),
        errorState(error, () => window.location.reload()),
      ),
    )
    return
  }

  await startShell()
}

window.addEventListener('beforeunload', () => {
  if (healthTimer !== undefined) window.clearInterval(healthTimer)
})

void bootApp()
