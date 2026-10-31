/**
 * 模型可用性探测的对外形状。
 *
 * 分层：**事实**由本插件落库（每次探测一条样本）；**判定**归 `modelhub`
 * （它读本插件的只读视图，自己不写任何东西）。
 *
 * 状态四态（设计参考 sub2api 的 channel monitor，实现自己写）：
 * - `ok`        请求成功且耗时未超 degraded 阈值
 * - `degraded`  请求成功但慢（超过 `degradedThresholdMs`）
 * - `failed`    **模型真的调不通**（上游 4xx/5xx、模型不存在、网络失败）
 * - `probe-error` **探测自己出问题**（探测 key 无效 / 余额不足 402 / 网关内部错误）
 *
 * 最后一态是整个设计里最重要的一格：`probe-error` **绝不能**被算成 `failed`。
 * 探测账户余额耗尽会让所有模型显示为红，但模型其实一个都没挂 —— 假红比不监测更糟。
 */
export type ModelProbeStatus = 'ok' | 'degraded' | 'failed' | 'probe-error'

/** 一个模型「现在怎么样」的派生判定（由连续样本算出来，不落库）。 */
export type ModelProbeHealth = 'up' | 'degraded' | 'down' | 'unknown'

/** 一次探测的结果（落库前的形状）。**不含凭据、不含上游响应正文。** */
export interface ModelProbeSample {
  /** 对外模型名（客户端请求里用的那个）。 */
  readonly model: string
  readonly status: ModelProbeStatus
  /** 端到端耗时（毫秒，含网关与上游）。`probe-error` 时为 0 或实际耗时。 */
  readonly latencyMs: number
  /** 网关返回的 HTTP 状态码；`null` = 没拿到响应（网络错误 / 超时）。 */
  readonly httpStatus: number | null
  /**
   * 稳定的机器可读原因码（中文/英文都行，但必须是短码而不是正文）：
   * `INSUFFICIENT_BALANCE` / `API_KEY_INVALID` / `timeout` / `network_error` …
   * 成功时为 `null`。
   */
  readonly errorCode: string | null
  /** 探测发生时刻（毫秒时间戳）。 */
  readonly testedAtMs: number
}

/** 落库后的一行（带自增 id）。 */
export interface ModelProbeSampleRow extends ModelProbeSample {
  readonly id: number
}

/** 单个模型的小柱状图数据：最近的 N 个点 + 派生健康度。 */
export interface ModelProbeHistory {
  readonly model: string
  /** 最新在前（与 sub2api 的「最右是现在」相反，由前端决定怎么摆）。 */
  readonly points: readonly ModelProbeSampleRow[]
  readonly health: ModelProbeHealth
  /** 连续失败条数（只数 `failed`，`probe-error` 与 `ok`/`degraded` 都打断它）。 */
  readonly consecutiveFailures: number
  /** 最近一次成功（`ok` / `degraded`）的时刻；null = 从来没成功过。 */
  readonly lastOkAtMs: number | null
  /** 最近一条样本的时刻；null = 从没探过。 */
  readonly lastTestedAtMs: number | null
}

/** 一天的滚动汇总（长期可用率窗口用；明细超期删掉后仍能看到趋势）。 */
export interface ModelProbeDailyRollup {
  readonly model: string
  /** `YYYY-MM-DD`（UTC）。 */
  readonly day: string
  readonly totalChecks: number
  readonly okCount: number
  readonly degradedCount: number
  readonly failedCount: number
  readonly probeErrorCount: number
  readonly sumLatencyMs: number
  /** 有耗时的样本条数（算平均耗时用；`probe-error` 不计入）。 */
  readonly countLatency: number
}

/** 一轮探测的可观察结果。 */
export interface ModelProbePass {
  /** 这一轮实际探了几个模型。 */
  readonly probed: number
  readonly ok: number
  readonly degraded: number
  readonly failed: number
  /**
   * 探测自身出问题的条数。**> 0 时这一轮的结果不可信**：
   * 通常是探测 key 无效或探测用户余额不足。
   */
  readonly probeErrors: number
  /** 这一轮探的模型名（用于排障，不含任何秘密）。 */
  readonly models: readonly string[]
  /** 这一轮为什么没探（`null` = 正常跑完）。 */
  readonly skippedReason: string | null
}

/**
 * 探测停摆的原因（给管理页直接显示）。
 *
 * `null` = 正常。非 null 时页面必须明确说「探测没有在跑」，不能让它看起来像「模型全挂了」。
 */
export type ModelProbeBlockedReason =
  /** 探测 key 的明文不在 credentials 里。 */
  | 'probe_key_secret_missing'
  /** 探测用户不存在 / 被禁用。 */
  | 'probe_user_unavailable'
  /** 额度闸门返回 402：探测用户余额不足，探测已停摆。 */
  | 'probe_user_balance_exhausted'
  /** 网关连不上（`gatewayBaseUrl` 打不通）。 */
  | 'gateway_unreachable'
  /** 探测 key 被网关拒绝（401）。 */
  | 'probe_key_rejected'

/** `status()` 的运行期视图（不含任何秘密）。 */
export interface ModelProbeState {
  readonly enabled: boolean
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly degradedThresholdMs: number
  readonly maxConcurrent: number
  readonly failureThreshold: number
  readonly historyPoints: number
  readonly retentionDays: number
  /** 白名单为空 = 探全部模型。 */
  readonly probeModels: readonly string[];
  readonly gatewayBaseUrl: string
  readonly probeUserId: number
  readonly probeKeyRef: string
  /** 探测 key 配没配（只回布尔，不回值）。 */
  readonly probeKeyConfigured: boolean
  /** 探测 key 的 keyId；`null` = 还没创建过。 */
  readonly probeKeyId: string | null
  /** 探测 key 的名字（形如 `__probe__dizzy`）；`null` = 还没创建过。 */
  readonly probeKeyName: string | null
  /** 是否有一轮正在跑（单飞）。 */
  readonly running: boolean
  /** 上一轮结果；还没跑过为 null。 */
  readonly lastPass: ModelProbePass | null
  readonly lastPassAt: string | null
  /** 探测停摆的原因；`null` = 正常。**页面必须显示它。** */
  readonly blockedReason: ModelProbeBlockedReason | null
  readonly blockedDetail: string | null
  /** 累计探测条数（只增）。 */
  readonly samples: number
  readonly lastPrunedAt: string | null
}

/** 只读视图：`modelhub` 与 API 层只依赖这些方法，不 import 实现类。 */
export interface ModelProbeServiceLike {
  history(model: string, limit?: number): ModelProbeHistory
  histories(limit?: number): readonly ModelProbeHistory[]
  daily(model: string, days?: number): readonly ModelProbeDailyRollup[]
  status(): ModelProbeState
}
