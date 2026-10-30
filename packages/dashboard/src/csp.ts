/**
 * CSP：给静态导出的 HTML 补 nonce。
 *
 * 为什么必须改写字节：`output: "export"` 没有 middleware / 服务端运行时，
 * Next 没法在构建期就给 hydration 数据与 `theme-boot` 里那两段内联 `<script>`
 * 写上一个每次响应都不同的 nonce。所以由插件在**发 HTML 的那一刻**做三件事：
 *
 * 1. 生成一个随机 nonce；
 * 2. 给**没有 `src` 的内联 script** 加上 `nonce="…"`（外部脚本不需要、也不加）；
 * 3. 响应头写 `script-src 'self' 'nonce-…'`。
 *
 * 不接受的做法（明确写在这里，避免以后有人图省事）：
 *
 * - 不放开 `script-src 'unsafe-inline'` / `'unsafe-eval'`；
 * - 不为「少改写一次字节」而把 nonce 固定成常量（固定等于公开，等于 inline）。
 *
 * 关于 `style-src`：shadcn / Radix 的浮层定位与侧栏宽度是靠 React 的 `style`
 * 属性（内联 style 属性）实现的，`style-src 'self'` 会把它们全部丢掉，弹窗会
 * 定位错乱。这里只放开 **style 属性**（`style-src-attr 'unsafe-inline'`），
 * `<style>` 元素仍受 `style-src 'self'` 约束 —— 这是比 `style-src 'unsafe-inline'`
 * 严格得多的最小放开，理由与证据见 `packages/dashboard/README.md`。
 */
import { randomBytes } from 'node:crypto'

/** 生成一次响应用的 nonce（16 字节 base64）。 */
export function newNonce(): string {
  return randomBytes(16).toString('base64')
}

/** 没有 `src` 的 `<script …>` 开标签。 */
const INLINE_SCRIPT = /<script\b([^>]*)>/gi
const HAS_SRC = /(?:^|\s)src\s*=/i
const HAS_NONCE = /(?:^|\s)nonce\s*=/i

/**
 * 给 HTML 里所有内联 `<script>` 加 nonce；带 `src` 的（同源外部脚本）不动。
 * 已经带 nonce 的也不重复加（幂等，便于测试与二次处理）。
 */
export function injectScriptNonce(html: string, nonce: string): string {
  return html.replace(INLINE_SCRIPT, (whole: string, attrs: string) => {
    if (HAS_SRC.test(attrs)) return whole
    if (HAS_NONCE.test(attrs)) return whole
    return `<script nonce="${nonce}"${attrs}>`
  })
}

/** 每次响应一条的 CSP 头。 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}
