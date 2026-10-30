/**
 * 用量页（概览 `/console/usage` + 明细 `/console/usage/detail`）共用的视图层工具。
 *
 * 为什么不放进 `pages/`：那个目录是「一页一个文件」，这里没有路由，只有两页共用的
 * 时间档位、7 个固定时间点、堆叠维度、筛选表单与详情弹窗片段。放进去会让
 * 「一页一文件」的约定失真，也会被 `pages-guards` 当成页面扫描。
 *
 * 两条硬口径：
 * - **柱状图恒定 7 个时间点**（空桶补 0），不随数据多少变；
 * - **首字延迟（TTFT）为 null 一律显示「—」**，绝不显示 0 ms（0 与「没采集」是两件事）。
 */
import type { PageTemplateService } from '@dizzyapi/plugin-page-template'
import {
  COST_KEY_COLORS,
  COST_THEME,
  type ChartTheme,
  type SelectOption,
} from '@dizzyapi/plugin-page-template'
import { formatYuan, microsToYuan } from './forms.ts'
import type { UsageQuery, UsageRow } from './usage-types.ts'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** 柱状图恒定的时间点个数。 */
export const CHART_SLOTS = 7
/** 堆叠色板容量：`COST_KEY_COLORS` 6 色 → 最多 5 个分组 + 「其他」。 */
const MAX_GROUPS = 5
/** 图表与指标卡的取样上限：概览页不是全量明细，超出部分由明细页看。 */
export const CHART_SAMPLE_LIMIT = 5_000
/** 概览页「最近请求」条数（owner 要求：只留最近 10 条）。 */
export const RECENT_LIMIT = 10
/** 明细页每页条数。 */
export const DETAIL_PAGE_SIZE = 20

/** 本地时区当天 0 点；`offsetDays = 1` 是昨天 0 点。 */
export function startOfLocalDay(offsetDays = 0): number {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() - offsetDays)
  return date.getTime()
}

export type UsageRangeKey = 'today' | 'yesterday' | '7d' | '30d'

export interface UsageRange {
  readonly key: UsageRangeKey
  readonly label: string
  /** 汇总 / 列表 / 导出的查询窗口。 */
  from(): number
  to(): number
}

/** 时间维度档位：显式下拉的选项（原来的胶囊太隐蔽）。 */
export const USAGE_RANGES: readonly UsageRange[] = [
  { key: 'today', label: '今天', from: () => startOfLocalDay(0), to: () => Date.now() },
  { key: 'yesterday', label: '昨天', from: () => startOfLocalDay(1), to: () => startOfLocalDay(0) },
  { key: '7d', label: '近 7 天', from: () => startOfLocalDay(6), to: () => Date.now() },
  { key: '30d', label: '近 30 天', from: () => startOfLocalDay(29), to: () => Date.now() },
]

/** 图表堆叠维度：总量（单系列）/ 按模型 / 按 API key。 */
export type UsageDimension = 'total' | 'model' | 'key'

export const DIMENSIONS: readonly { readonly key: UsageDimension; readonly label: string }[] = [
  { key: 'total', label: '总量' },
  { key: 'model', label: '按模型' },
  { key: 'key', label: '按 API key' },
]

export interface UsageFilters {
  readonly range: UsageRange
  readonly dim: UsageDimension
  /** 空串 = 全部。 */
  readonly model: string
  /** 空串 = 全部。 */
  readonly apiKeyId: string
  /** keyset 分页游标（明细页用）；undefined = 第一页。 */
  readonly cursor: number | undefined
}

function rangeOf(key: string | null): UsageRange {
  return USAGE_RANGES.find((item) => item.key === key) ?? USAGE_RANGES[2]!
}

function dimensionOf(value: string | null): UsageDimension {
  return value === 'model' || value === 'key' ? value : 'total'
}

/** 从查询串解析筛选条件；任何非法值都回落到默认（不抛错，页面永远能渲染）。 */
export function parseFilters(query: URLSearchParams): UsageFilters {
  const cursorText = query.get('cursor') ?? ''
  const cursor = /^\d+$/.test(cursorText) && Number(cursorText) > 0 ? Number(cursorText) : undefined
  return {
    range: rangeOf(query.get('range')),
    dim: dimensionOf(query.get('dim')),
    model: (query.get('model') ?? '').trim(),
    apiKeyId: (query.get('apiKeyId') ?? '').trim(),
    cursor,
  }
}

/** 换成 `usage` 服务的查询参数（`model` / `apiKeyId` 只在非空时带）。 */
export function queryOf(filters: UsageFilters): UsageQuery & { cursor?: number } {
  const query: UsageQuery & { cursor?: number } = {
    fromMs: filters.range.from(),
    toMs: filters.range.to(),
    ...(filters.model === '' ? {} : { model: filters.model }),
    ...(filters.apiKeyId === '' ? {} : { apiKeyId: filters.apiKeyId }),
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
  }
  return query
}

/** 只要时间窗口的查询（给「选项列表」与「不受筛选影响的汇总」用）。 */
export function rangeOnlyQuery(filters: UsageFilters): UsageQuery {
  return { fromMs: filters.range.from(), toMs: filters.range.to() }
}

/** 把当前筛选拼成 URL（分页链接、详情链接都基于它）。 */
export function hrefOf(base: string, filters: UsageFilters, overrides: Record<string, string | number | undefined> = {}): string {
  const params = new URLSearchParams()
  params.set('range', filters.range.key)
  params.set('dim', filters.dim)
  if (filters.model !== '') params.set('model', filters.model)
  if (filters.apiKeyId !== '') params.set('apiKeyId', filters.apiKeyId)
  if (filters.cursor !== undefined) params.set('cursor', String(filters.cursor))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key)
    else params.set(key, String(value))
  }
  const text = params.toString()
  return text === '' ? base : `${base}?${text}`
}

export interface ChartSlot {
  readonly startMs: number
  readonly endMs: number
  readonly date: string
  readonly label: string
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地时区的 `YYYY-MM-DD`。 */
function localDate(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * 恒定 7 个时间点。
 *
 * - 单日（今天 / 昨天）：最近 7 个整点小时，标签 `HH:00`；
 * - 多日（近 7 天 / 近 30 天）：把窗口**按天边界**均分成 7 段，标签 `MM-DD`。
 *
 * 分段一律从窗口起点按等分算，所以**永远是 7 段**，与库里有多少天数据无关
 * （没数据的时间点由 `buildChart` 补 0）。
 */
export function chartSlots(range: UsageRange): ChartSlot[] {
  const singleDay = range.key === 'today' || range.key === 'yesterday'
  if (singleDay) {
    const endHour = Math.floor(range.to() / HOUR_MS) + 1
    return Array.from({ length: CHART_SLOTS }, (_, index) => {
      const hour = endHour - CHART_SLOTS + index
      const startMs = hour * HOUR_MS
      const date = new Date(startMs)
      return {
        startMs,
        endMs: startMs + HOUR_MS,
        date: localDate(startMs),
        label: `${pad2(date.getHours())}:00`,
      }
    })
  }
  const days = range.key === '30d' ? 30 : 7
  const firstDay = startOfLocalDay(days - 1)
  const lastDay = startOfLocalDay(0)
  return Array.from({ length: CHART_SLOTS }, (_, index) => {
    const fromDay = Math.floor((index * days) / CHART_SLOTS)
    const toDay = Math.floor(((index + 1) * days) / CHART_SLOTS)
    const startMs = new Date(firstDay).setDate(new Date(firstDay).getDate() + fromDay)
    const base = new Date(firstDay)
    base.setDate(base.getDate() + toDay)
    const endMs = Math.min(base.getTime(), lastDay + DAY_MS)
    return {
      startMs,
      endMs: Math.max(endMs, startMs + DAY_MS / CHART_SLOTS),
      date: localDate(startMs),
      label: localDate(startMs).slice(5),
    }
  })
}

export interface UsageChartView {
  readonly data: readonly { readonly date: string; readonly label: string; readonly series: Readonly<Record<string, number>> }[]
  readonly groups: readonly string[]
  readonly theme: ChartTheme
}

function groupNameOf(row: UsageRow, dim: UsageDimension): string {
  if (dim === 'model') return row.model === '' ? '（未知模型）' : row.model
  if (dim === 'key') return row.apiKeyName === '' ? '（未命名 key）' : row.apiKeyName
  return '消费金额'
}

/**
 * 把明细行摊进 7 个时间点，并按维度堆叠。
 *
 * 金额内部分用 BigInt 累加（整数微元），只在**出图那一刻**换算成元，
 * 不引入浮点累加误差（AGENTS.md §2.4：金额禁止浮点）。
 * 分组取金额最高的 5 个，其余合并成「其他」——色板只有 6 色。
 */
export function buildChart(rows: readonly UsageRow[], slots: readonly ChartSlot[], dim: UsageDimension): UsageChartView {
  const perSlot = slots.map(() => new Map<string, bigint>())
  const totals = new Map<string, bigint>()
  for (const row of rows) {
    const at = Date.parse(row.startedAt)
    if (Number.isNaN(at)) continue
    const index = slots.findIndex((slot) => at >= slot.startMs && at < slot.endMs)
    if (index < 0) continue
    const group = groupNameOf(row, dim)
    const micros = BigInt(row.costMicros === '' ? '0' : row.costMicros)
    const bucket = perSlot[index]!
    bucket.set(group, (bucket.get(group) ?? 0n) + micros)
    totals.set(group, (totals.get(group) ?? 0n) + micros)
  }

  const ranked = [...totals.entries()].sort((a, b) => (b[1] === a[1] ? a[0].localeCompare(b[0]) : b[1] > a[1] ? 1 : -1))
  const groups: string[] =
    dim === 'total'
      ? ['消费金额']
      : [...ranked.slice(0, MAX_GROUPS).map(([group]) => group), ...(ranked.length > MAX_GROUPS ? ['其他'] : [])]

  const data = slots.map((slot, index) => {
    const bucket = perSlot[index]!
    const series: Record<string, number> = {}
    for (const group of groups) series[group] = 0
    if (dim === 'total') {
      let sum = 0n
      for (const value of bucket.values()) sum += value
      series['消费金额'] = microsToYuan(sum.toString())
    } else {
      for (const [group, value] of bucket) {
        const target = groups.includes(group) ? group : '其他'
        series[target] = (series[target] ?? 0) + microsToYuan(value.toString())
      }
    }
    return { date: slot.date, label: slot.label, series }
  })

  const theme: ChartTheme = dim === 'total' ? COST_THEME : { ...COST_THEME, colors: COST_KEY_COLORS }
  return { data, groups, theme }
}

/** 平均首字延迟（只统计采集到的行）；没有样本返回 null。 */
export function averageTtft(rows: readonly UsageRow[]): number | null {
  let sum = 0
  let count = 0
  for (const row of rows) {
    if (row.ttftMs === null) continue
    sum += row.ttftMs
    count += 1
  }
  return count === 0 ? null : Math.round(sum / count)
}

/** 毫秒 → 人话；null = 没采集到，显示「—」（不是 0 ms）。 */
export function formatMs(value: number | null): string {
  if (value === null) return '—'
  if (value < 1_000) return `${value} ms`
  return `${(value / 1_000).toFixed(1)} s`
}

export function formatClock(iso: string): string {
  return iso.slice(0, 16).replace('T', ' ')
}

/** 从行里收集「按 API key」下拉的选项（去重、按名称排序）。 */
export function keyOptions(rows: readonly UsageRow[], selected: string): SelectOption[] {
  const seen = new Map<string, string>()
  for (const row of rows) {
    if (row.apiKeyId === '') continue
    if (!seen.has(row.apiKeyId)) seen.set(row.apiKeyId, row.apiKeyName === '' ? row.apiKeyId : row.apiKeyName)
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([value, label]) => ({ value, label, selected: value === selected }))
}

function selectedOption(selected: string, options: readonly SelectOption[]): SelectOption[] {
  return options.map((option) => ({ ...option, selected: option.value === selected }))
}

/**
 * 筛选表单：4 个下拉（时间维度 / 查看维度 / 模型 / API key）+ 应用。
 *
 * 用 `form--inline`（控件横向并排、窄了自动换行），提交是普通 GET，
 * 不依赖脚本；下拉本身是 `renderSelect`（输出的仍是原生 `<select>`，
 * 只是挂了 `data-tom-select` 让客户端升级浮层，JS 没跑也能用）。
 */
export function filtersForm(
  t: PageTemplateService,
  action: string,
  filters: UsageFilters,
  models: readonly string[],
  keys: readonly SelectOption[],
): string {
  const rangeOptions = selectedOption(
    filters.range.key,
    USAGE_RANGES.map((item) => ({ value: item.key, label: item.label })),
  )
  const modelOptions = selectedOption(
    filters.model,
    models.filter((model) => model !== '').map((model) => ({ value: model, label: model })),
  )
  return `<form class="form form--inline form--flush" method="get" action="${t.escapeAttr(action)}">
<input type="hidden" name="dim" value="${t.escapeAttr(filters.dim)}">
<div class="field"><label for="f-range">时间维度</label>${t.renderSelect({
    name: 'range',
    id: 'f-range',
    options: rangeOptions,
    allowEmpty: false,
    ariaLabel: '时间维度',
  })}</div>
<div class="field"><label for="f-model">模型</label>${t.renderSelect({
    name: 'model',
    id: 'f-model',
    placeholder: '全部模型',
    options: modelOptions,
    ariaLabel: '模型',
  })}</div>
<div class="field"><label for="f-key">API key</label>${t.renderSelect({
    name: 'apiKeyId',
    id: 'f-key',
    placeholder: '全部 API key',
    options: selectedOption(filters.apiKeyId, keys),
    ariaLabel: 'API key',
  })}</div>
<button class="btn" type="submit">应用</button>
</form>`
}

/** 「详情」按钮：JS 在的时候开弹窗；没有 JS 时退化成整页链接（明细页渲染该条详情）。 */
export function detailTrigger(t: PageTemplateService, row: UsageRow, dialogId: string, fallbackHref: string): string {
  return `<a class="btn small" href="${t.escapeAttr(fallbackHref)}"${t.dialogOpenAttr(dialogId)}>详情</a>`
}

/** 详情弹窗的正文：模型 / 耗时 / 首字延迟 / 四桶 / 金额（金额注明读取时算价）。 */
export function detailBody(t: PageTemplateService, row: UsageRow): string {
  const status = row.status === 200 ? '200' : `${row.status}`
  const rows: readonly (readonly string[])[] = [
    ['模型', `<span class="mono">${t.escapeText(row.model)}</span>`],
    ['请求 ID', `<span class="mono">${t.escapeText(row.reqId)}</span>`],
    ['API key', t.escapeText(row.apiKeyName === '' ? '—' : row.apiKeyName)],
    ['开始时间', t.escapeText(formatClock(row.startedAt))],
    ['状态', row.status === 200 ? status : t.renderBadge(status, 'err')],
    ['总耗时', t.escapeText(formatMs(row.durationMs))],
    ['首字延迟（TTFT）', t.escapeText(formatMs(row.ttftMs))],
    ['输入 tokens', t.escapeText(t.formatThousands(row.inputTokens))],
    ['输出 tokens', t.escapeText(t.formatThousands(row.outputTokens))],
    ['缓存读 tokens', t.escapeText(t.formatThousands(row.cacheReadTokens))],
    ['缓存写 tokens', t.escapeText(t.formatThousands(row.cacheWriteTokens))],
    ['推理 tokens', t.escapeText(t.formatThousands(row.reasoningTokens))],
    ['合计 tokens', t.escapeText(t.formatThousands(row.totalTokens))],
    ['金额', `${t.escapeText(formatYuan(row.costMicros))} CNY`],
  ]
  const usageFlags = [
    row.usagePresent ? null : t.renderBadge('响应未带 usage', 'warn'),
    row.usageComplete ? null : t.renderBadge('流未读完（客户端可能提前断开）', 'warn'),
  ].filter((item) => item !== null)
  return [
    t.renderTable({ columns: [{ label: '字段' }, { label: '值', align: 'right' }], rows }),
    t.renderNotice({ kind: 'info', text: '金额在读取时按价格表计算（整数微元换算，不落库）；首字延迟只有流式请求才有值。' }),
    usageFlags.length === 0 ? '' : `<div class="actions">${usageFlags.join('')}</div>`,
  ].join('\n')
}

/** 一条记录的详情弹窗（服务端预渲染：没有客户端 fetch，也就不依赖任何脚本）。 */
export function detailModal(t: PageTemplateService, row: UsageRow): string {
  return t.renderModal({
    id: dialogIdOf(row),
    title: '请求详情',
    bodyHtml: detailBody(t, row),
    footerHtml: '<button class="btn" type="button" data-dialog-close>关闭</button>',
    size: 'wide',
  })
}

export function dialogIdOf(row: UsageRow): string {
  return `usage-detail-${row.id}`
}
