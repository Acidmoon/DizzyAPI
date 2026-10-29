/**
 * vendor 的第三方前端库：**字节读取 + 加载顺序**的唯一源。
 *
 * 为什么需要这一层：`page-template` 原先既没有 `assets/` 目录、也没有「发字节」的接口，
 * 只有 render/format 方法。控件库要能被浏览器加载，必须有人把字节发出去——
 * 照 `font-smiley` 的 `file()` 形态，由 `pageTemplate` 提供字节、`web` 转发到
 * `/assets/vendor/*`。
 *
 * 两个设计约束：
 *
 * 1. **只认白名单里的相对路径**，不接受任意路径（不做路径拼接、不做 `..` 过滤，
 *    而是查表）。这样「发字节」这个接口天然不可能被用来读别的文件。
 * 2. **顺序是契约**，写在这里而不是散在 `web` 里：`floating-ui.dom` 依赖
 *    `floating-ui.core` 暴露的全局；`/assets/app.js` 必须排在所有库之后
 *    （它要初始化控件，并在 htmx 之后改 `htmx.config`）。
 */
import { readFileSync } from 'node:fs'

/** 浏览器侧加载前缀；`web` 按它注册路由，页面按它拼 `href`。 */
export const VENDOR_ASSET_PREFIX = '/assets/vendor/'

export interface VendorFile {
  /** 相对 `assets/vendor/` 的路径，同时就是 URL 里 `/assets/vendor/` 之后的部分。 */
  readonly name: string
  readonly contentType: string
  readonly body: Buffer
}

const JS = 'text/javascript; charset=utf-8'
const CSS = 'text/css; charset=utf-8'

/**
 * 白名单：相对路径 → Content-Type。
 *
 * 增删库时**只改这里**；`VENDOR_SCRIPT_ORDER` 与 `vendorCss()` 都从它派生，
 * 不会出现「发了字节但没引用」或「引用了但没发字节」。
 */
const VENDOR_FILES = {
  'htmx/htmx.min.js': JS,
  'tom-select/tom-select.complete.min.js': JS,
  'tom-select/tom-select.min.css': CSS,
  'flatpickr/flatpickr.min.js': JS,
  'flatpickr/flatpickr.min.css': CSS,
  'floating-ui/floating-ui.core.umd.min.js': JS,
  'floating-ui/floating-ui.dom.umd.min.js': JS,
} as const satisfies Readonly<Record<string, string>>

export type VendorFileName = keyof typeof VENDOR_FILES

/**
 * 页面里 `<script src>` 的**顺序**（不含 `/assets/app.js`，它由调用方接在最后）。
 *
 * 为什么是这个顺序：
 * - `htmx` 先加载，`app.js` 才能改它的 config；
 * - `floating-ui.core` 必须在 `floating-ui.dom` 之前——dom 的 UMD 读全局
 *   `FloatingUICore`（实测：顺序反了会 `Cannot read properties of undefined`）；
 * - `tom-select` / `flatpickr` 互不依赖，顺序只影响首屏初始化先后。
 */
export const VENDOR_SCRIPT_ORDER: readonly VendorFileName[] = [
  'htmx/htmx.min.js',
  'tom-select/tom-select.complete.min.js',
  'flatpickr/flatpickr.min.js',
  'floating-ui/floating-ui.core.umd.min.js',
  'floating-ui/floating-ui.dom.umd.min.js',
]

/** vendor 的 CSS 文件；`web` 把它们拼进 `/assets/app.css`。 */
export const VENDOR_CSS_ORDER: readonly VendorFileName[] = [
  'tom-select/tom-select.min.css',
  'flatpickr/flatpickr.min.css',
]

/** 白名单校验：不在表里的名字一律返回 `undefined`（调用方据此 404）。 */
export function vendorContentType(name: string): string | undefined {
  return (VENDOR_FILES as Readonly<Record<string, string>>)[name]
}

/**
 * 读一个 vendor 文件的字节。
 *
 * @param name 相对 `assets/vendor/` 的路径，**必须命中白名单**
 * @returns 命中返回文件；未命中返回 `undefined`（不抛错，调用方按 404 处理）
 */
export function readVendorFile(name: string): VendorFile | undefined {
  const contentType = vendorContentType(name)
  if (contentType === undefined) return undefined
  const body = readFileSync(new URL(`../assets/vendor/${name}`, import.meta.url))
  return { name, contentType, body }
}

/**
 * vendor 的全部 CSS 文本，按 `VENDOR_CSS_ORDER` 拼接。
 *
 * 与 `PAGE_CSS` / `COMPONENT_CSS` 一起由 `web` 拼进 `/assets/app.css`：
 * 单一 CSS 文件是这个站点的既定形态（CSP 只有 `'self'`，不引 CDN）。
 */
export function vendorCss(): string {
  const parts: string[] = []
  for (const name of VENDOR_CSS_ORDER) {
    const file = readVendorFile(name)
    if (file === undefined) throw new Error(`vendor CSS 缺失：${name}`)
    parts.push(`/* ── vendor: ${name} ── */\n${file.body.toString('utf8')}`)
  }
  return parts.join('\n')
}
