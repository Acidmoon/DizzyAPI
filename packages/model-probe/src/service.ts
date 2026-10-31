/**
 * 模型可用性探测插件（服务名 `modelProbe`）。
 *
 * 它做四件事，只做这四件：
 * 1. 定时取「模型广场里当前有哪些模型」；
 * 2. 对每个模型**走真网关**发一条最小请求（真探测 key → 计费 → 落用量）；
 * 3. 把结果按模型落 SQLite（明细 + 日汇总）；
 * 4. 提供只读视图（历史 / 健康度 / 状态）给 `modelhub` 与 API 层。
 *
 * ## 边界
 *
 * - **不判「模型不可用」**：判定归 `modelhub`，本插件只给事实（`health` 是派生视图，
 *   不是写入的状态）。
 * - **秘密只在 `credentials`**：探测 key 的明文只在创建 / 轮换那一刻出现，随后只持引用名；
 *   明文永不进本插件的库、日志与探测记录。
 * - **一个数据一个写者**：`data/model-probe.db` 只有本插件写。
 * - 全部副作用挂 `ctx.effect`：卸载即停定时器；在飞的探测结果在 disposed 后一律丢弃。
 *
 * ## 为什么必须有 `probe-error` 这一态
 *
 * 探测走真链路，就会受额度闸门约束。探测用户余额耗尽时，**所有模型都会 402**。
 * 如果把 402 记成 `failed`，页面上会出现「全站模型一起挂了」的假红 ——
 * 那比不监测更糟，因为它会让人去查一个根本不存在的故障。
 *
 * 本文件只放**编排**：目标挑选在 `targets.ts`、结果分类在 `probe-client.ts`、
 * 健康度派生在 `health.ts`、SQL 在 `store.ts`、服务解析在 `seams.ts`。
 */
import { Service, type Context, type Logger } from 'cordis'
// 只为了类型：@cordisjs/plugin-timer 往 Context 上 mixin 了 setInterval。
import type {} from '@cordisjs/plugin-timer'
import { describeError, isIssueList } from '@dizzyapi/plugin-kit'
import type { DatabaseSync } from 'node:sqlite'
import {
  MODEL_PROBE_CONFIG_SCHEMA,
  MODEL_PROBE_DEFAULTS,
  resolveModelProbeConfig,
  type ModelProbeConfig,
  type ResolvedModelProbeConfig,
} from './config.ts'
import { openModelProbeDatabase } from './db.ts'
import { ModelProbeError } from './errors.ts'
import { deriveHealth, passIsUntrustworthy } from './health.ts'
import {
  HEALTH_WINDOW_MIN,
  emptyPass,
  normalizeActor,
  normalizeLimit,
  normalizeModel,
  summarize,
} from './pass-summary.ts'
import { runProbe } from './probe-client.ts'
import { PROBE_KEY_NAME, PROBE_KEY_NAME_PREFIX, ensureProbeKey } from './probe-key.ts'
import { apiKeySeam, credentialsSeam, modelHubSeam } from './seams.ts'
import { ModelProbeStore } from './store.ts'
import { decideBlocked, pickTargets } from './targets.ts'
import type {
  ModelProbeBlockedReason,
  ModelProbeDailyRollup,
  ModelProbeHistory,
  ModelProbePass,
  ModelProbeSample,
  ModelProbeState,
} from './types.ts'

/** 本插件作为写者 / 调用方时用的 actor 名。 */
export const MODEL_PROBE_ACTOR = '@dizzyapi/plugin-model-probe'

export class ModelProbeService extends Service {
  static Config = MODEL_PROBE_CONFIG_SCHEMA

  /**
   * 只 inject `timer`（`ctx.setInterval` 是 @cordisjs/plugin-timer 的 mixin，
   * 不声明会直接抛 `cannot get property "timer" without inject`）。
   *
   * `apiKey` / `credentials` / `modelhub` 都在**运行期**解析（D5）：它们被禁用时
   * 本插件不跟着 PENDING，而是把「探测停摆的原因」摆到 `status()` 上 ——
   * 静默不探测和「模型全挂了」在页面上长得一模一样，必须能区分。
   */
  static inject = ['timer']

  static catalog = {
    capabilities: ['model-availability-probe', 'model-probe-history'],
    events: [
      {
        name: 'model-probe/pass',
        description: '跑完一轮探测（不含任何秘密）',
        payload: 'probed: number, failed: number, probeErrors: number',
      },
    ],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'sqlite', description: '探测明细与日汇总' }],
    methods: {
      history: { description: '单个模型的探测历史 + 派生健康度' },
      histories: { description: '所有探测过的模型的历史（读接口用）' },
      daily: { description: '单个模型的日汇总（长期可用率）' },
      status: { description: '探测运行状态与停摆原因（不含秘密）' },
      runOnce: { description: '手动跑一轮探测（只对 adminPlugins 开放）' },
    },
    shapes: {
      ModelProbeSample: {
        description: '一次探测的结果；不含凭据与上游响应正文',
        fields: {
          model: { type: 'string' },
          status: { type: 'string' },
          latencyMs: { type: 'integer' },
          httpStatus: { type: 'integer|null' },
          errorCode: { type: 'string|null' },
          testedAtMs: { type: 'integer' },
        },
      },
    },
  } as const

  readonly config: ResolvedModelProbeConfig
  private readonly logger: Logger
  private readonly adminPlugins: readonly string[]
  private db: DatabaseSync | undefined
  private store: ModelProbeStore | undefined
  private ready = false
  private disposed = false
  private running: Promise<ModelProbePass> | undefined
  private lastPass: ModelProbePass | null = null
  private lastPassAt: string | null = null
  private lastPrunedAt: string | null = null
  private blockedReason: ModelProbeBlockedReason | null = null
  private blockedDetail: string | null = null
  private probeKeyId: string | null = null
  private probeKeyName: string | null = null
  /** 探测用的 fetch。可替换是为了让单测不碰真网络。 */
  private fetchImpl: typeof fetch

  constructor(ctx: Context, config: ModelProbeConfig | ResolvedModelProbeConfig = {} as ModelProbeConfig) {
    super(ctx, 'modelProbe')
    const resolved = resolveModelProbeConfig(config)
    if (isIssueList(resolved)) {
      throw new ModelProbeError(
        'MODEL_PROBE_CONFIG_INVALID',
        `模型探测插件配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.adminPlugins = resolved.adminPlugins
    this.logger = ctx.logger('model-probe')
    this.fetchImpl = fetch
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    // 库在装载时打开（与 usage / billing 一致）：构造期就落盘会让「配置非法」变成「建了个坏库」。
    this.db = openModelProbeDatabase(this.config.dataPath)
    this.store = new ModelProbeStore(this.db)
    this.probeKeyId = this.store.getMeta('probeKeyId') ?? null
    this.ready = true
    // 注册即副作用：插件卸载时数据库连接跟着回收（AGENTS.md D5）。
    this.ctx.effect(() => () => this.close(), 'model-probe.db')

    this.logger.info(
      `模型可用性探测已装载：每 ${String(this.config.intervalMs)}ms 一轮、超时 ${String(this.config.timeoutMs)}ms、` +
        `连续失败 ${String(this.config.failureThreshold)} 条判不可用、并发 ${String(this.config.maxConcurrent)}；` +
        `探测用户 #${String(this.config.probeUserId)}；启用 ${this.config.enabled ? '开' : '关'}`,
    )

    if (!this.config.enabled) {
      this.logger.info('模型探测已禁用（enabled=false）：不注册定时器')
      yield () => {
        this.disposed = true
      }
      return
    }
    if (this.ctx.get('timer', false) === undefined) {
      throw new ModelProbeError(
        'MODEL_PROBE_DEPENDENCY_UNAVAILABLE',
        'timer 服务不可用（app.yml 的 timer entry 没启用），无法注册探测定时器',
      )
    }

    // 探测 key 必须在第一轮之前就绪；建不出来就记下停摆原因，而不是让整轮探测假装跑过。
    try {
      await this.ensureKey()
    } catch (error) {
      this.block('probe_key_secret_missing', describeError(error))
      this.logger.warn(`探测 key 未就绪，第一轮探测将不会发请求：${describeError(error)}`)
    }

    const stop = this.ctx.effect(
      () =>
        this.ctx.setInterval(() => {
          void this.runPass().catch((error: unknown) => {
            this.logger.warn(`模型探测失败：${describeError(error)}`)
          })
        }, this.config.intervalMs),
      'modelProbe.timer',
    )

    yield () => {
      this.disposed = true
      stop()
    }
  }

  // ───────────────────────────────── 读面

  /** 单个模型的探测历史 + 派生健康度。 */
  history(model: string, limit?: number): ModelProbeHistory {
    this.assertReady()
    const name = normalizeModel(model)
    const take = normalizeLimit(limit, this.config.historyPoints)
    const points = this.storeOf().recent(name, take)
    const derived = deriveHealth(points, this.config.failureThreshold)
    return { model: name, points, ...derived }
  }

  /** 所有探过的模型的历史（管理页 / 广场页批量读）。 */
  histories(limit?: number): readonly ModelProbeHistory[] {
    this.assertReady()
    return this.storeOf().probedModels().map((model) => this.history(model, limit))
  }

  /** 单个模型的日汇总（长期可用率窗口）。 */
  daily(model: string, days = 30): readonly ModelProbeDailyRollup[] {
    this.assertReady()
    const name = normalizeModel(model)
    const take = Math.min(Math.max(1, Math.trunc(days)), 365)
    return this.storeOf().daily(name, take)
  }

  status(): ModelProbeState {
    const credentials = credentialsSeam(this.ctx)
    return {
      enabled: this.config.enabled,
      intervalMs: this.config.intervalMs,
      timeoutMs: this.config.timeoutMs,
      degradedThresholdMs: this.config.degradedThresholdMs,
      maxConcurrent: this.config.maxConcurrent,
      failureThreshold: this.config.failureThreshold,
      historyPoints: this.config.historyPoints,
      retentionDays: this.config.retentionDays,
      probeModels: this.config.probeModels,
      gatewayBaseUrl: this.config.gatewayBaseUrl,
      probeUserId: this.config.probeUserId,
      probeKeyRef: this.config.probeKeyRef,
      probeKeyConfigured: credentials?.describe(this.config.probeKeyRef).configured ?? false,
      probeKeyId: this.probeKeyId,
      probeKeyName: this.probeKeyName,
      running: this.running !== undefined,
      lastPass: this.lastPass,
      lastPassAt: this.lastPassAt,
      blockedReason: this.blockedReason,
      blockedDetail: this.blockedDetail,
      samples: this.store?.count() ?? 0,
      lastPrunedAt: this.lastPrunedAt,
    }
  }

  // ───────────────────────────────── 写面（探测）

  /** 手动跑一轮；只对白名单里的插件开放（定时器自己不走这里）。 */
  async runOnce(actor: string): Promise<ModelProbePass> {
    this.assertReady()
    const name = normalizeActor(actor)
    if (!this.adminPlugins.includes(name)) {
      throw new ModelProbeError(
        'MODEL_PROBE_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权触发模型探测（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
    return this.runPass()
  }

  /** 跑一轮探测。单飞：上一轮没跑完就返回同一个 Promise。 */
  runPass(): Promise<ModelProbePass> {
    this.assertReady()
    if (this.running !== undefined) return this.running
    const task = this.doPass().finally(() => {
      this.running = undefined
    })
    this.running = task
    return task
  }

  private async doPass(): Promise<ModelProbePass> {
    const targets = this.resolveTargets()
    if (targets.models.length === 0) {
      const empty = emptyPass(targets.emptyCatalog ? 'catalog_empty' : 'no_candidates')
      this.lastPass = empty
      this.lastPassAt = new Date().toISOString()
      if (targets.emptyCatalog) this.block('gateway_unreachable', '模型目录为空：没有可探测的模型')
      return empty
    }

    // 每轮都从 credentials 解析明文：轮换之后不用重启就能用上新值。
    const token = credentialsSeam(this.ctx)?.resolve(this.config.probeKeyRef)
    if (token === undefined || token === '') {
      const skipped = emptyPass('probe_key_secret_missing')
      this.block(
        'probe_key_secret_missing',
        `credentials 里没有探测 key 的明文（引用名 ${this.config.probeKeyRef}）`,
      )
      this.lastPass = skipped
      this.lastPassAt = new Date().toISOString()
      return skipped
    }

    const results = await this.probeAll(targets.models, token)
    const pass = summarize(results, targets.models)
    if (this.disposed) return emptyPass('disposed')

    this.lastPass = pass
    this.lastPassAt = new Date().toISOString()
    this.applyPassVerdict(pass)
    this.ctx.emit('model-probe/pass', pass.probed, pass.failed, pass.probeErrors)
    this.logger.debug(
      `探测完成：${String(pass.probed)} 个模型（ok ${String(pass.ok)} / degraded ${String(pass.degraded)} / ` +
        `failed ${String(pass.failed)} / probe-error ${String(pass.probeErrors)}）`,
    )
    this.pruneIfDue()
    return pass
  }

  /** 有界并发地把所有目标探一遍；每条结果立刻落库（中途卸载也不丢已探的）。 */
  private async probeAll(models: readonly string[], token: string): Promise<ModelProbeSample[]> {
    const results: ModelProbeSample[] = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.disposed) return
        const index = cursor
        cursor += 1
        if (index >= models.length) return
        const sample = await runProbe({ model: models[index] }, token, {
          fetch: this.fetchImpl,
          now: Date.now,
          gatewayBaseUrl: this.config.gatewayBaseUrl,
          timeoutMs: this.config.timeoutMs,
          degradedThresholdMs: this.config.degradedThresholdMs,
        })
        if (this.disposed) return
        results.push(sample)
        // 落库失败不该让整轮挂掉：记一条警告，继续探下一个。
        try {
          this.storeOf().record(sample)
        } catch (error) {
          this.logger.warn(`探测结果落库失败（${sample.model}）：${describeError(error)}`)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.max(1, Math.min(this.config.maxConcurrent, models.length)) }, worker),
    )
    return results
  }

  /**
   * 一轮结束后更新「探测停摆」的判定。
   *
   * 这是假红的主闸：`probe-error` 占多数时不改判、直接把原因挂出来。
   */
  private applyPassVerdict(pass: ModelProbePass): void {
    if (pass.probed === 0) return
    if (!passIsUntrustworthy(pass.probeErrors, pass.probed)) {
      // 这一轮整体可信：清掉停摆标记（单个模型偶发的探测侧错误不构成停摆）。
      if (this.blockedReason !== null) {
        this.logger.info('探测恢复正常：清掉停摆标记')
        this.blockedReason = null
        this.blockedDetail = null
      }
      return
    }
    const verdict = decideBlocked(this.lastErrorCodes(), {
      probeUserId: this.config.probeUserId,
      gatewayBaseUrl: this.config.gatewayBaseUrl,
    })
    this.block(verdict.reason, verdict.detail)
  }

  /** 最近一轮里出现过的探测侧错误码（从库里读最近样本，不额外记内存）。 */
  private lastErrorCodes(): Set<string> {
    const codes = new Set<string>()
    for (const model of this.storeOf().probedModels()) {
      const latest = this.storeOf().recent(model, 1)[0]
      if (latest === undefined) continue
      if (latest.status !== 'probe-error') continue
      if (latest.errorCode !== null) codes.add(latest.errorCode)
    }
    return codes
  }

  /** 每轮顺手清理超期明细（一天最多做一次，别每轮都 DELETE）。 */
  private pruneIfDue(): void {
    const now = Date.now()
    const last = this.lastPrunedAt === null ? 0 : Date.parse(this.lastPrunedAt)
    if (Number.isFinite(last) && now - last < 24 * 3600 * 1000) return
    try {
      const removed = this.storeOf().prune(now - this.config.retentionDays * 24 * 3600 * 1000)
      this.lastPrunedAt = new Date(now).toISOString()
      if (removed > 0) {
        this.logger.info(
          `已清理 ${String(removed)} 条超期探测明细（保留 ${String(this.config.retentionDays)} 天）`,
        )
      }
    } catch (error) {
      this.logger.warn(`清理超期探测明细失败：${describeError(error)}`)
    }
  }

  /** 这一轮要探哪些模型：读目录 → 挑有账号声明的（见 `targets.ts`）。 */
  private resolveTargets() {
    const modelhub = modelHubSeam(this.ctx)
    if (modelhub === undefined) return { models: [], emptyCatalog: false }
    try {
      return pickTargets(modelhub.catalog({}), this.config.probeModels)
    } catch (error) {
      this.logger.warn(`读取模型目录失败：${describeError(error)}`)
      return { models: [], emptyCatalog: false }
    }
  }

  private async ensureKey(): Promise<void> {
    const apiKey = apiKeySeam(this.ctx)
    const credentials = credentialsSeam(this.ctx)
    if (apiKey === undefined) {
      throw new ModelProbeError('MODEL_PROBE_DEPENDENCY_UNAVAILABLE', 'apiKey 服务不可用，无法创建探测 key')
    }
    if (credentials === undefined) {
      throw new ModelProbeError(
        'MODEL_PROBE_DEPENDENCY_UNAVAILABLE',
        'credentials 服务不可用，无法保存探测 key 的明文',
      )
    }
    const state = await ensureProbeKey({
      apiKey,
      credentials,
      userId: this.config.probeUserId,
      ref: this.config.probeKeyRef,
      rememberKeyId: (keyId) => {
        this.probeKeyId = keyId
        this.storeOf().setMeta('probeKeyId', keyId)
      },
      recallKeyId: () => this.probeKeyId ?? undefined,
      log: (message) => this.logger.info(message),
    })
    this.probeKeyId = state.keyId
    this.probeKeyName = state.keyName
  }

  private block(reason: ModelProbeBlockedReason, detail: string): void {
    if (this.blockedReason !== reason) this.logger.warn(`探测停摆（${reason}）：${detail}`)
    this.blockedReason = reason
    this.blockedDetail = detail
  }

  /** 卸载 / 关闭连接。幂等：关两次不报错。 */
  private close(): void {
    this.disposed = true
    try {
      this.store?.close()
    } catch {
      // 关已关的连接不需要报错。
    }
    this.store = undefined
    this.db = undefined
  }

  private assertReady(): void {
    if (!this.ready) throw new ModelProbeError('MODEL_PROBE_NOT_READY', '模型探测插件尚未装载完成')
    if (this.disposed) throw new ModelProbeError('MODEL_PROBE_NOT_READY', '模型探测插件已卸载')
  }

  /**
   * 探测库访问器。`store` 是可选字段（装载前 / 卸载后都是 undefined），
   * 直接点它会散出十几处非空断言；集中在这里，未装载时拿到明确错误码
   * 而不是 `undefined is not a function`。
   */
  private storeOf(): ModelProbeStore {
    if (this.store === undefined) {
      throw new ModelProbeError('MODEL_PROBE_NOT_READY', '模型探测插件尚未装载完成，此刻不能读写探测库')
    }
    return this.store
  }
}

export { MODEL_PROBE_DEFAULTS, PROBE_KEY_NAME, PROBE_KEY_NAME_PREFIX, HEALTH_WINDOW_MIN }
export type { ModelProbeConfig, ResolvedModelProbeConfig }
