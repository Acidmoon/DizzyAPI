/**
 * 看板数据采集：从 `usage` 服务读明细，按天 / 模型 / 调用类型 / API Key 聚合。
 *
 * **不直接读库**：用量明细的唯一写者是 `usage` 插件，这里只经由它的服务接口读
 * （AGENTS.md D8）。费用是它按 `pricing` 现价算好的「应扣金额」，我们不再折算。
 *
 * 聚合口径：
 * - 天：`startedAt` 的 UTC 日期（与用量服务的 `day` 字段一致）。
 * - 调用类型：请求协议（openai-chat / openai-responses / anthropic …），
 *   对应原站图表里「调用类型」那根分段控件。
 * - API Key：`apiKeyName`（没有名字时退回 id）。
 */
import type { ApiKeyOption, Board, DayPoint, GroupBy, ModelBoard, RangeKey } from './board.ts'
import { addMicros, microsToYuan, RANGE_DAYS, sumMicros } from './board.ts'

/** 用量明细行（本插件只看这些字段）。 */
export interface UsageRow {
  readonly startedAt: string
  readonly model: string
  readonly protocol: string
  readonly apiKeyId: string
  readonly apiKeyName: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly totalTokens: number
  readonly costMicros: string
}

/** 用量服务里我们用到的读接口。 */
export interface UsageReader {
  exportRows(query: {
    readonly fromMs: number
    readonly toMs: number
    readonly userId?: number
    readonly apiKeyId?: string
    readonly model?: string
  }, limit?: number): readonly UsageRow[]
  /**
   * 任意时间窗的汇总。原站的「累计消费金额」是**全时段**口径，不随筛选变化，
   * 所以这里用 `fromMs=0` 的窗口取一次。
   */
  summary(query: {
    readonly fromMs: number
    readonly toMs: number
    readonly userId?: number
    readonly apiKeyId?: string
  }): { readonly totals: { readonly costMicros: string } }
}

/** 采集看板所需的全部输入。 */
export interface CollectInput {
  readonly usage: UsageReader
  readonly range: RangeKey
  readonly apiKeyId: string | null
  readonly groupBy: GroupBy
  /** 当前用户；null = 全站（管理员视角）。 */
  readonly userId: number | null
  /** 用户余额，微元。 */
  readonly balanceMicros: string
  readonly userName: string | null
  readonly now: Date
}

const DAY_MS = 86_400_000

/** 导出上限：与用量服务 `MAX_EXPORT_LIMIT` 一致。 */
const MAX_ROWS = 20_000

/**
 * 采集并聚合成看板。
 *
 * 时间窗口按 UTC 天对齐：`[今天 00:00 - (N-1) 天, 今天 00:00 + 1 天)`。
 */
export function collectBoard(input: CollectInput): Board {
  const days = RANGE_DAYS[input.range]
  const todayStart = Date.UTC(
    input.now.getUTCFullYear(),
    input.now.getUTCMonth(),
    input.now.getUTCDate(),
  )
  const fromMs = todayStart - (days - 1) * DAY_MS
  const toMs = todayStart + DAY_MS

  const query = {
    fromMs,
    toMs,
    ...(input.userId === null ? {} : { userId: input.userId }),
    ...(input.apiKeyId === null ? {} : { apiKeyId: input.apiKeyId }),
  }
  const rows = input.usage.exportRows(query, MAX_ROWS)

  const byDate = new Map<string, MutableDay>()
  const byModel = new Map<string, MutableModel>()
  const apiKeys = new Map<string, ApiKeyOption>()

  for (const row of rows) {
    const date = row.startedAt.slice(0, 10)
    const tokens = row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
    const cached = row.cacheReadTokens + row.cacheWriteTokens
    const keyName = row.apiKeyName === '' ? row.apiKeyId : row.apiKeyName
    const callKind = row.protocol === '' ? 'unknown' : row.protocol

    const day = ensureDay(byDate, date)
    day.requests += 1
    day.tokens += tokens
    day.cachedTokens += cached
    day.costMicros = addMicros(day.costMicros, row.costMicros)
    day.byCallKind[callKind] = addMicros(day.byCallKind[callKind] ?? '0', row.costMicros)
    day.byApiKey[keyName] = addMicros(day.byApiKey[keyName] ?? '0', row.costMicros)

    const model = ensureModel(byModel, row.model)
    model.requests += 1
    model.tokens += tokens
    model.costMicros = addMicros(model.costMicros, row.costMicros)
    const modelDay = ensureDay(model.daily, date)
    modelDay.requests += 1
    modelDay.tokens += tokens
    modelDay.cachedTokens += cached
    modelDay.costMicros = addMicros(modelDay.costMicros, row.costMicros)

    apiKeys.set(row.apiKeyId, { id: row.apiKeyId, name: keyName })
  }

  const daily = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, day]) => freezeDay(date, day))
  const models = [...byModel.entries()]
    .sort(([aName, a], [bName, b]) => b.requests - a.requests || aName.localeCompare(bName))
    .map(([model, value]) => freezeModel(model, value))

  const totals = {
    costMicros: sumMicros(daily.map((point) => point.costMicros)),
    requests: daily.reduce((sum, point) => sum + point.requests, 0),
    tokens: daily.reduce((sum, point) => sum + point.tokens, 0),
  }

  // 「累计消费金额」是**全时段**口径：原站的这两张卡不随时间筛选变化。
  const lifetime = input.usage.summary({
    fromMs: 0,
    toMs: Number.MAX_SAFE_INTEGER,
    ...(input.userId === null ? {} : { userId: input.userId }),
    ...(input.apiKeyId === null ? {} : { apiKeyId: input.apiKeyId }),
  })

  return {
    balanceMicros: input.balanceMicros,
    spentMicros: lifetime.totals.costMicros,
    totals,
    daily,
    models,
    apiKeys: [...apiKeys.values()].sort((a, b) => a.name.localeCompare(b.name)),
    range: input.range,
    apiKeyId: input.apiKeyId,
    groupBy: input.groupBy,
    generatedAt: input.now.toISOString(),
    userId: input.userId,
    userName: input.userName,
    userBalanceMicros: input.balanceMicros,
  }
}

interface MutableDay {
  requests: number
  tokens: number
  cachedTokens: number
  costMicros: string
  byCallKind: Record<string, string>
  byApiKey: Record<string, string>
}

interface MutableModel {
  requests: number
  tokens: number
  costMicros: string
  daily: Map<string, MutableDay>
}

function ensureDay(container: Map<string, MutableDay>, date: string): MutableDay {
  const existing = container.get(date)
  if (existing !== undefined) return existing
  const created: MutableDay = {
    requests: 0,
    tokens: 0,
    cachedTokens: 0,
    costMicros: '0',
    byCallKind: {},
    byApiKey: {},
  }
  container.set(date, created)
  return created
}

function ensureModel(container: Map<string, MutableModel>, model: string): MutableModel {
  const existing = container.get(model)
  if (existing !== undefined) return existing
  const created: MutableModel = { requests: 0, tokens: 0, costMicros: '0', daily: new Map() }
  container.set(model, created)
  return created
}

function freezeDay(date: string, day: MutableDay): DayPoint {
  return {
    date,
    costMicros: day.costMicros,
    requests: day.requests,
    tokens: day.tokens,
    cachedTokens: day.cachedTokens,
    byCallKind: { ...day.byCallKind },
    byApiKey: { ...day.byApiKey },
  }
}

function freezeModel(model: string, value: MutableModel): ModelBoard {
  return {
    model,
    requests: value.requests,
    tokens: value.tokens,
    costMicros: value.costMicros,
    daily: [...value.daily.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => freezeDay(date, day)),
  }
}

/** 图表用的「每组一根柱」数据：按天 × 分组拆出消费金额（元，float 只用于画图）。 */
export interface ChartDatum {
  readonly date: string
  /** 分组名 → 消费金额（元）。 */
  readonly series: Readonly<Record<string, number>>
}

/** 把逐日数据摊平成图表数据。 */
export function toChartData(
  daily: readonly DayPoint[],
  groupBy: GroupBy,
): { readonly data: readonly ChartDatum[]; readonly groups: readonly string[] } {
  const groups = new Set<string>()
  const data = daily.map((point) => {
    const source = groupBy === 'callKind' ? point.byCallKind : point.byApiKey
    const series: Record<string, number> = {}
    for (const [name, micros] of Object.entries(source)) {
      series[name] = microsToYuan(micros)
      groups.add(name)
    }
    return { date: point.date, series }
  })
  return { data, groups: [...groups].sort((a, b) => a.localeCompare(b)) }
}
