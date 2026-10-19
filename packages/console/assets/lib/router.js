/**
 * 零依赖的 History 路由。
 *
 * 设计目标只有三个：
 * 1. **路径路由**（不是 hash）：`/console`、`/admin/accounts` 都能直接打开；
 *    服务器 / 反代必须把非资源路径回落到 index.html（见 DESIGN.md）。
 * 2. **base 前缀**：反代挂在 `/app` 下时，内部仍用 `/console`、`/admin` 匹配。
 * 3. **可测试**：匹配、查询串、href 构造都是纯函数，不碰 `window`。
 *
 * 页面清单来自服务端 manifest；这里只做“路径 → 清单条目”的匹配与点击拦截。
 */

/**
 * @typedef {{ readonly path: string, readonly data?: unknown }} RouteDefinition
 * @typedef {{ readonly route: RouteDefinition, readonly path: string, readonly params: Readonly<Record<string, string>> }} RouteMatch
 * @typedef {RouteMatch & { readonly query: Readonly<Record<string, string>> }} RouterMatch
 * @typedef {{ readonly base: string, readonly routes: readonly RouteDefinition[], readonly windowRef?: Window }} RouterOptions
 * @typedef {{
 *   readonly base: string,
 *   readonly routes: readonly RouteDefinition[],
 *   match(pathname: string): RouteMatch | null,
 *   resolve(pathname: string, search?: string): RouterMatch | null,
 *   href(path: string, query?: Readonly<Record<string, string>>): string,
 *   navigate(path: string, options?: { readonly replace?: boolean, readonly state?: unknown }): void,
 *   start(handler: (match: RouterMatch | null) => void): () => void,
 * }} Router
 */

/**
 * `'/'` 与 `'/app/'` 归一成 `''` / `'/app'`。
 * @param {string} base
 * @returns {string}
 */
export function normalizeBase(base) {
  if (typeof base !== 'string' || base === '' || base === '/') return ''
  if (!base.startsWith('/')) throw new Error(`base 必须以 / 开头：${base}`)
  if (base.includes('?') || base.includes('#')) throw new Error(`base 不能含查询串或片段：${base}`)
  return base.replace(/\/+$/, '')
}

/**
 * 去掉尾斜杠；根保持 `/`。
 * @param {string} pathname
 * @returns {string}
 */
export function normalizePath(pathname) {
  if (typeof pathname !== 'string' || pathname === '') return '/'
  let path = pathname.startsWith('/') ? pathname : `/${pathname}`
  if (path.length > 1) path = path.replace(/\/+$/, '')
  return path === '' ? '/' : path
}

/**
 * 命中 base 时返回去掉前缀的路径；不在 base 下返回 null。
 * `/app` 本身视作 `/`。
 * @param {string} pathname
 * @param {string} base
 * @returns {string | null}
 */
export function stripBase(pathname, base) {
  const normalized = normalizePath(pathname)
  if (base === '') return normalized
  if (normalized === base) return '/'
  if (normalized.startsWith(`${base}/`)) return normalized.slice(base.length) || '/'
  return null
}

/**
 * 把站内路径拼到 base 前；path 可以带查询串。
 * @param {string} base
 * @param {string} path
 * @returns {string}
 */
export function joinBase(base, path) {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base}${suffix}`
}

/**
 * 查询串 → 普通对象；重复键取最后一个。
 * @param {string} search
 * @returns {Record<string, string>}
 */
export function parseQuery(search) {
  /** @type {Record<string, string>} */
  const query = {}
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  for (const [key, value] of params) query[key] = value
  return query
}

/**
 * 按清单条目匹配路径。支持 `:param` 与末尾 `*`；静态段优先于动态段。
 * @param {readonly RouteDefinition[]} routes
 * @param {string} pathname
 * @returns {RouteMatch | null}
 */
export function matchRoutes(routes, pathname) {
  const path = normalizePath(pathname)
  const segments = splitSegments(path)
  const ordered = [...routes].sort((a, b) => dynamicCount(a.path) - dynamicCount(b.path))

  for (const route of ordered) {
    const pattern = splitSegments(normalizePath(route.path))
    const params = matchSegments(pattern, segments)
    if (params !== null) return { route, path, params }
  }
  return null
}

/**
 * @param {RouterOptions} options
 * @returns {Router}
 */
export function createRouter(options) {
  const base = normalizeBase(options.base)
  const routes = options.routes

  /** @param {string} path @param {Readonly<Record<string, string>>} [query] */
  const href = (path, query) => {
    const withQuery =
      query === undefined || Object.keys(query).length === 0
        ? path
        : `${path}${path.includes('?') ? '&' : '?'}${new URLSearchParams(query).toString()}`
    return joinBase(base, withQuery)
  }

  return {
    base,
    routes,
    match(pathname) {
      const stripped = stripBase(pathname, base)
      return stripped === null ? null : matchRoutes(routes, stripped)
    },
    resolve(pathname, search = '') {
      const match = this.match(pathname)
      return match === null ? null : { ...match, query: parseQuery(search) }
    },
    href,
    navigate(path, navigation = {}) {
      const win = options.windowRef ?? globalThis.window
      if (win === undefined) throw new Error('navigate 需要 window')
      const target = joinBase(base, path.startsWith('/') ? path : `/${path}`)
      if (navigation.replace === true) win.history.replaceState(navigation.state ?? null, '', target)
      else win.history.pushState(navigation.state ?? null, '', target)
    },
    start(handler) {
      const win = options.windowRef ?? globalThis.window
      if (win === undefined) throw new Error('start 需要 window')

      const onPopState = () => {
        handler(this.resolve(win.location.pathname, win.location.search))
      }
      /** @param {MouseEvent} event */
      const onClick = (event) => {
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const target = event.target
        if (!(target instanceof Element)) return
        const anchor = /** @type {HTMLAnchorElement | null} */ (target.closest('a[href]'))
        if (anchor === null) return
        if (anchor.hasAttribute('download')) return
        const anchorTarget = anchor.getAttribute('target')
        if (anchorTarget !== null && anchorTarget !== '' && anchorTarget !== '_self') return

        let url
        try {
          url = new URL(anchor.href)
        } catch {
          return
        }
        if (url.origin !== win.location.origin) return
        if (stripBase(url.pathname, base) === null) return

        event.preventDefault()
        win.history.pushState(null, '', url.pathname + url.search + url.hash)
        handler(this.resolve(url.pathname, url.search))
      }

      win.addEventListener('popstate', onPopState)
      win.document.addEventListener('click', onClick)
      return () => {
        win.removeEventListener('popstate', onPopState)
        win.document.removeEventListener('click', onClick)
      }
    },
  }
}

/** @param {string} path @returns {string[]} */
function splitSegments(path) {
  return normalizePath(path).split('/').filter((segment) => segment !== '')
}

/** @param {string} path */
function dynamicCount(path) {
  return splitSegments(path).filter((segment) => segment.startsWith(':') || segment === '*').length
}

/**
 * @param {readonly string[]} pattern
 * @param {readonly string[]} segments
 * @returns {Readonly<Record<string, string>> | null}
 */
function matchSegments(pattern, segments) {
  /** @type {Record<string, string>} */
  const params = {}
  let index = 0
  for (; index < pattern.length; index++) {
    const part = pattern[index]
    if (part === '*') return params
    const segment = segments[index]
    if (segment === undefined) return null
    if (part.startsWith(':')) {
      try {
        params[part.slice(1)] = decodeURIComponent(segment)
      } catch {
        return null
      }
      continue
    }
    let decoded
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (part !== decoded) return null
  }
  return index === segments.length ? params : null
}
