/**
 * 站点字体服务（cordis 服务名 `fontSmiley`）。
 *
 * 与 `web` 的接线：web 在 `/assets/app.css` 末尾追加 `css()`，
 * 并用 `file()` 的字节回应 `/assets/fonts/dizzy-sans.woff2`。
 */
import { createHash } from 'node:crypto'
import { Service, type Context } from 'cordis'
import {
  FONT_CONTENT_TYPE,
  FONT_FAMILY,
  FONT_FILE_NAME,
  readFontFile,
  renderFontCss,
  validateFontSmileyConfig,
  type FontScope,
  type FontSmileyConfig,
  type ResolvedFontSmileyConfig,
} from './config.ts'

export interface FontFile {
  readonly name: string
  readonly contentType: string
  readonly body: Buffer
}

export class FontSmileyService extends Service {
  static inject: readonly string[] = []
  static catalog = { capabilities: ['font'], events: [], bridge: [] } as const

  private readonly config: ResolvedFontSmileyConfig
  /** ersion() 的缓存：字体文件在进程生命周期内不变。 */
  private cachedVersion: string | undefined

  constructor(ctx: Context, config: FontSmileyConfig = {}) {
    super(ctx, 'fontSmiley')
    const resolved = validateFontSmileyConfig(config)
    if (Array.isArray(resolved)) throw new Error(`font-smiley 配置非法：${resolved.join('；')}`)
    this.config = resolved as ResolvedFontSmileyConfig
  }

  get family(): string {
    return FONT_FAMILY
  }

  get scope(): FontScope {
    return this.config.scope
  }

  /** 字体字节的内容短哈希（拼进 `?v=` 版本串，见 `css()`）。进程内算一次。 */
  version(): string {
    if (this.cachedVersion === undefined) {
      this.cachedVersion = createHash('sha256').update(readFontFile()).digest('hex').slice(0, 8)
    }
    return this.cachedVersion
  }

  /** `@font-face` + 作用范围覆盖；禁用时返回空串。 */
  css(): string {
    return this.config.enabled ? renderFontCss(this.config.scope, this.version()) : ''
  }

  /** 字体文件；`name` 已经写成固定文件名，不接受外部路径。 */
  file(): FontFile {
    return { name: FONT_FILE_NAME, contentType: FONT_CONTENT_TYPE, body: readFontFile() }
  }
}
