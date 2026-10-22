/**
 * 站点字体：自托管 Smiley Sans（得意黑），SIL OFL-1.1。
 *
 * 纯资源服务：不监听 HTTP、不写存储。`web` 在 `/assets/app.css` 里追加
 * `css()`，并从 `/assets/fonts/smiley-sans.woff2` 发 `file()` 的字节。
 *
 * 字体文件与 LICENSE 一起放在 `assets/`：OFL 要求随字体分发许可文本。
 */
import { readFileSync } from 'node:fs'

const FONT_FILE = new URL('../assets/smiley-sans.woff2', import.meta.url)

export const FONT_FAMILY = 'Smiley Sans'
export const FONT_FILE_NAME = 'smiley-sans.woff2'
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

/** `@font-face` + 作用范围覆盖。 */
export function renderFontCss(scope: FontScope): string {
  const stack = `'${FONT_FAMILY}', Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`
  const targets = scope === 'all'
    ? 'body'
    : 'h1, h2, .side-word, .side-badge, .page-title, .auth-title, .model-name, .section-title, .chart-title, .value-main'
  return `@font-face {
  font-family: '${FONT_FAMILY}';
  src: url('${FONT_URL}') format('woff2');
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
${targets} { font-family: ${stack}; }`
}

/** 字体字节；进程生命周期内只读一次。 */
let cached: Buffer | undefined

export function readFontFile(): Buffer {
  if (cached === undefined) cached = readFileSync(FONT_FILE)
  return cached
}
