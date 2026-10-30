/**
 * 静态资源的**版本化 URL**：`/assets/app.css?v=<内容哈希>`。
 *
 * 为什么需要：这些资源用 `Cache-Control: public, max-age=31536000, immutable` 发出去
 * （一年不可变、连重新验证都不做）。`immutable` 只有在 **URL 随内容变化** 时才成立——
 * 路径固定而内容天天变的话，回访浏览器会一直用旧 CSS/JS 直到用户手动清缓存。
 * vendor 库同理（升级一个带安全修复的库却发不出去，比不发更糟）。
 *
 * 哈希算的是**字节内容的 sha256 前 8 位**：进程启动算一次，之后走常量。
 * 改样式/脚本 → 哈希变 → 浏览器重新拉；没改 → 哈希不变 → 命中本地缓存。
 *
 * 两个已知边界：
 * 1. `app.css` 的哈希**不含** `font-smiley` 追加的 `@font-face`（那个块要运行时才有，
 *    而它在服务端渲染 `<link>` 之前拿不到）。字体 URL 自己的版本问题见 AGENTS.md 的债。
 * 2. 哈希是进程内常量：改了文件要重启进程才会换 URL（本项目的部署就是重启）。
 */
import { createHash } from 'node:crypto'
import {
  CLIENT_JS,
  COMPONENT_CSS,
  LAYOUT_CSS,
  MODAL_CSS,
  PAGE_CSS,
  THEME_CSS_PATH,
  VENDOR_THEME_CSS,
  vendorCss,
} from '@dizzyapi/plugin-page-template'
import { COPY_JS } from './client-extras.ts'

/** 内容的短哈希（sha256 前 8 位十六进制）。 */
export function shortHash(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

/** `/assets/app.css` 的正文（与 `web` 路由发出去的逐字节一致）。 */
export const APP_CSS_BODY = [
  PAGE_CSS,
  COMPONENT_CSS,
  LAYOUT_CSS,
  MODAL_CSS,
  '\n',
  vendorCss(),
  '\n',
  VENDOR_THEME_CSS,
  '\n',
].join('')

/** `/assets/app.js` 的正文（与 `web` 路由发出去的逐字节一致）。 */
export const APP_JS_BODY = `${CLIENT_JS}\n${COPY_JS}`

/** 页面 `<script src>` 该用的地址（带版本串）。 */
export const APP_JS_HREF = `/assets/app.js?v=${shortHash(APP_JS_BODY)}`

let cachedFontCss: string | undefined
let cachedCssHref = ''

/**
 * 页面 `<link rel="stylesheet">` 该用的地址（带版本串）。
 *
 * **必须把 `fontCss` 算进哈希**，不能做成常量：`/assets/app.css` 实际发出去的正文是
 * `APP_CSS_BODY + fontSmiley.css()`，字体块要运行时才有（`font-smiley` 可能没装载、
 * `scope` 也可能被配置改）。只哈希 `APP_CSS_BODY` 的话，改字体 scope / 换字体版本时
 * URL 不变 —— 回访浏览器一年内还在用旧 CSS，跟「完全没有版本串」是同一类 bug。
 *
 * 按 `fontCss` 记忆：同一份字体 CSS 下哈希只算一次。
 */
export function appCssHref(fontCss: string): string {
  if (cachedFontCss === fontCss) return cachedCssHref
  cachedCssHref = `/assets/app.css?v=${shortHash(`${APP_CSS_BODY}${fontCss}`)}`
  cachedFontCss = fontCss
  return cachedCssHref
}

/**
 * `/assets/theme.css` 的地址（用户偏好那张样式表）。
 *
 * 与 `app.css` 同一套规则：**地址带内容哈希**。不同的是它按用户生成，所以：
 * - 响应必须是 `Cache-Control: private, no-store`（共享缓存绝不能把 A 的字号发给 B）；
 * - 哈希由 `web` 按当前用户的偏好 CSS 现算，同一份偏好稳定、改档位立刻变。
 */
export function themeCssHref(themeCss: string): string {
  return `${THEME_CSS_PATH}?v=${shortHash(themeCss)}`
}
