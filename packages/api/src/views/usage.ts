/**
 * views/usage.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { costCentsOf } from '../views/common.ts'
import { join } from 'node:path'
import type { UsageDailyPointLike, UsageModelBreakdownLike, UsageRejectedRowLike, UsageRowLike, UsageTotalsLike, UsageUserBreakdownLike } from '../types.ts'


/**
 * 服务口径 → 页面口径。
 *
 * `tokens` 是四个桶之和（input / output / cacheRead / cacheWrite）；`costCents`
 * 是给图表的粗口径，`costMicros` 才是精确值。
 */
export function usageTotalsOf(totals: UsageTotalsLike): {
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costCents: number
  costMicros: string
} {
  return {
    requests: totals.requests,
    tokens:
      totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costCents: costCentsOf(totals.costMicros),
    costMicros: totals.costMicros,
  }
}


export function usageDailyOf(point: UsageDailyPointLike) {
  return { date: point.date, ...usageTotalsOf(point) }
}


export function usageModelOf(item: UsageModelBreakdownLike) {
  return { model: item.model, ...usageTotalsOf(item) }
}


export function usageUserOf(item: UsageUserBreakdownLike, name: string | null) {
  return { userId: item.userId, name, ...usageTotalsOf(item) }
}


/** 隔离区一行：原始载荷 + 原因 + 失败次数 + 状态（稳定英文字符串）。 */
export function rejectedRowOf(row: UsageRejectedRowLike) {
  return {
    reqId: row.reqId,
    epoch: row.epoch,
    seq: row.seq,
    payload: row.payload,
    error: row.error,
    failures: row.failures,
    status: row.status,
    firstFailedAt: row.firstFailedAt,
    updatedAt: row.updatedAt,
  }
}


/** 管理员明细行：用户侧字段 + userName / accountId / attempts。 */
export function adminUsageRowOf(row: UsageRowLike, userName: string | null) {
  return {
    id: row.id,
    reqId: row.reqId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName,
    model: row.model,
    upstreamModel: row.upstreamModel ?? null,
    protocol: row.protocol,
    upstreamProtocol: row.upstreamProtocol ?? null,
    stream: row.stream,
    status: row.status,
    errorCode: row.errorCode ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    clientIp: row.clientIp ?? null,
    startedAt: row.startedAt,
    costMicros: row.costMicros,
    userName,
    accountId: row.accountId,
    attempts: row.attempts,
  }
}


/** 用户页永远拿不到账号 / profile / attempts 等管理面字段。 */
export function usageRowOf(row: UsageRowLike): {
  id: number
  reqId: string
  userId: number
  apiKeyId: string
  apiKeyName: string
  model: string
  upstreamModel: string | null
  protocol: string
  upstreamProtocol: string | null
  stream: boolean
  status: number
  errorCode: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  durationMs: number
  clientIp: string | null
  startedAt: string
  costMicros: string
} {
  return {
    id: row.id,
    reqId: row.reqId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName,
    model: row.model,
    upstreamModel: row.upstreamModel,
    protocol: row.protocol,
    upstreamProtocol: row.upstreamProtocol,
    stream: row.stream,
    status: row.status,
    errorCode: row.errorCode,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    totalTokens: row.totalTokens,
    durationMs: row.durationMs,
    clientIp: row.clientIp,
    startedAt: row.startedAt,
    costMicros: row.costMicros,
  }
}


/**
 * 单条详情：**比列表多** `reasoningTokens` / `usagePresent` / `usageComplete` / `ttftMs`
 * 与费用（列表里本来就有费用）。仍然不给管理面字段（profile / accountId / attempts）：
 * 用户面拿不到上游账号拓扑，管理员要看这些走 `/api/admin/usage`。
 */
export function usageDetailOf(row: UsageRowLike): {
  id: number
  reqId: string
  userId: number
  apiKeyId: string
  apiKeyName: string
  model: string
  upstreamModel: string | null
  protocol: string
  upstreamProtocol: string | null
  stream: boolean
  status: number
  errorCode: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  usagePresent: boolean
  usageComplete: boolean
  durationMs: number
  ttftMs: number | null
  clientIp: string | null
  startedAt: string
  costMicros: string
} {
  return {
    id: row.id,
    reqId: row.reqId,
    userId: row.userId,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyName,
    model: row.model,
    upstreamModel: row.upstreamModel,
    protocol: row.protocol,
    upstreamProtocol: row.upstreamProtocol,
    stream: row.stream,
    status: row.status,
    errorCode: row.errorCode,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    usagePresent: row.usagePresent,
    usageComplete: row.usageComplete,
    durationMs: row.durationMs,
    ttftMs: row.ttftMs,
    clientIp: row.clientIp,
    startedAt: row.startedAt,
    costMicros: row.costMicros,
  }
}


type AdminUsageCsvRow = UsageRowLike & { readonly userName: string | null }


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


/**
 * 管理员 CSV：列与用户侧一致，另加 `user` / `account`。
 * 带 UTF-8 BOM（Excel 直接识别中文），单元格按 CSV 规则转义并防公式注入。
 */
export function adminUsageCsv(rows: readonly AdminUsageCsvRow[]): string {
  const header =
    'time,user,api_key,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,status,duration_ms,client_ip,account'
  const lines = rows.map((row) =>
    [
      row.startedAt,
      row.userName ?? '',
      row.apiKeyName,
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
      row.accountId,
    ]
      .map(csvField)
      .join(','),
  )
  return `﻿${header}\n${lines.length === 0 ? '' : `${lines.join('\n')}\n`}`
}


/** 用户侧 CSV：BOM + 表头 + 行；单元格按 CSV 规则转义并防公式注入。 */
export function usageCsv(rows: readonly UsageRowLike[]): string {
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
        row.clientIp ?? '',
      ]
        .map(csvField)
        .join(','),
    )
  }
  return `﻿${lines.join('\r\n')}`
}


/** CSV 单元格：`= + - @` 开头加前导 `'` 防公式注入，再按 RFC 4180 转义。 */
export function csvField(value: unknown): string {
  let text = value === undefined || value === null ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`
  return text
}
