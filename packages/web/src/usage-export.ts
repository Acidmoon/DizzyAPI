/**
 * 用量 CSV 导出：`web` 侧的服务端 `text/csv` 路由（`/console/usage/export.csv`）。
 *
 * 为什么由 `web` 发、而不是复用 `/api/usage/export`：
 * - 生产 nginx 只把 `/api/*` 反代 `api`（7791），其余全打 `web`（7792）；
 * - `/api/usage/export` 的契约是 JSON `{filename, content}`（**不动它**），
 *   浏览器要拿到文件还得自己拼 Blob，那需要客户端脚本。
 * 所以这里直接回 `text/csv` + `Content-Disposition`，**一次请求就下载**，没脚本也行。
 *
 * 两条硬口径：
 * - **必须按会话用户过滤**（`userId` 必传）：`usage.exportRows` 不给 userId 就是全站口径；
 * - **权限在路由层判**：`usage` 服务只照条件查，不认人。
 */
import type { PageTemplateService } from '@dizzyapi/plugin-page-template'
import type { SessionView } from './runtime.ts'
import type { UsageLike, UsageRow } from './usage-types.ts'
import type { UsageFilters } from './usage-view.ts'
import { hrefOf, parseFilters, queryOf } from './usage-view.ts'

/** 导出按钮指向的路径（普通链接，浏览器原生下载）。 */
export const USAGE_EXPORT_PATH = '/console/usage/export.csv'

/** 导出上限：与 `usage.exportRows` 默认值一致（5 000 条）。 */
const EXPORT_LIMIT = 5_000

/**
 * 导出链接：带着当前筛选条件。
 *
 * 为什么是**普通链接**而不是 `data-export` 钩子：那条钩子是给「接口返回 JSON、
 * 页面自己拼 Blob」用的；这里服务端直接回 `text/csv` + `Content-Disposition`，
 * 浏览器原生就能下载——**不需要任何脚本**，也就不用碰设计线的 `client-extras.ts`。
 */
export function exportHref(t: PageTemplateService, filters: UsageFilters): string {
  return t.escapeAttr(hrefOf(USAGE_EXPORT_PATH, filters, { cursor: undefined }))
}

/**
 * CSV 表头：与 `/api/usage/export` 的用户侧列对齐，另加 `ttft_ms`。
 *
 * 对齐是刻意的：两边字段名一致才便于「用同一份脚本对账」。`api` 那份**不动**
 * （它的契约是 JSON），这里多一列首字延迟——那是本次新采集的字段，用户面要能下载到。
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
  'ttft_ms',
  'client_ip',
] as const

/**
 * CSV 单元格：`= + - @` 开头加前导 `'` 防公式注入，再按 RFC 4180 转义。
 *
 * 与 `packages/api/src/views/usage.ts` 的 `csvField` 同一规则——两处各一份是刻意的：
 * `web` 不能 import `api` 的实现（插件之间不互相 import），所以由用例钉住两边一致
 * （`usage-export.test.ts` 逐条验公式注入与转义）。
 */
export function csvField(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`
  return text
}

/**
 * 用户侧用量 CSV：UTF-8 BOM + 表头 + 行（CRLF）。
 *
 * BOM 是给 Excel 认 UTF-8 的；`ttftMs` 为 null（没采集）时留**空单元格**，不写 0
 * ——「没测到」和「0 毫秒」是两件事，与页面显示「—」同口径。
 */
export function usageCsv(rows: readonly UsageRow[]): string {
  const lines = [USAGE_CSV_HEADER.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.startedAt,
        row.apiKeyName === '' ? row.apiKeyId : row.apiKeyName,
        row.model,
        String(row.inputTokens),
        String(row.outputTokens),
        String(row.cacheReadTokens),
        String(row.cacheWriteTokens),
        String(row.totalTokens),
        row.costMicros,
        String(row.status),
        String(row.durationMs),
        row.ttftMs === null ? '' : String(row.ttftMs),
        '',
      ]
        .map(csvField)
        .join(','),
    )
  }
  return `﻿${lines.join('\r\n')}`
}

/** 导出文件名：`usage-20261030.csv`（单日）/ `usage-20261001-20261030.csv`（跨天）。 */
export function exportFilename(filters: UsageFilters): string {
  // 窗口是 `[from, to)`，文件名用最后一毫秒落在的那天。
  const pad2 = (value: number): string => String(value).padStart(2, '0')
  const stamp = (date: Date): string =>
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
  const first = stamp(new Date(filters.range.from()))
  const last = stamp(new Date(filters.range.to() - 1))
  return first === last ? `usage-${first}.csv` : `usage-${first}-${last}.csv`
}

export interface HttpResource {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** `Content-Disposition`：ASCII 兜底 + `filename*` 保真，两者都给。 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * 组装导出响应。
 *
 * 路径判断在调用方（`service.ts` 先比 `path === USAGE_EXPORT_PATH` 再取会话）：
 * 这样普通页面请求不会多跑一次会话校验。
 */
export function usageExportResource(
  query: URLSearchParams,
  session: SessionView | null,
  usage: UsageLike | undefined,
): HttpResource {
  // 未登录与页面同口径：302 到登录页（不是 401——导出是给人点的链接）。
  if (session === null) {
    return { status: 302, headers: { Location: '/login?err=' + encodeURIComponent('请先登录') }, body: '' }
  }
  // 服务不在运行：给一句人话，别让浏览器存下一个空文件。纯文本 + 503，可重试。
  if (usage === undefined) {
    return { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '用量服务未运行，暂时无法导出' }
  }

  const filters = parseFilters(query)
  const rows = usage.exportRows(queryOf(filters, session.userId), EXPORT_LIMIT)
  return {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': contentDisposition(exportFilename(filters)),
      // 按用户生成 → 共享缓存不能复用（与 theme.css 同一条纪律）。
      'Cache-Control': 'private, no-store',
    },
    body: usageCsv(rows),
  }
}
