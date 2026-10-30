/**
 * 站点字体：得意黑（Smiley Sans）的**子集**，SIL OFL-1.1。
 *
 * 纯资源服务：不监听 HTTP、不写存储。`web` 在 `/assets/app.css` 里追加
 * `css()`，并从 `/assets/fonts/dizzy-sans.woff2` 发 `file()` 的字节。
 *
 * **发的是子集，不是上游全量文件**（`assets/dizzy-sans.woff2`，1.15 MB → 508 KB）：
 * 全量字体 9497 个字形、8335 个汉字，站点只用到其中一小撮。字体是首屏最大的单笔
 * 开销，`scope: all` 时**每个页面**都要下它。生成脚本见 `tools/build-subset.py`。
 *
 * **家族名是 `Dizzy Sans`，不是上游的 `Smiley Sans`**：OFL-1.1 条件 3 规定
 * Modified Version 不得使用保留字体名，上游声明的是 `<Smiley>` 与 `<得意黑>`
 * （见 `assets/LICENSE` 首行）。删字形就是 Modified Version，必须改名；
 * OFL-FAQ 3.1 写得很直白：「even if it is just a small change」。
 * 版权声明、设计者、许可说明与许可 URL 这些 name 记录**全部原样保留**（OFL 条件 2）。
 *
 * 字体文件与 LICENSE 一起放在 `assets/`：OFL 要求随字体分发许可文本。
 */
import { readFileSync } from 'node:fs'

const FONT_FILE = new URL('../assets/dizzy-sans.woff2', import.meta.url)

export const FONT_FAMILY = 'Dizzy Sans'
export const FONT_FILE_NAME = 'dizzy-sans.woff2'
export const FONT_CONTENT_TYPE = 'font/woff2'
export const FONT_URL = `/assets/fonts/${FONT_FILE_NAME}`

/** 字体作用范围：`headings` 只改标题与品牌；`all` 连正文一起换。 */
export type FontScope = 'headings' | 'all'

export interface FontSmileyConfig {
  readonly scope?: FontScope
  readonly enabled?: boolean
}

export interface ResolvedFontSmileyConfig {
  readonly scope: FontScope
  readonly enabled: boolean
}

export const FONT_SMILEY_DEFAULTS = {
  scope: 'headings',
  enabled: true,
} as const

export function validateFontSmileyConfig(value: unknown): ResolvedFontSmileyConfig | readonly string[] {
  if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    return ['配置必须是一个对象']
  }
  const raw = (value ?? {}) as Record<string, unknown>
  const allowed = new Set(['scope', 'enabled'])
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key))
  if (unknown.length > 0) return [`未知配置字段：${unknown.join(', ')}`]

  const scope = raw.scope === undefined ? FONT_SMILEY_DEFAULTS.scope : raw.scope
  if (scope !== 'headings' && scope !== 'all') return ['scope 只认 headings 或 all']
  const enabled = raw.enabled === undefined ? FONT_SMILEY_DEFAULTS.enabled : raw.enabled
  if (typeof enabled !== 'boolean') return ['enabled 必须是布尔值']
  return { scope, enabled }
}

/** `@font-face` + 作用范围覆盖。
 *
 * @param version 字体字节的内容短哈希，拼成 `?v=` 版本串。
 *   **必须带**：`web` 用 `immutable` 发字体（一年不可变），路径固定的话换字体版本
 *   （或只是重新导出同一个文件名）后，回访浏览器会一直用旧字体。
 */
export function renderFontCss(scope: FontScope, version: string): string {
  const original = 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif'
  const stack = `'${FONT_FAMILY}', ${original}`
  const targets = scope === 'all'
    ? 'body'
    : 'h1, h2, .side-word, .side-badge, .page-title, .auth-title, .section-title, .chart-title, .value-main'
  // 模型名保持原字体：全站换字体时单独把它覆盖回去（owner 2026-10-23 要求）。
  const keepModelName = scope === 'all' ? `\n.model-name { font-family: ${original}; }` : ''
  return `@font-face {
  font-family: '${FONT_FAMILY}';
  src: url('${FONT_URL}?v=${version}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
${targets} { font-family: ${stack}; }${keepModelName}`
}

/** 字体字节；进程生命周期内只读一次。 */
let cached: Buffer | undefined

export function readFontFile(): Buffer {
  if (cached === undefined) cached = readFileSync(FONT_FILE)
  return cached
}
