/**
 * 模型广场「可用性小柱状图」的**纯逻辑**（无 React、无 import，可被 node 测试直接跑）。
 *
 * 三件事都在这里，页面只负责画：
 * 1. **点 → 柱**：四态映射成「高度 + 颜色」双编码，最新在最右，左侧不足补灰；
 * 2. **停摆提示**：`blockedReason` → 一句人话（**必须指明「不是模型故障」**）；
 * 3. **读屏文案**：图是装饰，真正被读的是这一句统计。
 *
 * ## 为什么「假红」在这里也要防
 *
 * `probe-error` 的四态之一是**探测自己**没测出来（探测账户余额不足 / 探测 key 被拒 /
 * 连不上网关）。它和 `failed`（模型真的不回话）必须分得开：
 * - 高度上 `failed` 最低（15%）、`probe-error` 在它之上（35%）；
 * - 颜色上 `failed` 是 `--destructive`（红），`probe-error` 是 `--chart-1`（淡，表示「没结论」）。
 *
 * 如果两者画成一样，一次「探测账户没钱」就会让整个广场变红，而模型一个都没挂 ——
 * `总工` 的原话是「假红比不监测更糟」。
 *
 * ## 配色为什么不硬编码
 *
 * 只用主题里的 CSS 变量（`--chart-N` + `--destructive` + `--muted`）：站点有浅色 / 深色与
 * 多套配色预设，写死十六进制在深色下会糊。**也不注入 `<style>`** ——
 * 新前端的 CSP 是 `style-src 'self' + 两个 sha256`，注入的样式表会被拦掉；
 * 行内 `style` 属性走 `style-src-attr`，是允许的（饼图同理）。
 */

/** 探测点四态（与服务端 `packages/model-probe` 的分类逐字一致）。 */
export type ProbePointStatus = 'ok' | 'degraded' | 'failed' | 'probe-error'

/** 一个点里本文件用到的字段（结构面，不 import 服务端类型）。 */
export interface ProbePointLike {
  readonly status: string
  readonly latencyMs: number
  readonly httpStatus: number | null
  readonly errorCode: string | null
  readonly testedAtMs: number
}

/** 一个模型的探测视图里本文件用到的字段。 */
export interface ProbeViewLike {
  readonly probed: boolean
  readonly health: string
  readonly consecutiveFailures: number
  readonly lastOkAtMs: number | null
  readonly lastTestedAtMs: number | null
  readonly points: readonly ProbePointLike[]
}

/** 探测总体状态里本文件用到的字段。 */
export interface ProbeSummaryLike {
  readonly enabled: boolean
  readonly running: boolean
  readonly blockedReason: string | null
  readonly blockedDetail: string | null
  readonly lastPassAt: string | null
  readonly failureThreshold: number
  readonly downCount: number
}

/**
 * 默认槽位数（= 服务端 `probeHistoryPoints` 的默认值）。
 *
 * 页面会按「本页最多的那个模型」重算一次再传进来，好让所有行**左端对齐**：
 * 不然 24 点的行和 3 点的行宽度不同，一屏柱子参差不齐。
 */
export const PROBE_BAR_SLOTS = 24

/** 槽位下限：再少就不叫「趋势」了；同时保证窄屏不会缩成一团。 */
export const PROBE_BAR_MIN_SLOTS = 8

/** 槽位上限：防止服务端某个配置把一屏画成几百根柱子。 */
export const PROBE_BAR_MAX_SLOTS = 60

/** 柱子的「形态」：实心 / 空心描边。**这是编码的一部分，不是装饰。** */
export type ProbeBarShape = 'solid' | 'hollow'

/** 一根柱子的完整描述。 */
export interface ProbeBar {
  /** React key（`t<毫秒>` 或 `empty<n>`）。 */
  readonly key: string
  /** 四态；空占位是 `null`。 */
  readonly status: ProbePointStatus | null
  /** 柱高占轨道高度的百分比。 */
  readonly heightPercent: number
  /** 颜色（CSS 变量表达式，随主题变）。 */
  readonly color: string
  /** **形态编码**：`hollow` = 只描边不填充（表示「这次没测出结论」）。 */
  readonly shape: ProbeBarShape
  /** 是不是「左侧补灰」的占位（当时还没开始探测）。 */
  readonly placeholder: boolean
  /** 悬停文案（`<title>`）：时间 + 结论 + 耗时。 */
  readonly label: string
}

/**
 * 一个槽位的样式表。
 *
 * 三层编码，**从强到弱**：
 * 1. **高度**按健康序（越高越健康）—— 灰度打印、色盲、随便换主题都还在；
 * 2. **形态**（实心 / 空心）—— 主题配色变了也不失效，见下面 `probe-error` 的说明；
 * 3. **颜色**（`--chart-N` / `--destructive`）—— 只当第三层，别把判断压在它身上。
 */
const BAR_STYLES: Readonly<
  Record<
    ProbePointStatus,
    { readonly heightPercent: number; readonly color: string; readonly shape: ProbeBarShape; readonly text: string }
  >
> = {
  ok: { heightPercent: 100, color: 'var(--chart-3)', shape: 'solid', text: '正常' },
  degraded: { heightPercent: 65, color: 'var(--chart-2)', shape: 'solid', text: '偏慢' },
  /**
   * 「没结论」≠「坏了」：
   * - 不用红色（那就是假红：余额不足会让所有模型都变成红的，而模型其实没挂）；
   * - **用空心描边，不用填充**。2026-10-31 真机验收抓到的真问题：这一档原来用
   *   `--chart-1`，而灰阶主题里 `--chart-1` 是 `oklch(0.87 0 0)`，白底对比度约 1.3:1，
   *   和「左侧补灰」的 `--muted` 占位肉眼分不开 —— 等于这个状态**隐身**。
   *
   * **描边是承重的，不是装饰**：靠颜色区分四态，主题配色一换（或用了灰阶预设）编码就失效；
   * 形状（实心 / 空心）与填充（有 / 无）跟配色无关。删掉 `border` 之前先看这段。
   */
  'probe-error': {
    heightPercent: 35,
    color: 'var(--muted-foreground)',
    shape: 'hollow',
    text: '探测自身异常',
  },
  failed: { heightPercent: 15, color: 'var(--destructive)', shape: 'solid', text: '失败' },
}

/** 空占位（左侧补灰）的样式：最矮、最淡、**实心**（这样和空心的 `probe-error` 一眼分得开）。 */
const PLACEHOLDER_STYLE = { heightPercent: 15, color: 'var(--muted)', shape: 'solid' } as const

/** 轨道高度（px）。**固定值**：柱子高度用百分比，所以容器必须有确定高度。 */
export const PROBE_BAR_TRACK_PX = 28

/**
 * 服务端四态归一化。
 *
 * **未知状态串一律当 `probe-error`（不是 `failed`）**：读不出来的东西不能判模型死刑，
 * 那正是「假红」的另一种形态。（服务端 `normalizePointStatus` 折成 `failed`，
 * 所以正常数据下这里不会命中；这条是防御脏数据 / 旧库的。）
 */
export function normalizePointStatus(value: string): ProbePointStatus {
  if (value === 'ok' || value === 'degraded' || value === 'failed' || value === 'probe-error') return value
  return 'probe-error'
}

/** 四态 → 中文（柱子的 `<title>`、图例、统计句共用）。 */
export function probePointText(status: string): string {
  return BAR_STYLES[normalizePointStatus(status)].text
}

/** 健康度 → 中文。`unknown` 是**一等状态**，不是「正常」。 */
export function probeHealthText(health: string): string {
  switch (health) {
    case 'up':
      return '正常'
    case 'degraded':
      return '抖动'
    case 'down':
      return '连续失败'
    case 'unknown':
      return '未知'
    default:
      return health === '' ? '未知' : health
  }
}

/**
 * 健康度 → 徽标色调（页面映射到 `Badge` 的 variant / 类名）。
 *
 * `unknown` 给 `muted` 而不是 `danger`：探测停摆时全部是 `unknown`，
 * 给红色就又变回「假红」了。
 */
export function probeHealthTone(health: string): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (health) {
    case 'up':
      return 'ok'
    case 'degraded':
      return 'warn'
    case 'down':
      return 'danger'
    default:
      return 'muted'
  }
}

/** 夹住槽位数：恒在 `[MIN, MAX]` 之间，非整数 / NaN 走默认值。 */
export function clampProbeSlots(slots: number | undefined): number {
  if (slots === undefined || !Number.isFinite(slots)) return PROBE_BAR_SLOTS
  const rounded = Math.trunc(slots)
  if (rounded < PROBE_BAR_MIN_SLOTS) return PROBE_BAR_MIN_SLOTS
  if (rounded > PROBE_BAR_MAX_SLOTS) return PROBE_BAR_MAX_SLOTS
  return rounded
}

/**
 * 服务端点数 → 一排柱子（**最右是「现在」**，左侧不足补灰）。
 *
 * 服务端给的 `points` 是**最新在前**；图上要从左（旧）往右（新）画，所以这里反过来。
 * 点数比槽位多时**留最近的**（丢掉最老的），不能让新数据被挤掉。
 */
export function probeBars(points: readonly ProbePointLike[], slots?: number): ProbeBar[] {
  const count = clampProbeSlots(slots)
  // 最新在前 → 反过来；再取末尾 count 个（= 最近 count 个）。
  const ordered = [...points].reverse().slice(-count)
  const bars: ProbeBar[] = []
  for (let index = ordered.length; index < count; index += 1) {
    bars.push({
      key: `empty${index}`,
      status: null,
      heightPercent: PLACEHOLDER_STYLE.heightPercent,
      color: PLACEHOLDER_STYLE.color,
      shape: PLACEHOLDER_STYLE.shape,
      placeholder: true,
      label: '（还没有这一次探测）',
    })
  }
  for (const point of ordered) {
    const status = normalizePointStatus(point.status)
    const style = BAR_STYLES[status]
    bars.push({
      key: `t${point.testedAtMs}`,
      status,
      heightPercent: style.heightPercent,
      color: style.color,
      shape: style.shape,
      placeholder: false,
      label: `${style.text} · 耗时 ${Math.max(0, Math.trunc(point.latencyMs))} 毫秒${
        point.errorCode === null ? '' : ` · ${point.errorCode}`
      }`,
    })
  }
  return bars
}

/** 统计结果：给读屏与悬停用的一句话。 */
export interface ProbeTally {
  readonly total: number
  readonly ok: number
  readonly degraded: number
  readonly failed: number
  readonly probeError: number
}

/** 数一数每种结论各几条（**不做健康度判定**，判定归服务端）。 */
export function tallyProbePoints(points: readonly ProbePointLike[]): ProbeTally {
  const tally = { total: points.length, ok: 0, degraded: 0, failed: 0, probeError: 0 }
  for (const point of points) {
    switch (normalizePointStatus(point.status)) {
      case 'ok':
        tally.ok += 1
        break
      case 'degraded':
        tally.degraded += 1
        break
      case 'failed':
        tally.failed += 1
        break
      default:
        tally.probeError += 1
    }
  }
  return tally
}

/**
 * 图的**读屏文案**：图本身 `aria-hidden`，被读的是这一句。
 *
 * 只说事实（几条正常 / 几条失败），不替服务端下结论。
 */
export function probeSummaryText(points: readonly ProbePointLike[]): string {
  const tally = tallyProbePoints(points)
  if (tally.total === 0) return '还没有探测数据'
  const parts: string[] = []
  if (tally.ok > 0) parts.push(`${tally.ok} 次正常`)
  if (tally.degraded > 0) parts.push(`${tally.degraded} 次偏慢`)
  if (tally.failed > 0) parts.push(`${tally.failed} 次失败`)
  if (tally.probeError > 0) parts.push(`${tally.probeError} 次探测自身异常`)
  return `最近 ${tally.total} 次探测：${parts.join('、')}`
}

/** 探测停摆 / 未启用的提示；`null` = 一切正常，不占版面。 */
export interface ProbeNotice {
  readonly title: string
  readonly description: string
  /** `danger` 用醒目样式（停摆），`muted` 只说明状态（没启用 / 第一轮还没跑完）。 */
  readonly tone: 'danger' | 'muted'
}

/**
 * 停摆原因码 → 人话。
 *
 * **每一句都要说清「这不是模型故障」**，否则用户看到一片「未知」只会以为模型全挂了。
 * 未知码原样带出来（`（code）`），不假装认识。
 */
const BLOCKED_REASONS: Readonly<Record<string, string>> = {
  probe_user_balance_exhausted:
    '探测账户余额不足，探测已停摆。这不是模型故障：下面显示的可用性来自停摆前的旧数据，可能已经过期。',
  probe_key_rejected: '探测用的密钥被网关拒绝，探测已停摆。这不是模型故障。',
  probe_key_secret_missing: '探测用的密钥没有配置，探测没有在跑。这不是模型故障。',
  probe_user_unavailable: '探测账户不存在或已被停用，探测已停摆。这不是模型故障。',
  gateway_unreachable: '连不上探测目标网关，探测已停摆。这不是模型故障。',
}

/**
 * 探测总体状态 → 顶部提示。
 *
 * 判定顺序有意义：**先看停摆**（有原因吗）→ 再看没启用 → 最后才是「第一轮还没跑完」。
 * 停摆时绝不能显示「正常」，也绝不能把「未知」画成「挂了」。
 */
export function probeNoticeOf(summary: ProbeSummaryLike | undefined): ProbeNotice | null {
  if (summary === undefined) return null
  if (summary.blockedReason !== null) {
    const known = BLOCKED_REASONS[summary.blockedReason]
    return {
      title: '模型探测已停摆',
      description: known ?? `探测已停摆（${summary.blockedReason}）。这不是模型故障。`,
      tone: 'danger',
    }
  }
  if (!summary.enabled) {
    return {
      title: '模型探测已关闭',
      description: '管理员没有启用模型可用性探测，所以这里没有探测数据。可用性仍然按账号声明与健康度给出。',
      tone: 'muted',
    }
  }
  if (summary.lastPassAt === null) {
    return {
      title: '探测正在准备中',
      description: summary.running ? '第一轮探测正在执行，稍后刷新即可。' : '还没有跑完第一轮探测。',
      tone: 'muted',
    }
  }
  return null
}

/** 行内补充文案：连续失败了几条（`0` 时不给文字，留白）。 */
export function probeFailureText(consecutiveFailures: number, failureThreshold: number): string | null {
  const count = Math.max(0, Math.trunc(consecutiveFailures))
  if (count === 0) return null
  const limit = Math.max(1, Math.trunc(failureThreshold))
  return count >= limit ? `已连续失败 ${count} 次` : `连续失败 ${count} 次`
}
