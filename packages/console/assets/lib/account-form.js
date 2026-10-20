/**
 * 账号表单里的「模型」字段解析（零依赖，可单测）。
 *
 * 表单用两种更友好的输入替代手写 JSON：
 * - `models`：逗号分隔的单行 input；
 * - `modelMap`：每行 `对外名=上游名` 的 textarea。
 *
 * 空输入一律解析成 `null`（「没声明」与「声明了个空的」在这里是同一件事），
 * 与服务端归一化后的语义一致（AGENTS.md §5.2）。
 */

/**
 * 逗号分隔的模型名 → `string[] | null`（trim、丢空串、去重、保序；空 → `null`）。
 * @param {string} text
 * @returns {string[] | null}
 */
export function parseModelsInput(text) {
  const seen = new Set()
  const result = []
  for (const part of String(text ?? '').split(',')) {
    const name = part.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result.length === 0 ? null : result
}

/**
 * 每行 `对外名=上游名` → `Record<string, string> | null`。
 * 空行、没有 `=` 的行、键或值为空的行都跳过；空 → `null`。
 * @param {string} text
 * @returns {Record<string, string> | null}
 */
export function parseModelMapInput(text) {
  /** @type {Record<string, string>} */
  const map = {}
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key === '' || value === '') continue
    map[key] = value
  }
  return Object.keys(map).length === 0 ? null : map
}

/**
 * `Record<string, string> | null` → 每行 `对外名=上游名`（用于编辑表单回填）。
 * @param {Record<string, string> | null | undefined} modelMap
 * @returns {string}
 */
export function formatModelMapInput(modelMap) {
  if (modelMap === null || modelMap === undefined) return ''
  return Object.entries(modelMap)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
}
