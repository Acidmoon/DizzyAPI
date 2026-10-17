import { createHash } from 'node:crypto'

/**
 * 覆盖的指纹。
 *
 * 存在的理由：调用方读到一份设置、想好怎么改、再写回来，中间可能已经有人改过了。
 * 带上读到的 revision，写的时候对不上就报 SETTINGS_CONFLICT，而不是把别人的改动
 * 悄悄盖掉。指纹由内容算出，不额外存状态——同一份配置永远得到同一个值。
 */
export function revisionOf(config: unknown): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 16)
}

/** 键排序后的 JSON：同样的内容必然得到同样的字符串（对象键序不影响结果）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}
