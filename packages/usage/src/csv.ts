/**
 * 用量 CSV 的**唯一实现**（`usage` 插件是「用量明细」的唯一写者，导出格式也归它）。
 *
 * 谁在用：
 * - `usage.exportCsv(query)` → 服务方法，`web` 的 `/console/usage/export.csv` 与
 *   `api` 的 `/api/usage/export` 都经它出字节，**两处不再各存一份格式**；
 * - `api` 的响应仍是 JSON `{ filename, content }`（契约不动）。
 *
 * 转义与 BOM 在 `@dizzyapi/plugin-kit` 的 `csv.ts`（那一份是 api / usage 共用的转义规则）。
 */
import { csvDocument } from '@dizzyapi/plugin-kit'
import type { UsageQuery, UsageRow } from './types.ts'

/**
 * 用户侧用量 CSV 的列。
 *
 * **12 列、不含 `ttft_ms`**：这是 `/api/usage/export` 的历史契约，`api` 的用例
 * 逐字钉着这一行表头。加列会改变导出内容（不是「JSON 信封不变」能覆盖的），
 * 所以由 `usage` 的唯一实现直接沿用这套列——单一实现的前提取就是
 * 「两边出的字节本来就应该一样」。
 */
export const USAGE_CSV_HEADER = [
  'time',
  'api_key',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'total_tokens',
  'cost_micros',
  'status',
  'duration_ms',
  'client_ip',
] as const

/** 一条记录 → 一行单元格（顺序必须与 `USAGE_CSV_HEADER` 对齐）。 */
function cellsOf(row: UsageRow): readonly unknown[] {
  return [
    row.startedAt,
    row.apiKeyName === '' ? row.apiKeyId : row.apiKeyName,
    row.model,
    row.inputTokens,
    row.outputTokens,
    row.cacheReadTokens,
    row.cacheWriteTokens,
    row.totalTokens,
    row.costMicros,
    row.status,
    row.durationMs,
    row.clientIp ?? '',
  ]
}

/** 用量 CSV 正文（BOM + 表头 + 行）。空结果也带表头。 */
export function usageCsv(rows: readonly UsageRow[]): string {
  return csvDocument(USAGE_CSV_HEADER, rows.map(cellsOf))
}

/** 导出的文件：`{ filename, content }`（api 的 JSON 契约就是这两个字段）。 */
export interface UsageCsvExport {
  readonly filename: string
  readonly content: string
}

/** 窗口起点 / 终点（含）→ `20261013` 这种紧凑日期串；**按 UTC**。 */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll('-', '')
}

/**
 * 文件名：`usage-20261013-20261019.csv`。
 *
 * **按 UTC 算，且始终两段**——这是 `/api/usage/export` 的历史契约
 * （现有用例钉着 `usage-20261013-20261019.csv`），逐字保持不变。
 * 页面上的「导出 CSV」另有本地时区的文件名（页面显示的是本地日期，
 * 用 UTC 日期当文件名会让 UTC+8 的用户觉得「导出的是昨天的」）。
 */
export function usageCsvFilename(query: UsageQuery): string {
  return `usage-${stampOf(query.fromMs)}-${stampOf(query.toMs - 1)}.csv`
}

/** 组装导出（`usage.exportCsv` 的实现本体，抽出来便于单测）。 */
export function usageCsvExport(rows: readonly UsageRow[], query: UsageQuery): UsageCsvExport {
  return { filename: usageCsvFilename(query), content: usageCsv(rows) }
}
