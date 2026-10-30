/**
 * 查询条件拼装（从 `service.ts` 拆出来）。
 *
 * 为什么单独一个文件：`service.ts` 已经 1432 行、超 400 软上限（AGENTS.md §5.6
 * 「已有超限文件只许缩短」）。这次要给它加 `exportCsv`，就把同一职责的
 * 「SQL 条件拼装 + 条数钳制」整块搬出来，净减行数。
 *
 * 都是纯函数：不碰数据库连接、不碰服务状态，只把 `UsageQuery` 翻成 SQL 片段。
 */
import type { SQLInputValue } from 'node:sqlite'
import type { UsageQuery } from './types.ts'

/**
 * `UsageQuery` → `WHERE` 子句 + 参数。
 *
 * **`userId` 不给就是全站口径**（管理面语义）：用户侧调用方必须自己传，
 * 权限判定在 HTTP 层（AGENTS.md §7「用量与价格」）。
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
