/**
 * 「用量信息」页插件的测试。
 *
 * 覆盖三件事：
 * 1. 配置校验（非法值必须被拒）。
 * 2. 聚合口径（按天 / 模型 / 调用类型 / API Key 分组，金额用整数微元累加）。
 * 3. 渲染结构（关键文案、图表元素、筛选链接存在）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isIssueList } from '@dizzyapi/plugin-kit'
import { validateDeepseekUsageConfig, DEEPSEEK_USAGE_DEFAULTS } from '../src/config.ts'
import { collectBoard, toChartData, type UsageRow } from '../src/collect.ts'
import { renderPage, renderStackedBarChart } from '../src/render.ts'
import { addMicros, microsToCents } from '../src/board.ts'
import { formatAxisDate, formatCompact, formatThousands } from '../src/tokens.ts'

const NOW = new Date('2026-10-22T08:00:00.000Z')

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    startedAt: '2026-10-20T01:00:00.000Z',
    model: 'deepseek-chat',
    protocol: 'openai-chat',
    apiKeyId: 'key-1',
    apiKeyName: '默认密钥',
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    totalTokens: 125,
    costMicros: '1000000',
    ...over,
  }
}

function readerOf(rows: readonly UsageRow[]) {
  return {
    exportRows: () => rows,
    summary: () => ({
      totals: {
        costMicros: rows.reduce((total, row) => addMicros(total, row.costMicros), '0'),
      },
    }),
  }
}

// ───────────────────────────── 配置 ─────────────────────────────

test('配置：空对象走默认值', () => {
  const resolved = validateDeepseekUsageConfig({})
  assert.ok(!isIssueList(resolved))
  assert.equal(resolved.port, DEEPSEEK_USAGE_DEFAULTS.port)
  assert.equal(resolved.basePath, DEEPSEEK_USAGE_DEFAULTS.basePath)
  assert.equal(resolved.enabled, true)
})

test('配置：显式值被保留', () => {
  const resolved = validateDeepseekUsageConfig({ port: 0, basePath: '/x', enabled: false })
  assert.ok(!isIssueList(resolved))
  assert.equal(resolved.port, 0)
  assert.equal(resolved.basePath, '/x')
  assert.equal(resolved.enabled, false)
})

test('配置：非法端口被拒', () => {
  const resolved = validateDeepseekUsageConfig({ port: 70000 })
  assert.ok(isIssueList(resolved))
})

test('配置：basePath 必须以 / 开头', () => {
  const resolved = validateDeepseekUsageConfig({ basePath: 'usage' })
  assert.ok(isIssueList(resolved))
})

test('配置：consoleBaseUrl 必须是绝对地址', () => {
  const resolved = validateDeepseekUsageConfig({ consoleBaseUrl: '/console' })
  assert.ok(isIssueList(resolved))
})

test('配置：未知字段被拒', () => {
  const resolved = validateDeepseekUsageConfig({ nope: 1 })
  assert.ok(isIssueList(resolved))
})

// ───────────────────────────── 聚合 ─────────────────────────────

test('聚合：按天分组并累加金额（整数微元）', () => {
  const board = collectBoard({
    usage: readerOf([
      row({ costMicros: '1000000' }),
      row({ costMicros: '2500000', startedAt: '2026-10-20T05:00:00.000Z' }),
      row({ costMicros: '500000', startedAt: '2026-10-21T05:00:00.000Z' }),
    ]),
    range: '30d',
    apiKeyId: null,
    groupBy: 'callKind',
    userId: null,
    balanceMicros: '0',
    userName: null,
    now: NOW,
  })

  assert.equal(board.daily.length, 2)
  assert.equal(board.daily[0].date, '2026-10-20')
  assert.equal(board.daily[0].costMicros, '3500000')
  assert.equal(board.daily[0].requests, 2)
  assert.equal(board.daily[1].costMicros, '500000')
  assert.equal(board.totals.costMicros, '4000000')
  assert.equal(board.totals.requests, 3)
  // 「累计消费金额」是全时段口径，与筛选范围一致（这里所有行都在范围内）。
  assert.equal(board.spentMicros, '4000000')
})

test('聚合：tokens 是四个桶之和', () => {
  const board = collectBoard({
    usage: readerOf([row({ inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 })]),
    range: '7d',
    apiKeyId: null,
    groupBy: 'callKind',
    userId: null,
    balanceMicros: '0',
    userName: null,
    now: NOW,
  })
  assert.equal(board.totals.tokens, 100)
  assert.equal(board.daily[0].cachedTokens, 70)
})

test('聚合：按调用类型与 API Key 分组', () => {
  const board = collectBoard({
    usage: readerOf([
      row({ protocol: 'openai-chat', costMicros: '1000000' }),
      row({ protocol: 'anthropic', costMicros: '3000000' }),
      row({
        protocol: 'openai-responses',
        apiKeyId: 'key-2',
        apiKeyName: '第二个',
        costMicros: '2000000',
      }),
    ]),
    range: '30d',
    apiKeyId: null,
    groupBy: 'callKind',
    userId: null,
    balanceMicros: '0',
    userName: null,
    now: NOW,
  })

  const point = board.daily[0]
  assert.equal(point.byCallKind['openai-chat'], '1000000')
  assert.equal(point.byCallKind['anthropic'], '3000000')
  assert.equal(point.byCallKind['openai-responses'], '2000000')
  // 前两行同名 key 合并成一组；第三行是另一个 key。
  assert.equal(point.byApiKey['默认密钥'], '4000000')
  assert.equal(point.byApiKey['第二个'], '2000000')
  assert.equal(board.apiKeys.length, 2)
})

test('聚合：模型按请求次数降序', () => {
  const board = collectBoard({
    usage: readerOf([
      row({ model: 'a' }),
      row({ model: 'b' }),
      row({ model: 'b' }),
    ]),
    range: '30d',
    apiKeyId: null,
    groupBy: 'callKind',
    userId: null,
    balanceMicros: '0',
    userName: null,
    now: NOW,
  })
  assert.equal(board.models[0].model, 'b')
  assert.equal(board.models[0].requests, 2)
  assert.equal(board.models[1].model, 'a')
})

test('聚合：图表数据按分组维度摊平', () => {
  const board = collectBoard({
    usage: readerOf([row({ protocol: 'openai-chat', costMicros: '2000000' })]),
    range: '30d',
    apiKeyId: null,
    groupBy: 'callKind',
    userId: null,
    balanceMicros: '0',
    userName: null,
    now: NOW,
  })
  const { data, groups } = toChartData(board.daily, 'callKind')
  assert.deepEqual(groups, ['openai-chat'])
  assert.equal(data[0].series['openai-chat'], 2)
})

// ───────────────────────────── 数值格式 ─────────────────────────────

test('格式：微元加法与分换算', () => {
  assert.equal(addMicros('99999999999999999999', '1'), '100000000000000000000')
  assert.equal(microsToCents('1137940000'), 113794)
  assert.equal(microsToCents('-1500000'), -150)
})

test('格式：千分位与紧凑写法', () => {
  assert.equal(formatThousands(18407), '18,407')
  assert.equal(formatThousands(4514980635), '4,514,980,635')
  assert.equal(formatCompact(800_000_000), '800M')
  assert.equal(formatCompact(1_600_000_000), '1.6B')
  assert.equal(formatCompact(2500), '2,500')
  assert.equal(formatAxisDate('2026-09-23'), '9/23')
})

// ───────────────────────────── 渲染 ─────────────────────────────

const SAMPLE_BOARD = collectBoard({
  usage: readerOf([
    row({ costMicros: '198730000', model: 'deepseek-flash' }),
    row({ costMicros: '4944000', model: 'deepseek-v4-pro', protocol: 'anthropic' }),
  ]),
  range: '30d',
  apiKeyId: null,
  groupBy: 'callKind',
  userId: 7,
  balanceMicros: '6440000',
  userName: 'Acidmoon',
  now: NOW,
})

const RENDER = {
  basePath: '/console/usage',
  consoleBaseUrl: 'http://127.0.0.1:7791',
} as const

test('渲染：关键文案与结构存在', () => {
  const html = renderPage({
    board: SAMPLE_BOARD,
    ...RENDER,
    userName: 'Acidmoon',
    avatarUrl: null,
  })

  assert.match(html, /<h1 class="page-title"[^>]*>用量信息<\/h1>/)
  assert.match(html, /所有日期均按 GMT\+8 时间显示/)
  assert.match(html, /累计消费金额/)
  assert.match(html, /API 请求次数/)
  assert.match(html, /Tokens/)
  assert.match(html, /消费金额（CNY）/)
  assert.match(html, /调用类型/)
  assert.match(html, /deepseek-flash/)
  assert.match(html, /deepseek-v4-pro/)
  assert.match(html, /近 30 天/)
  assert.match(html, /Acidmoon/)
})

test('渲染：金额与余额按分显示', () => {
  const html = renderPage({
    board: SAMPLE_BOARD,
    ...RENDER,
    userName: null,
    avatarUrl: null,
  })
  // 余额 6.44 元；累计消费 198.73 + 4.944 = 203.67 元。
  assert.match(html, /¥6\.44/)
  assert.match(html, /¥203\.67/)
})

test('渲染：侧栏链接指向控制台地址', () => {
  const html = renderPage({
    board: SAMPLE_BOARD,
    ...RENDER,
    userName: null,
    avatarUrl: null,
  })
  assert.match(html, /href="http:\/\/127\.0\.0\.1:7791\/console\/api_keys"/)
  assert.match(html, /href="\/console\/usage"/)
})

test('渲染：筛选与导出链接带查询参数', () => {
  const html = renderPage({
    board: SAMPLE_BOARD,
    ...RENDER,
    userName: null,
    avatarUrl: null,
  })
  assert.match(html, /href="\/console\/usage\?range=7d/)
  assert.match(html, /href="\/console\/usage\/api\/usage\/export\?range=30d/)
})

test('渲染：图表输出网格线、坐标轴文字与柱子', () => {
  const svg = renderStackedBarChart(
    [{ date: '2026-10-20', series: { a: 10 } }, { date: '2026-10-21', series: { a: 20 } }],
    ['a'],
    undefined,
    'count',
  )
  assert.match(svg, /class="grid-line"/)
  assert.match(svg, /class="axis-text"/)
  assert.match(svg, /class="bar"/)
  assert.match(svg, /10\/20/)
  // 原站的堆叠柱是「整根柱一条 path + 硬停渐变」，不是每段一根柱子。
  assert.match(svg, /<linearGradient[^>]*><stop offset="0%" stop-color="#FD8D3C"><\/stop>/)
  assert.match(svg, /class="bar"[^>]*fill="url\(#dg-chart-0\)"/)
  // 原站几何：画布 896×272，绘图区从 x=40 开始，网格线半像素偏移。
  assert.match(svg, /viewBox="0 0 896 272"/)
  assert.match(svg, /x1="40"/)
  assert.match(svg, /y1="248\.5"/)
})

test('渲染：堆叠柱按分组分段，每段在渐变里各停一次', () => {
  const svg = renderStackedBarChart(
    [{ date: '2026-10-20', series: { a: 10, b: 30 } }],
    ['a', 'b'],
    undefined,
    'count',
  )
  // 两段 → 4 个 stop：段界处 offset 相同（硬边）。
  const stops = [...svg.matchAll(/<stop offset="([\d.]+)%" stop-color="(#[0-9A-F]{6})">/g)]
  assert.equal(stops.length, 4)
  assert.equal(stops[1][1], stops[2][1], '段界处两个 stop 的 offset 必须相同')
  assert.notEqual(stops[0][2], stops[3][2], '两段的颜色必须不同')
})

test('渲染：没有数据时给出空态而不是崩', () => {
  const empty = collectBoard({
    usage: readerOf([]),
    range: '7d',
    apiKeyId: null,
    groupBy: 'callKind',
    userId: null,
    balanceMicros: '0',
    userName: null,
    now: NOW,
  })
  const html = renderPage({ board: empty, ...RENDER, userName: null, avatarUrl: null })
  assert.match(html, /当前范围内没有用量记录/)
})
