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
 *
 * **两条纪律**（都踩过）：
 *
 * - **只把本批真正用到的库放进 `VENDOR_SCRIPT_ORDER`。** 白名单里可以留着还没用的库
 *   （字节在、LICENSE 在、要用时一行就加回来），但**页面引用列表**必须等于「现在
 *   有代码在调」的集合：曾经把 htmx(52 KB) + floating-ui(22 KB) 挂在每一个页面上，
 *   而全站 `hx-*` 与 `FloatingUIDOM` 调用各 0 处——74 KB 死代码连登录页都在下载。
 * - **vendor 的 URL 带内容哈希，`immutable` 才成立。** `web` 用
 *   `public, max-age=31536000, immutable` 发这些字节，而路径是固定的；没有版本串的话，
 *   升级一个带安全修复的库之后，所有回访浏览器会一直用旧版直到手动清缓存。
 *   所以页面里的 `href` 一律用 `vendorHref()`（拼 `?v=<内容短哈希>`），
 *   不要直接拼 `VENDOR_ASSET_PREFIX + name`。
 */
import { createHash } from 'node:crypto'
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
 * **这张表 = 现在真的有代码在调的库**，不是「白名单里有的库」：
 * - `tom-select` / `flatpickr`：下拉与日期的渐进增强在用（`client-script.ts` 的
 *   `upgradeControls()`）；
 * - `htmx`：第 4 批（侧栏局部刷新）落地时加回来；
 * - `floating-ui`：tooltip 落地时加回来（`core` 必须在 `dom` 之前，dom 的 UMD 读全局
 *   `FloatingUICore`，顺序反了实测 `Cannot read properties of undefined`）。
 *
 * 别再往这里加「以后可能要用」的库——每多一个，所有页面（含登录页）都要下载它。
 */
export const VENDOR_SCRIPT_ORDER: readonly VendorFileName[] = [
  'tom-select/tom-select.complete.min.js',
  'flatpickr/flatpickr.min.js',
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

/** 内容短哈希的缓存：文件在一次进程生命周期内不会变，算一次就够。 */
const HASH_CACHE = new Map<string, string>()

/**
 * vendor 文件的内容短哈希（sha256 前 8 位十六进制）。
 *
 * @returns 命中白名单返回哈希；未命中返回 `undefined`（与 `readVendorFile` 同口径）
 */
export function vendorHash(name: string): string | undefined {
  const cached = HASH_CACHE.get(name)
  if (cached !== undefined) return cached
  const file = readVendorFile(name)
  if (file === undefined) return undefined
  const hash = createHash('sha256').update(file.body).digest('hex').slice(0, 8)
  HASH_CACHE.set(name, hash)
  return hash
}

/**
 * vendor 文件在页面里的 **URL（带内容哈希）**。
 *
 * 为什么必须带：`web` 用 `immutable` 发这些字节，路径又是固定的；不带版本串的话，
 * 升级库之后回访浏览器会一直用旧版（含安全修复也拿不到）。
 *
 * @throws 名字不在白名单里时抛错——调用方只会传 `VENDOR_SCRIPT_ORDER` / 白名单里的名字，
 *         走到这里说明代码写错了，宁可在渲染期炸掉也不要在页面上留一个 404 的 `<script>`。
 */
export function vendorHref(name: VendorFileName): string {
  const hash = vendorHash(name)
  if (hash === undefined) throw new Error(`vendor 名字不在白名单里：${name}`)
  return `${VENDOR_ASSET_PREFIX}${name}?v=${hash}`
}
