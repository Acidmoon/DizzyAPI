/**
 * 站点字体（@dizzyapi/plugin-font-smiley）。
 *
 * 自托管 Smiley Sans（得意黑）v2.0.1，SIL OFL-1.1；
 * 字体文件与 LICENSE 都在 `assets/`，随包分发。
 */
import { FontSmileyService } from './service.ts'

declare module 'cordis' {
  interface Context {
    fontSmiley: FontSmileyService
  }
}

export { FontSmileyService }
export default FontSmileyService

export {
  FONT_CONTENT_TYPE,
  FONT_FAMILY,
  FONT_FILE_NAME,
  FONT_SMILEY_DEFAULTS,
  FONT_URL,
  readFontFile,
  renderFontCss,
  validateFontSmileyConfig,
  type FontScope,
  type FontSmileyConfig,
  type ResolvedFontSmileyConfig,
} from './config.ts'

export type { FontFile } from './service.ts'
