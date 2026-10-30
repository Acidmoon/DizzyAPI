/**
 * 用户界面偏好 → CSS。**字号档位与字距的样式语义只在这里**。
 *
 * 数据层（`user` 插件）只记「用户选了哪一档」的 token 名（`fontScale: 1.25`、
 * `letterSpacing: 'wide'`），em 值属于样式，放这里；这样调设计 token 不用迁数据。
 *
 * 输出是一张**很小的覆盖表**，由 `web` 按当前登录用户生成、发到
 * `/assets/theme.css`：
 * - 它必须**排在 `app.css` 之后**（`--fs-*` 的 `calc(... * var(--font-scale))`
 *   在 `:root` 上定义，同优先级下后者胜）；
 * - 它**按用户不同**，所以缓存语义是 `private, no-store`，但地址照样带内容哈希
 *   （与 `app.css` / `vendor` 同一套规则：没有版本串的 `immutable` 是不成立的）。
 */

/** 字号档位（与 `user` 插件的 `FONT_SCALES` 一一对应）。 */
export type ThemeFontScale = 0.875 | 1 | 1.25 | 1.5

/** 字距档位（与 `user` 插件的 `LETTER_SPACINGS` 一一对应）。 */
export type ThemeLetterSpacing = 'tight' | 'normal' | 'wide'

export interface ThemePreferences {
  readonly fontScale: number
  readonly letterSpacing: string
}

/**
 * 字距档位 → em 值。
 *
 * `normal` 与 `PAGE_CSS` 里 `--ls-normal` 的默认值一致（0.01em），所以「标准」
 * 这一档生成出来的 CSS 与不加载主题时**完全等价**——用户点「恢复默认」不会
 * 看到字距跳一下。
 */
export const LETTER_SPACING_EM: Readonly<Record<ThemeLetterSpacing, string>> = {
  tight: '0em',
  normal: '0.01em',
  wide: '0.025em',
}

/** 站点默认（= 不覆盖）。`web` 在用户没设过偏好时用它。 */
export const DEFAULT_THEME_PREFERENCES: ThemePreferences = { fontScale: 1, letterSpacing: 'normal' }

/** 允许的字号档位（渲染前会再核一遍，见 `renderThemeCss`）。 */
export const FONT_SCALE_VALUES = [0.875, 1, 1.25, 1.5] as const satisfies readonly ThemeFontScale[]

/**
 * 渲染 `/assets/theme.css` 的正文。
 *
 * 只覆盖两个变量：
 * - `--font-scale`：`--fs-<role>` 全都是 `calc(<n>px * var(--font-scale))`，改它一个
 *   就等于九档字号一起缩放（行高写的是无单位倍数，会自动跟随）；
 * - `--ls-normal`：全站字距；品牌字用的 `--ls-tight` 刻意不覆盖（收紧是设计意图）。
 */
export function renderThemeCss(preferences: ThemePreferences): string {
  // 值来自库里的 JSON，虽然 `user` 插件已经校验过，这里**再挡一层**：
  // 这些数字会直接拼进 CSS，未校验的字符串就是样式注入面。
  const fontScale = (FONT_SCALE_VALUES as readonly number[]).includes(preferences.fontScale)
    ? preferences.fontScale
    : 1
  const spacing = LETTER_SPACING_EM[preferences.letterSpacing as ThemeLetterSpacing] ?? LETTER_SPACING_EM.normal
  return `/* 用户界面偏好（按用户生成，private / no-store） */
:root {
  --font-scale: ${fontScale};
  --ls-normal: ${spacing};
}
`
}

/** `/assets/theme.css` 的路径部分（版本串由 `web` 拼，见 `asset-version.ts`）。 */
export const THEME_CSS_PATH = '/assets/theme.css'
