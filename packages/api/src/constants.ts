/**
 * 产品 HTTP 入口共享的常量（从 http.ts 头部搬出来，供 routes/* 与 http.ts 共用）。
 *
 * 放在独立文件是为了避免 routes/* 反向 import http.ts 形成运行期环。
 */
/** 写操作在白名单里自报的身份；必须出现在 user / account-admin / settings 的 adminPlugins 里。 */
export const API_ACTOR = '@dizzyapi/plugin-api'

/** `/api/*` 的自定义请求头值。 */
export const API_REQUEST_HEADER = 'dizzyapi'

export const API_VERSION = '0.1.0'

export const NO_STORE = 'no-store'

export const IMMUTABLE = 'public, max-age=31536000, immutable'

// 头像允许 https:// 外链（user 插件接受这种值）；http:// 刻意不放开。
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export const USAGE_RANGE_DAYS: Readonly<Record<string, number>> = { '7d': 7, '30d': 30, '90d': 90 }

/** 导出只受内存与响应体限制；上限防止一次管理操作把整库读进内存。 */
export const ADMIN_USAGE_EXPORT_LIMIT = 100_000

/** 管理概览分页读用户时的页大小；user 服务单页上限就是 1000。 */
export const STATS_USER_PAGE = 1_000

export const STATS_USER_MAX_PAGES = 100

export type UsageRange = '7d' | '30d' | '90d'
