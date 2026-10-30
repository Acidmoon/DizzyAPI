/**
 * 侧栏顺序（`navOrder`）：**默认顺序 + 用户顺序 → 渲染顺序**。
 *
 * 为什么单独一个文件：这条规则要同时被「渲染侧栏」与「保存侧栏顺序」用，
 * 写在任一处都会变成两份实现；而它又是纯函数（不吃 IO），单独放最好测。
 *
 * 三条规则（owner 第 12 条 + 代码里的现状）：
 * 1. **只认默认表里有的路径**：用户在旧版本存过一个后来被删掉的页面，直接忽略；
 * 2. **默认表里缺的路径按默认顺序补到末尾**：以后新加一个侧栏项，老用户的
 *    偏好不能把它永久藏起来（这是「只存用户拖过的顺序」的必然结果）；
 * 3. **两个区域（用户站 / 管理台）各排各的**：同一个人的两份侧栏顺序互不干扰，
 *    所以存的是路径数组（路径天然按区域不重叠），渲染时只取自己那一段。
 */

/** 一个可排序的导航项（只要能给路径就行，渲染层再补 label / icon）。 */
interface NavLike {
  readonly path: string
}

/**
 * 把用户存的顺序套到默认表上。
 *
 * @param defaults 站默认顺序（唯一真相，新页面加进这里就自动出现在所有人的侧栏里）
 * @param stored 用户偏好里那条 `navOrder`（可能含未知 / 过期路径）
 */
export function applyNavOrder<T extends NavLike>(
  defaults: readonly T[],
  stored: readonly string[],
): T[] {
  const byPath = new Map(defaults.map((item) => [item.path, item]))
  const used = new Set<string>()
  const ordered: T[] = []
  for (const path of stored) {
    const item = byPath.get(path)
    // 未知路径（被删掉的页面）直接丢弃；重复路径只认第一次
    if (item === undefined || used.has(path)) continue
    used.add(path)
    ordered.push(item)
  }
  // 用户顺序里没提到的：按默认顺序补到末尾（新加的侧栏项不会被老偏好藏起来）
  for (const item of defaults) {
    if (used.has(item.path)) continue
    ordered.push(item)
  }
  return ordered
}

/**
 * 把一次拖动提交的路径序列**净化**成可入库的值。
 *
 * 与 `applyNavOrder` 的区别：这里是「存之前」的校验，所以要求更严——
 * 只接受默认表里有的路径、去重、最多 `defaults.length` 项。
 * 把 `applyNavOrder` 的结果反手写回来也是合法的（顺序一致）。
 *
 * @returns 净化后的路径数组；调用方原样交给 `user.setUiPreferences`
 */
export function normalizeNavOrder(
  defaults: readonly NavLike[],
  submitted: readonly string[],
): string[] {
  const known = new Set(defaults.map((item) => item.path))
  const out: string[] = []
  for (const path of submitted) {
    if (!known.has(path) || out.includes(path)) continue
    out.push(path)
  }
  return out
}

/** 逗号分隔的路径串 → 路径数组（空串 → 空数组）。 */
export function splitNavOrder(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined || raw === '') return []
  return raw.split(',').map((item) => item.trim()).filter((item) => item !== '')
}
