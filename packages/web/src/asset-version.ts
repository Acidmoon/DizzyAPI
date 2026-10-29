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

/** 页面 `<link rel="stylesheet">` 该用的地址（带版本串）。 */
export const APP_CSS_HREF = `/assets/app.css?v=${shortHash(APP_CSS_BODY)}`

/** 页面 `<script src>` 该用的地址（带版本串）。 */
export const APP_JS_HREF = `/assets/app.js?v=${shortHash(APP_JS_BODY)}`
