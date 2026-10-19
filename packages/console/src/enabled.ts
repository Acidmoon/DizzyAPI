/**
 * 从 cordis 的 entry 列表里取「当前启用集」。
 *
 * 身份同时收 entry id（`identity`）与包名（`@dizzyapi/plugin-identity`）：
 * app.yml 里的 id 是人起的稳定名字，包名是贡献者最自然的自我标识，
 * 清单过滤对两者都认。禁用项（`disabled: true`）不进入集合。
 */
export interface LoaderEntryLike {
  readonly options?: {
    readonly id?: unknown
    readonly name?: unknown
  }
  readonly disabled?: boolean
}

export function collectEnabledPlugins(entries: Iterable<LoaderEntryLike>): string[] {
  const enabled = new Set<string>()
  for (const entry of entries) {
    if (entry.disabled === true) continue
    const id = entry.options?.id
    const name = entry.options?.name
    if (typeof id === 'string' && id.trim() !== '') enabled.add(id.trim())
    if (typeof name === 'string' && name.trim() !== '') enabled.add(name.trim())
  }
  return [...enabled].sort()
}
