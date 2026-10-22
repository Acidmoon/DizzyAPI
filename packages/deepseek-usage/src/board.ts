/**
 * 用量看板的数据形状与口径。
 *
 * 页面结构对齐 DeepSeek 开放平台的「用量信息」页，**数值来自本项目的用量服务**：
 *
 * - 余额卡：用户余额（最小单位）+ 累计消费金额（按价格表在读取时算出的应扣金额）。
 * - 指标卡：消费金额 / API 请求次数 / Tokens。
 * - 主图：按天的消费金额柱状图，可按「调用类型」或「API Key」分组。
 * - 模型分块：每个模型一块，含「API 请求次数」与「Tokens」两张小图。
 *
 * 金额一律整数最小单位（AGENTS.md D10），展示时才换算成元。
 */

/** 金额最小单位：1 元 = 1_000_000 个微元（与 pricing 插件一致）。 */
export const MICROS_PER_YUAN = 1_000_000
/** 同上，BigInt 口径（做整数运算时用）。 */
const MICROS_PER_YUAN_BIG = 1_000_000n

/** 图表的分组维度。 */
export type GroupBy = 'callKind' | 'apiKey'

/** 时间维度。 */
export type RangeKey = '7d' | '30d' | '90d'

export const RANGE_DAYS: Readonly<Record<RangeKey, number>> = { '7d': 7, '30d': 30, '90d': 90 }

/** 一天的用量数据点。 */
export interface DayPoint {
  /** `YYYY-MM-DD`（UTC，与用量服务一致）。 */
  readonly date: string
  /** 消费金额，微元（十进制字符串，避免大整数进 number）。 */
  readonly costMicros: string
  /** 请求次数。 */
  readonly requests: number
  /** tokens 总量。 */
  readonly tokens: number
  /** 缓存命中的 token 总量。 */
  readonly cachedTokens: number
  /** 按调用类型（协议）分组的消费金额，微元。 */
  readonly byCallKind: Readonly<Record<string, string>>
  /** 按 API Key 分组的消费金额，微元。 */
  readonly byApiKey: Readonly<Record<string, string>>
}

/** 一个 API key 的展示信息。 */
export interface ApiKeyOption {
  readonly id: string
  readonly name: string
}

/** 单个模型的汇总与逐日序列。 */
export interface ModelBoard {
  readonly model: string
  readonly requests: number
  readonly tokens: number
  /** 消费金额，微元。 */
  readonly costMicros: string
  readonly daily: readonly DayPoint[]
}

/** 整块看板。 */
export interface Board {
  /** 用户余额，微元。 */
  readonly balanceMicros: string
  /** 所选时间范围内的累计消费金额，微元。 */
  readonly spentMicros: string
  /** 所选范围内的合计。 */
  readonly totals: {
    readonly costMicros: string
    readonly requests: number
    readonly tokens: number
  }
  /** 逐日序列。 */
  readonly daily: readonly DayPoint[]
  /** 按模型分组。 */
  readonly models: readonly ModelBoard[]
  /** 可选的 API Key。 */
  readonly apiKeys: readonly ApiKeyOption[]
  /** 当前选中的时间维度。 */
  readonly range: RangeKey
  /** 当前选中的 API Key（null = 全部）。 */
  readonly apiKeyId: string | null
  /** 当前图表分组维度。 */
  readonly groupBy: GroupBy
  /** 数据生成时间。 */
  readonly generatedAt: string
  /** 当前登录用户 id；null = 没有会话（页面按全站口径展示）。 */
  readonly userId: number | null
  /** 当前用户显示名（没有会话时为 null）。 */
  readonly userName: string | null
  /** 当前用户余额，微元。 */
  readonly userBalanceMicros: string
}

/** 微元字符串 → 元（number）。只用于图表比例计算；展示仍用微元字符串。 */
export function microsToYuan(micros: string): number {
  const value = Number(micros)
  if (!Number.isFinite(value)) return 0
  return value / MICROS_PER_YUAN
}

/** 两个微元字符串相加。 */
export function addMicros(a: string, b: string): string {
  return String(BigInt(a || '0') + BigInt(b || '0'))
}

/** 一组微元求和。 */
export function sumMicros(values: readonly string[]): string {
  return values.reduce((total, value) => addMicros(total, value), '0')
}

/** 微元 → 分（整数，四舍五入）。 */
export function microsToCents(micros: string): number {
  const value = BigInt(micros || '0')
  const negative = value < 0n
  const abs = negative ? -value : value
  const cents = (abs * 100n + MICROS_PER_YUAN_BIG / 2n) / MICROS_PER_YUAN_BIG
  return Number(cents) * (negative ? -1 : 1)
}
