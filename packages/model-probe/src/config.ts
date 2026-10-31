import {
  checkConfigObject,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  readString,
  readStringArray,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'

/**
 * 模型可用性探测插件的配置。
 *
 * 分组：**跑不跑**（enabled / intervalMs）→ **怎么测**（gatewayBaseUrl / timeoutMs /
 * degradedThresholdMs / maxConcurrent / probeModels）→ **判成什么**（failureThreshold）→
 * **存多久**（historyPoints / retentionDays）→ **用谁的 key 测**（probeKeyRef / probeUserId）。
 *
 * 非法值一律在构造时失败（`MODEL_PROBE_CONFIG_INVALID`），不静默降级：
 * 一个填错的间隔会让探测变成忙等或永不触发，而「探测没在跑」和「模型全挂了」
 * 在页面上长得一模一样 —— 那正是这次要避免的事。
 */
export interface ModelProbeConfig {
  /** 关掉就完全不跑定时器（插件仍装载，读接口仍可用）。默认 true。 */
  readonly enabled?: boolean
  /** SQLite 路径；相对路径按 cordis 的 baseUrl（仓库根）解析。 */
  readonly dataPath?: string
  /** 两轮探测之间的间隔（毫秒）。 */
  readonly intervalMs?: number
  /** 单个探测请求的超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 探测成功但耗时超过它 → `degraded`（不是 `ok`）。 */
  readonly degradedThresholdMs?: number
  /** 一轮里同时在飞的探测请求数上限。 */
  readonly maxConcurrent?: number
  /**
   * 连续失败多少条才认为这个模型**不可用**（供 `modelhub` 判定用）。
   * 1 = 一条失败就判不可用（容易被上游抖动打红）。
   */
  readonly failureThreshold?: number
  /** 小柱状图要显示多少个点（也是读接口默认返回的条数上限）。 */
  readonly historyPoints?: number
  /** 明细保留天数；过期的探测记录由每轮清理物理删除。 */
  readonly retentionDays?: number
  /**
   * 只探这些**对外模型名**；空数组 = 探目录里的全部模型。
   * 白名单里出现目录里不存在的名字不是错误（那个模型可能还没账号提供）。
   */
  readonly probeModels?: readonly string[]
  /**
   * 探测请求打到哪个网关入口。默认 `http://127.0.0.1:8080`
   * （本地 `app.yml` 的 `account-priority.httpListen`；生产是 `18080`）。
   */
  readonly gatewayBaseUrl?: string
  /**
   * 探测 key 存在 `credentials` 里的引用名。**明文永不进本插件的库**。
   * 不可运行期改：改它等于换一份秘密，必须由人重启决定。
   */
  readonly probeKeyRef?: string
  /**
   * 探测 key 归属的本地用户 id（决定探测花的是谁的钱）。
   * 必须是已存在、启用、且**有余额**的用户 —— 否则额度闸门会 402，
   * 全站探测会一起变红，而那红是假的。
   */
  readonly probeUserId?: number
  /** 允许手动触发一轮探测、改探测配置的插件白名单。默认拒绝。 */
  readonly adminPlugins?: readonly string[]
}

export interface ResolvedModelProbeConfig {
  readonly enabled: boolean
  readonly dataPath: string
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly degradedThresholdMs: number
  readonly maxConcurrent: number
  readonly failureThreshold: number
  readonly historyPoints: number
  readonly retentionDays: number
  readonly probeModels: readonly string[]
  readonly gatewayBaseUrl: string
  readonly probeKeyRef: string
  readonly probeUserId: number
  readonly adminPlugins: readonly string[]
}

export const MODEL_PROBE_DEFAULTS = {
  enabled: true,
  dataPath: './data/model-probe.db',
  /** 5 分钟一轮：几十个模型 × 最小请求，成本压在几分钱量级。 */
  intervalMs: 300_000,
  timeoutMs: 15_000,
  /** 6 秒：与 sub2api 的 degraded 阈值对齐（设计参考，不是抄代码）。 */
  degradedThresholdMs: 6_000,
  maxConcurrent: 2,
  /** 连续 3 条失败才判不可用：单条抖动不该把模型打成红的。 */
  failureThreshold: 3,
  historyPoints: 60,
  retentionDays: 7,
  probeModels: [] as readonly string[],
  gatewayBaseUrl: 'http://127.0.0.1:8080',
  probeKeyRef: 'dizzyapi/model-probe/key',
  adminPlugins: [] as readonly string[],
} as const

/** `probeUserId` 没有默认值：探测花谁的钱是人的决定，不该由默认值替他决定。 */
const PROBE_USER_ID_MIN = 1
const PROBE_USER_ID_MAX = 2_147_483_647

const MODEL_PROBE_FIELDS: readonly FieldSpec[] = [
  { key: 'enabled', label: '启用模型可用性探测', kind: 'boolean', writable: true },
  { key: 'dataPath', label: '探测库路径', kind: 'string', writable: false },
  {
    key: 'intervalMs',
    label: '探测间隔',
    kind: 'integer',
    writable: true,
    min: 10_000,
    max: 3_600_000,
    unit: '毫秒',
  },
  {
    key: 'timeoutMs',
    label: '单个探测超时',
    kind: 'integer',
    writable: true,
    min: 1_000,
    max: 120_000,
    unit: '毫秒',
  },
  {
    key: 'degradedThresholdMs',
    label: '判「慢」的耗时阈值',
    kind: 'integer',
    writable: true,
    min: 100,
    max: 60_000,
    unit: '毫秒',
  },
  {
    key: 'maxConcurrent',
    label: '并发探测上限',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 16,
  },
  {
    key: 'failureThreshold',
    label: '连续失败多少条判不可用',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 100,
  },
  {
    key: 'historyPoints',
    label: '小柱状图点数',
    kind: 'integer',
    writable: true,
    min: 12,
    max: 240,
  },
  {
    key: 'retentionDays',
    label: '明细保留天数',
    kind: 'integer',
    writable: true,
    min: 1,
    max: 90,
  },
  { key: 'probeModels', label: '只探测这些模型（空 = 全部）', kind: 'stringArray', writable: true },
  // 改网关地址等于换探测目标；和凭据引用名一样，必须由人重启决定。
  { key: 'gatewayBaseUrl', label: '探测目标网关地址', kind: 'string', writable: false },
  { key: 'probeKeyRef', label: '探测 key 的凭据引用名', kind: 'string', writable: false, credentialRef: true },
  { key: 'probeUserId', label: '探测 key 归属用户 id', kind: 'integer', writable: false, min: PROBE_USER_ID_MIN, max: PROBE_USER_ID_MAX },
  { key: 'adminPlugins', label: '可手动触发 / 改配置的插件', kind: 'stringArray', writable: false },
]

const KNOWN_KEYS = knownKeysOf(MODEL_PROBE_FIELDS)

/** 探测间隔的下界有意义：10 秒一轮已经是「把上游当压力测试」的边缘了。 */
export function validateModelProbeConfig(
  value: unknown,
): ResolvedModelProbeConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const enabled = readBoolean(raw, 'enabled', issues)
  const dataPath = readString(raw, 'dataPath', issues)
  const intervalMs = readPositiveInteger(raw, 'intervalMs', issues, { min: 10_000, max: 3_600_000 })
  const timeoutMs = readPositiveInteger(raw, 'timeoutMs', issues, { min: 1_000, max: 120_000 })
  const degradedThresholdMs = readPositiveInteger(raw, 'degradedThresholdMs', issues, {
    min: 100,
    max: 60_000,
  })
  const maxConcurrent = readPositiveInteger(raw, 'maxConcurrent', issues, { min: 1, max: 16 })
  const failureThreshold = readPositiveInteger(raw, 'failureThreshold', issues, { min: 1, max: 100 })
  const historyPoints = readPositiveInteger(raw, 'historyPoints', issues, { min: 12, max: 240 })
  const retentionDays = readPositiveInteger(raw, 'retentionDays', issues, { min: 1, max: 90 })
  const probeModels = readStringArray(raw, 'probeModels', issues)
  const gatewayBaseUrl = readString(raw, 'gatewayBaseUrl', issues)
  const probeKeyRef = readString(raw, 'probeKeyRef', issues)
  const probeUserId = readPositiveInteger(raw, 'probeUserId', issues, {
    min: PROBE_USER_ID_MIN,
    max: PROBE_USER_ID_MAX,
  })
  const adminPlugins = readStringArray(raw, 'adminPlugins', issues)

  if (gatewayBaseUrl !== undefined) {
    let parsed: URL | undefined
    try {
      parsed = new URL(gatewayBaseUrl)
    } catch {
      issues.push({ message: `gatewayBaseUrl 不是合法 URL：${gatewayBaseUrl}` })
    }
    if (parsed !== undefined && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push({ message: `gatewayBaseUrl 只支持 http / https，收到 ${parsed.protocol}` })
    }
  }

  // 探测 key 归属用户是**必填**：没有它就不知道该扣谁的钱，探测根本发不出去。
  if (probeUserId === undefined && raw.probeUserId === undefined) {
    issues.push({
      message: 'probeUserId 必填：探测会走真网关并计费，必须指定探测 key 归属的用户 id',
    })
  }

  if (issues.length > 0) return issues

  return {
    enabled: enabled ?? MODEL_PROBE_DEFAULTS.enabled,
    dataPath: dataPath ?? MODEL_PROBE_DEFAULTS.dataPath,
    intervalMs: intervalMs ?? MODEL_PROBE_DEFAULTS.intervalMs,
    timeoutMs: timeoutMs ?? MODEL_PROBE_DEFAULTS.timeoutMs,
    degradedThresholdMs: degradedThresholdMs ?? MODEL_PROBE_DEFAULTS.degradedThresholdMs,
    maxConcurrent: maxConcurrent ?? MODEL_PROBE_DEFAULTS.maxConcurrent,
    failureThreshold: failureThreshold ?? MODEL_PROBE_DEFAULTS.failureThreshold,
    historyPoints: historyPoints ?? MODEL_PROBE_DEFAULTS.historyPoints,
    retentionDays: retentionDays ?? MODEL_PROBE_DEFAULTS.retentionDays,
    probeModels: probeModels ?? MODEL_PROBE_DEFAULTS.probeModels,
    gatewayBaseUrl: normalizeBaseUrl(gatewayBaseUrl ?? MODEL_PROBE_DEFAULTS.gatewayBaseUrl),
    probeKeyRef: probeKeyRef ?? MODEL_PROBE_DEFAULTS.probeKeyRef,
    probeUserId: probeUserId as number,
    adminPlugins: adminPlugins ?? MODEL_PROBE_DEFAULTS.adminPlugins,
  }
}

/** 去掉末尾斜杠：`http://127.0.0.1:8080/` 与不带斜杠的写法必须等价。 */
function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export const MODEL_PROBE_CONFIG_SCHEMA = standardSchema<ResolvedModelProbeConfig>(
  'dizzyapi',
  validateModelProbeConfig,
  MODEL_PROBE_FIELDS,
)

/**
 * 解包成「已校验」或「issue 列表」。
 *
 * cordis 会先把 schema 校验过的对象再传进构造函数，所以这里要能认出「已经解包过的」，
 * 否则同一份配置会被校验两遍（而且第二遍会把它当成「缺 probeUserId」的原始配置）。
 */
export function resolveModelProbeConfig(
  config: ModelProbeConfig | ResolvedModelProbeConfig,
): ResolvedModelProbeConfig | readonly StandardIssue[] {
  if (isResolved(config)) return config
  const result = MODEL_PROBE_CONFIG_SCHEMA['~standard'].validate(config)
  if ('issues' in result) return result.issues
  return result.value
}

function isResolved(value: ModelProbeConfig | ResolvedModelProbeConfig): value is ResolvedModelProbeConfig {
  return (
    typeof (value as ResolvedModelProbeConfig).intervalMs === 'number' &&
    typeof (value as ResolvedModelProbeConfig).probeUserId === 'number' &&
    typeof (value as ResolvedModelProbeConfig).gatewayBaseUrl === 'string'
  )
}
