/**
 * 用量夹具（含隔离区行的可变版本与四桶汇总）。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  AccountPriorityPort,
  UsagePort,
  UsageQueryLike,
  UsageRejectedPageLike,
  UsageRejectedQueryLike,
  UsageRejectedRowLike,
  UsageReplayResultLike,
  UsageRowLike,
  UsageStatsLike,
  UsageStatusLike,
  UsageSummaryLike,
} from '../../src/types.ts'
import { csvField } from '@dizzyapi/plugin-kit'
import { DomainError } from './support.ts'

type MutableRejected = { -readonly [Key in keyof UsageRejectedRowLike]: UsageRejectedRowLike[Key] }
export class FakeAccountPriority implements AccountPriorityPort {
  status() {
    return {
      state: 'ready',
      bridgeConnected: true,
      transport: 'tcp' as const,
      address: '127.0.0.1:59321',
      revision: 'rev-1',
      accounts: 2,
    }
  }
}

/** 假用量服务：默认空表；测试可以 `usage.rows.push(...)` 后验证查询口径。 */
export class FakeUsage implements UsagePort {
  rows: UsageRowLike[] = []
  rejected: MutableRejected[] = []
  readonly rejectedActions: { method: 'ignore' | 'replay'; reqId: string }[] = []

  list(query: UsageQueryLike) {
    const filtered = this.filter(query)
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
    const page = filtered.filter((row) => query.cursor === undefined || row.id < query.cursor).slice(0, limit)
    return {
      items: page,
      nextCursor: page.length === limit && page.length > 0 ? page[page.length - 1]!.id : null,
    }
  }

  get(reqId: string): UsageRowLike | null {
    return this.rows.find((row) => row.reqId === reqId) ?? null
  }

  summary(query: UsageQueryLike): UsageSummaryLike {
    return { totals: totalsOf(this.filter(query)), daily: [], models: [] }
  }

  stats(): UsageStatsLike {
    return {
      today: totalsOf(this.rows),
      total: totalsOf(this.rows),
      series: [],
      models: [],
      topUsers: [],
    }
  }

  exportRows(query: UsageQueryLike, limit = 1000): readonly UsageRowLike[] {
    return this.filter(query).slice(0, limit)
  }

  /**
   * 假 `exportCsv`：与真实实现（`packages/usage/src/csv.ts`）同格式。
   *
   * 夹具里必然有一份「照着真实实现写」的构造——这是桩的本质。真正的格式护栏在
   * `packages/usage/test/csv.test.ts`（对着唯一实现断言）；这里的用例验的是
   *「`/api/usage/export` 的 JSON 信封与筛选口径」，格式只是顺带盯一眼没漂。
   */
  exportCsv(query: UsageQueryLike, limit = 1000): { filename: string; content: string } {
    const rows = this.exportRows(query, limit)
    const header = 'time,api_key,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost_micros,status,duration_ms,client_ip'
    const lines = rows.map((row) =>
      [
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
        .map(csvField)
        .join(','),
    )
    const from = new Date(query.fromMs).toISOString().slice(0, 10).replaceAll('-', '')
    const to = new Date(query.toMs - 1).toISOString().slice(0, 10).replaceAll('-', '')
    return {
      filename: `usage-${from}-${to}.csv`,
      content: `﻿${[header, ...lines].join('\r\n')}`,
    }
  }

  status(): UsageStatusLike {
    return { records: this.rows.length, epoch: 'test-epoch', lastSeq: this.rows.length, polling: false, pricingAvailable: true }
  }

  listRejected(query: UsageRejectedQueryLike = {}): UsageRejectedPageLike {
    const filtered = this.rejected
      .filter((row) => query.status === undefined || row.status === query.status)
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.reqId.localeCompare(b.reqId))
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      pending: this.rejected.filter((row) => row.status === 'pending').length,
    }
  }

  ignoreRejected(reqId: string): void {
    this.rejectedActions.push({ method: 'ignore', reqId })
    const row = this.rejected.find((item) => item.reqId === reqId)
    if (row === undefined) throw new DomainError('USAGE_REJECTED_NOT_FOUND', `没有这条隔离记录：${reqId}`)
    if (row.status === 'ignored') return
    if (row.status !== 'pending') {
      throw new DomainError('USAGE_REJECTED_STATE', `隔离记录已是 ${row.status}，不能再忽略`)
    }
    row.status = 'ignored'
  }

  async replayRejected(reqId: string): Promise<UsageReplayResultLike> {
    this.rejectedActions.push({ method: 'replay', reqId })
    const row = this.rejected.find((item) => item.reqId === reqId)
    if (row === undefined) throw new DomainError('USAGE_REJECTED_NOT_FOUND', `没有这条隔离记录：${reqId}`)
    if (row.status === 'ignored') {
      throw new DomainError('USAGE_REJECTED_STATE', '已忽略的隔离记录不再重放')
    }
    if (row.status === 'replayed') return { status: 'replayed', inserted: false }
    row.status = 'replayed'
    return { status: 'replayed', inserted: true }
  }

  private filter(query: UsageQueryLike): UsageRowLike[] {
    return this.rows
      .filter((row) => query.userId === undefined || row.userId === query.userId)
      .filter((row) => query.apiKeyId === undefined || row.apiKeyId === query.apiKeyId)
      .filter((row) => query.model === undefined || row.model === query.model)
      .filter((row) => query.status === undefined || row.status === query.status)
      .sort((a, b) => b.id - a.id)
  }
}

function totalsOf(rows: readonly UsageRowLike[]) {
  let requests = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  let costMicros = 0n
  for (const row of rows) {
    requests += 1
    inputTokens += row.inputTokens
    outputTokens += row.outputTokens
    cacheReadTokens += row.cacheReadTokens
    cacheWriteTokens += row.cacheWriteTokens
    reasoningTokens += row.reasoningTokens
    totalTokens += row.totalTokens
    costMicros += BigInt(row.costMicros)
  }
  return {
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    costMicros: costMicros.toString(),
  }
}
