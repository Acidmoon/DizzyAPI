/**
 * 用量 CSV 的格式护栏：`packages/usage/src/csv.ts` 是**唯一实现**。
 *
 * 这份文件存在的理由：CSV 曾经有两份实现（`api` 一份、`web` 一份），两份转义规则
 * 迟早漂，而漂了不会报错——只会让某个单元格悄悄吃掉一个逗号，或者让用户下载到的
 * 文件在 Excel 里执行公式。现在格式只在这里，所以护栏也只对着这里。
 *
 * 覆盖：BOM、CRLF、表头、列序、`= + - @` 前导 `'`（防公式注入）、RFC 4180 引号转义、
 * 空结果仍带表头、文件名（UTC，`/api/usage/export` 的历史契约）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  USAGE_CSV_HEADER,
  usageCsv,
  usageCsvExport,
  usageCsvFilename,
} from '../src/csv.ts'
import type { UsageQuery, UsageRow } from '../src/types.ts'

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    id: 1,
    reqId: 'req-1',
    userId: 1,
    apiKeyId: 'key-1',
    apiKeyName: '生产 key',
    profile: 'default',
    accountId: 'acc-1',
    model: 'deepseek-chat',
    upstreamModel: null,
    protocol: 'openai-chat',
    upstreamProtocol: null,
    stream: true,
    status: 200,
    errorCode: null,
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    totalTokens: 21,
    usagePresent: true,
    usageComplete: true,
    durationMs: 2500,
    ttftMs: 321,
    clientIp: '127.0.0.1',
    attempts: 1,
    startedAt: '2026-10-30T01:02:03.000Z',
    costMicros: '1234567',
    ...overrides,
  }
}

/** 去掉 BOM 并切行。 */
function linesOf(csv: string): string[] {
  return csv.replace(/^\uFEFF/, '').split('\r\n')
}

const QUERY: UsageQuery = {
  fromMs: Date.parse('2026-10-13T00:00:00.000Z'),
  toMs: Date.parse('2026-10-20T00:00:00.000Z'),
}

test('CSV：BOM + CRLF + 表头列序', () => {
  const csv = usageCsv([row()])
  // BOM 必须看字节：字符串比较会被 JSON/TextDecoder 吃掉，等于没断言。
  assert.deepEqual([...Buffer.from(csv, 'utf8').subarray(0, 3)], [0xef, 0xbb, 0xbf])
  const lines = linesOf(csv)
  assert.equal(lines[0], USAGE_CSV_HEADER.join(','))
  assert.equal(lines.length, 2)
  // 行分隔符必须是 CRLF（不是裸 \n）：Excel / Windows 工具按 RFC 4180 认这个。
  assert.ok(!csv.replace(/^\uFEFF/, '').replaceAll('\r\n', '').includes('\n'))
})

test('CSV：列与表头一一对应（12 列，不含 ttft_ms）', () => {
  // 12 列是 `/api/usage/export` 的历史契约（api 用例逐字钉着表头），
  // 单一实现必须原样沿用，否则「现有用例原样绿」这条就不成立。
  assert.equal(USAGE_CSV_HEADER.length, 12)
  assert.ok(!USAGE_CSV_HEADER.includes('ttft_ms' as never))
  const cells = linesOf(usageCsv([row()]))[1]!.split(',')
  assert.equal(cells.length, 12)
  assert.equal(cells[0], '2026-10-30T01:02:03.000Z')
  assert.equal(cells[1], '生产 key')
  assert.equal(cells[2], 'deepseek-chat')
  assert.equal(cells.at(-1), '127.0.0.1')
})

test('CSV：`= + - @` 开头加前导 `\'`，防公式注入', () => {
  const csv = usageCsv([
    row({ model: '=HYPERLINK("http://evil","x")' }),
    row({ id: 2, model: '+1+1' }),
    row({ id: 3, model: '-2.5' }),
    row({ id: 4, model: '@SUM(A1)' }),
    row({ id: 5, model: '\tTAB' }),
  ])
  const lines = linesOf(csv).slice(1)
  assert.ok(lines[0]!.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), lines[0])
  assert.ok(lines[1]!.includes("'+1+1"), lines[1])
  assert.ok(lines[2]!.includes("'-2.5"), lines[2])
  assert.ok(lines[3]!.includes("'@SUM(A1)"), lines[3])
  assert.ok(lines[4]!.includes("'\tTAB"), lines[4])
})

test('CSV：逗号 / 引号 / 换行按 RFC 4180 转义', () => {
  const csv = usageCsv([
    row({ apiKeyName: 'a,b' }),
    row({ id: 2, apiKeyName: 'a"b' }),
    row({ id: 3, apiKeyName: 'line\nbreak' }),
  ])
  const body = csv.replace(/^\uFEFF/, '')
  assert.ok(body.includes('"a,b"'), '逗号要包引号')
  assert.ok(body.includes('"a""b"'), '引号要双写并以引号包裹')
  assert.ok(body.includes('"line\nbreak"'), '换行要包引号')
})

test('CSV：API key 名为空回落 key id；空结果仍带表头', () => {
  const csv = usageCsv([row({ apiKeyName: '', apiKeyId: 'key-raw' })])
  assert.ok(linesOf(csv)[1]!.includes('key-raw'))

  const empty = usageCsv([])
  assert.deepEqual(linesOf(empty), [USAGE_CSV_HEADER.join(',')], '零行也要有表头，不能是空文件')
})

test('文件名：UTC 日期、始终两段（`/api/usage/export` 的历史契约）', () => {
  assert.equal(usageCsvFilename(QUERY), 'usage-20261013-20261019.csv')
  // 窗口是 [from, to)，所以最后一天由 `toMs - 1` 决定。
  const single: UsageQuery = {
    fromMs: Date.parse('2026-10-19T00:00:00.000Z'),
    toMs: Date.parse('2026-10-20T00:00:00.000Z'),
  }
  assert.equal(usageCsvFilename(single), 'usage-20261019-20261019.csv')
})

test('导出：`{ filename, content }` 就是 api 的 JSON 契约字段', () => {
  const exported = usageCsvExport([row()], QUERY)
  assert.equal(exported.filename, 'usage-20261013-20261019.csv')
  assert.equal(exported.content, usageCsv([row()]))
})
