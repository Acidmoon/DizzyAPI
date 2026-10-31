/**
 * 查询条件拼装（从 `service.ts` 拆出来）。
 *
 * 为什么单独一个文件：`service.ts` 已经 1414 行、远超 500 行上限（AGENTS.md §5.6
 * 「已有超限文件只许缩短，不许加长」）。这次给它加「按 API key / 按用户」两个聚合维度，
 * 就把同一职责的「SQL 条件拼装 + 条数钳制」整块搬出来，让 `service.ts` 净减。
 *
 * 都是纯函数：不碰数据库连接、不碰服务状态，只把 `UsageQuery` 翻成 SQL 片段。
 */
import type { SQLInputValue } from 'node:sqlite'
import type { UsageQuery } from './types.ts'

/**
 * 探测流量的 key 名前缀（`model-probe` 插件建的 key 一律以此开头，见 `性能` 线的约定）。
 *
 * **排除必须在 SQL 里做**：只在页面上藏掉，列表与 CSV 导出还是脏的。
 */
export const PROBE_KEY_PREFIX = '__probe__'

/**
 * `UsageQuery` → `WHERE` 子句 + 参数。
 *
 * **`userId` 不给就是全站口径**（管理面语义）：用户侧调用方必须自己传，
 * 权限判定在 HTTP 层（AGENTS.md §7「用量与价格」）。
 *
 * **默认排除探测流量**（`api_key_name` 以 `__probe__` 开头）：那是 `model-probe` 主动
 * 探测产生的请求，不是用户消费，不能算进任何统计。要包含它就显式传 `includeProbe: true`。
 */
export function queryWhere(
  query: UsageQuery,
  withCursor: boolean,
): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = ['started_at_ms >= ?', 'started_at_ms < ?']
  const params: SQLInputValue[] = [query.fromMs, query.toMs]
  if (query.userId !== undefined) {
    clauses.push('user_id = ?')
    params.push(query.userId)
  }
  if (query.apiKeyId !== undefined) {
    clauses.push('api_key_id = ?')
    params.push(query.apiKeyId)
  }
  if (query.model !== undefined) {
    clauses.push('model = ?')
    params.push(query.model)
  }
  if (query.status !== undefined) {
    clauses.push('status = ?')
    params.push(query.status)
  }
  if (query.includeProbe !== true) {
    // 不能用 `LIKE '__probe__%'`：`_` 在 LIKE 里是单字符通配符，会误伤。
    clauses.push('substr(api_key_name, 1, ?) <> ?')
    params.push(PROBE_KEY_PREFIX.length, PROBE_KEY_PREFIX)
  }
  if (withCursor && query.cursor !== undefined) {
    clauses.push('id < ?')
    params.push(query.cursor)
  }
  return { sql: clauses.join(' AND '), params }
}

/** 条数钳制：非有限值回落默认，最小 1、最大 `max`（非法输入不抛错，页面永远能渲染）。 */
export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}
