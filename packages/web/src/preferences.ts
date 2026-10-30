/**
 * 当前会话用户的界面偏好（字号 / 字距 / 侧栏顺序）→ 渲染层要的两样东西。
 *
 * 为什么单独一个文件：`service.ts` 早过 400 行软上限（AGENTS.md §5.6「已有超限文件
 * 只许缩短」），而「读偏好 + 回落默认 + 生成主题表」是三件纯事，与 HTTP 编排无关。
 *
 * 两条纪律：
 * 1. **永不抛错**：字号 / 侧栏顺序坏了最坏是「不像他选的那样」，抛错会让页面打不开；
 * 2. **站默认值不生成主题表**：`app.css` 的默认就是标准字号 + 标准字距，
 *    引一张空表只是多一个请求。
 */
import { renderThemeCss } from '@dizzyapi/plugin-page-template'

/** 界面偏好（与 `user` 插件的 `UiPreferences` 同形；这里只描述 web 用到的字段）。 */
export interface UiPreferencesView {
  readonly fontScale: number
  readonly letterSpacing: string
  /** 侧栏顺序：路径数组，空 = 站默认顺序。未知路径由 `applyNavOrder` 丢弃。 */
  readonly navOrder: readonly string[]
}

/** 站默认偏好：与不设偏好完全等价。 */
export const DEFAULT_UI_PREFERENCES_VIEW: UiPreferencesView = {
  fontScale: 1,
  letterSpacing: 'normal',
  navOrder: [],
}

/** `user` 服务里这一件事的最小面（只依赖用到的那个方法，不啃整份接口）。 */
export interface PreferenceReader {
  getUiPreferences(id: number): Promise<UiPreferencesView>
}

/** 只取会话里的用户 id：`web` 的 `SessionView` 结构上满足它。 */
interface SessionLike {
  readonly session: { readonly user: { readonly id: number } }
}

/**
 * 读当前会话用户的偏好；任何一步拿不到就给站默认值。
 *
 * @param user `user` 服务（未装载时传 `undefined`，直接回落默认）
 * @param session 已校验的会话（未登录传 `null`）
 */
export async function readPreferences(
  user: PreferenceReader | undefined,
  session: SessionLike | null,
): Promise<UiPreferencesView> {
  const userId = session?.session.user.id
  if (userId === undefined || user === undefined) return DEFAULT_UI_PREFERENCES_VIEW
  try {
    return await user.getUiPreferences(userId)
  } catch {
    return DEFAULT_UI_PREFERENCES_VIEW
  }
}

/**
 * 偏好 → `/assets/theme.css` 的正文。
 *
 * 站默认值返回**空串**（页面就不引用主题表），与「加载一张不覆盖任何变量的表」
 * 完全等价，少一个请求。
 */
export function themeCssFrom(preferences: UiPreferencesView): string {
  if (preferences.fontScale === 1 && preferences.letterSpacing === 'normal') return ''
  return renderThemeCss(preferences)
}
