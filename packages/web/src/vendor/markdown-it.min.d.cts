/**
 * `markdown-it.min.cjs` 的手写类型声明。
 *
 * 为什么手写：markdown-it 14 的包里**不带类型**（`package.json` 没有 `types` 字段）。
 * 为什么是 `.d.cts` 且**必须与 `.cjs` 相邻同名**：仓库根 `package.json` 有 `"type": "module"`，
 * 所以 `.js` 一律按 ESM 解析；这个 UMD 单文件在 ESM 语境下 `require()` 会拿到空对象
 * （`module.exports` / `exports` 都不存在，UMD 落到 `globalThis` 分支）。
 * 改成 `.cjs` 扩展名 + 相邻 `.d.cts` 声明，运行时与 typecheck 同时成立。
 *
 * **不要**改成 `declare module '*.cjs'` 通配：那会把所有 `.cjs` 都当成 markdown-it。
 *
 * 只声明本项目用到的面（构造、render、`utils.escapeHtml`、`renderer.rules` 覆写），
 * 用不到的一律不声明——多声明就要跟着上游版本维护，得不偿失。
 */
interface Token {
  type: string
  tag: string
  content: string
  info: string
  children: Token[] | null
}

type Rule = (tokens: Token[], index: number, options: unknown, env: unknown, self: Renderer) => string

interface Renderer {
  rules: Record<string, Rule>
}

interface Utils {
  escapeHtml(value: string): string
}

declare class MarkdownIt {
  constructor(options?: {
    html?: boolean
    xhtmlOut?: boolean
    breaks?: boolean
    langPrefix?: string
    linkify?: boolean
    typographer?: boolean
    quotes?: string | string[]
    highlight?: (source: string, lang: string, attrs: string) => string
  })

  render(source: string, env?: unknown): string
  renderInline(source: string, env?: unknown): string
  parse(source: string, env?: unknown): Token[]
  use(plugin: unknown, ...params: unknown[]): this

  readonly utils: Utils
  readonly renderer: Renderer
}

export default MarkdownIt
