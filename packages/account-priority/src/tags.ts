/**
 * 标签 → Go tags 的映射约定（**只在这一处实现**）。
 *
 * 为什么需要映射：identity 里的标签是 `string[]`，而 Go 的 `Filter.Tags` 是
 * `map<string, string>` 且匹配语义是**精确相等**（`candidate.Tags[key] != value`，
 * 见 `modules/accountpriority/scoring.go`）。两边形状不同，约定必须固定在一个地方，
 * 将来要改只改这里。
 *
 * 约定：
 * - 含第一个 `:` 的 label → `{ key: value }`，`key` 是冒号前的部分、`value` 是冒号后的全部
 *   （值里可以再出现 `:`）。`key` 为空（例如 `:value`）时该 label 被丢弃——Go 侧空键没有意义。
 * - 不含 `:` 的 label → `{ <label>: '' }`，即「只有标签名、没有值」：
 *   `tier:pro` 在 Go 侧是 `{ tier: 'pro' }`，`beta` 在 Go 侧是 `{ beta: '' }`。
 *   这样 `Filter.Tags = { beta: '' }` 就能精确匹配「带 beta 标签」的账号；
 *   如果把纯标签都折成同一个键，多个纯标签就分不开了。
 * - 同一个 key 出现多次时**先出现的胜出**，后面的被忽略（顺序由 identity 的标签数组保证）。
 * - 空串 / 纯空白 label 被丢弃；键值都 trim。
 */

/** 把 identity 的 `labels` 数组转成 Go 快照里的 `tags` 映射。 */
export function labelsToTags(labels: readonly string[] | null | undefined): Record<string, string> {
  const tags: Record<string, string> = {}
  if (labels === null || labels === undefined) return tags
  for (const raw of labels) {
    if (typeof raw !== 'string') continue
    const label = raw.trim()
    if (label === '') continue
    const separator = label.indexOf(':')
    const key = (separator === -1 ? label : label.slice(0, separator)).trim()
    if (key === '') continue
    if (Object.prototype.hasOwnProperty.call(tags, key)) continue
    tags[key] = separator === -1 ? '' : label.slice(separator + 1).trim()
  }
  return tags
}
