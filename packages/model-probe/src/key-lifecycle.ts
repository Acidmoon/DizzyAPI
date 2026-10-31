/**
 * 探测 key 的生命周期：**建 / 轮换 / 补建**，以及围绕它的两把保险。
 *
 * 为什么单独成文件：
 * 1. `service.ts` 是编排，已经贴着 §5.6 的 500 行硬上限；
 * 2. 这块是**安全面**（秘密只在创建 / 轮换那一刻出现，随后只持引用名），集中在一处好审。
 *
 * ## 保险一：单飞（防建出两把 key）
 *
 * `ensure()` 有两个调用点 —— `[Service.init]` 和每轮探测的自愈补建 —— 而 `ready` 在 init
 * 的 `await` 之前就置真了，外部 `runOnce()` 能插进来形成并发。`ensureProbeKey` 自己是
 * 「先 list 再 create」，并发下两边都会看到「没有」→ 建出两把同名 `__probe__dizzy`，
 * `credentials` 里只留得下最后一把明文，另一把成了永远用不上的垃圾。
 * 所以要串行化的是**整段**「查重 + 建 / 轮换」，不是其中的单个方法。
 *
 * ## 保险二：失败可重试（2026-10-31 生产事故）
 *
 * 原来只在 `[Service.init]` 里建一次 key，失败就 `block()` 记下停摆原因，**之后再也不会重试**
 * —— 而 cordis **不保证**装载顺序跟 `app.yml` 一致（生产日志：`model-probe` 先 apply、
 * `api-key` 后 apply），一次瞬时的启动竞态就把插件永久卡死了，必须重启才恢复。
 *
 * 现在三条路都能补：`init` 失败后 1 秒一次性补建（`scheduleRetry`）、每轮探测前解析不到
 * 明文就先补建一次（`resolveToken`）、以及单飞保证并发安全。**失败一律不静默**：
 * 调用方照旧把停摆原因挂到 `status()` 上。
 */
import type { Context, Logger } from 'cordis'
import { describeError } from '@dizzyapi/plugin-kit'
import { ensureProbeKey } from './probe-key.ts'
import { apiKeySeam, credentialsSeam } from './seams.ts'
import { createSingleFlight, type SingleFlight } from './single-flight.ts'
import type { ModelProbeBlockedReason } from './types.ts'

/** 一次性补建的延迟（毫秒）：竞态通常几百毫秒内消失，1 秒足够，再长就是白停摆一轮。 */
export const PROBE_KEY_RETRY_MS = 1_000

/** 拿到的 key 身份（**不含明文**）。 */
export interface ProbeKeyIdentity {
  readonly keyId: string
  readonly keyName: string
}

export interface ProbeKeyKeeperDeps {
  readonly ctx: Context
  /** 探测 key 的归属用户（**花谁的钱**）。 */
  readonly userId: number
  /** `credentials` 里的引用名。 */
  readonly ref: string
  readonly logger: Logger
  /** 把 keyId 记进 `model_probe_meta`（避免每次去 list 一遍）。 */
  readonly rememberKeyId: (keyId: string) => void
  readonly recallKeyId: () => string | undefined
  /** 把最新的 key 身份写回服务状态（`status()` 要用）。 */
  readonly remember: (identity: ProbeKeyIdentity) => void
  /** 插件是否已卸载（卸载后不再补建 / 不再改状态）。 */
  readonly isDisposed: () => boolean
  readonly blockedReason: () => ModelProbeBlockedReason | null
  /** 清掉某条停摆原因（只在「原因确实被解决了」时调）。 */
  readonly clearBlock: (reason: ModelProbeBlockedReason) => void
}

export class ProbeKeyKeeper {
  private readonly flight: SingleFlight = createSingleFlight()

  constructor(private readonly deps: ProbeKeyKeeperDeps) {}

  /**
   * 建 / 轮换探测 key 并把明文写进 `credentials`。失败直接抛（由调用方决定记什么停摆原因）。
   *
   * **这里是唯一入口，而且自己过单飞闸门**：`init`、启动补建、每轮探测的自愈补建都走它，
   * 三条路径共享同一个在飞任务，绝不各建一把。
   */
  ensureLocked(): Promise<void> {
    return this.flight.run(() => this.doEnsure())
  }

  /**
   * 取探测明文：解析不到就**先补建一次**再解析。
   *
   * 这是自愈的主路径：`api-key` / `credentials` 迟到时，这里会把 key 建出来，
   * 而不是一路 `probe_key_secret_missing` 停摆到重启。
   */
  async resolveToken(): Promise<string | undefined> {
    const first = credentialsSeam(this.deps.ctx)?.resolve(this.deps.ref)
    if (first !== undefined && first !== '') return first
    try {
      await this.ensureLocked()
    } catch (error) {
      // 不静默：调用方会按「明文还是没有」记停摆原因，日志留一条线索。
      this.deps.logger.warn(`探测 key 仍不可用，本轮跳过：${describeError(error)}`)
      return undefined
    }
    if (this.deps.isDisposed()) return undefined
    return credentialsSeam(this.deps.ctx)?.resolve(this.deps.ref)
  }

  /**
   * 启动竞态下的**一次性**补建（`init` 那次失败后调）。
   *
   * 成功且停摆原因正是「明文不在 credentials 里」时清掉它（现在在了）；
   * 其余原因一律不动 —— 那些不是建 key 能解决的。
   */
  scheduleRetry(): void {
    this.deps.ctx.effect(
      () =>
        this.deps.ctx.setTimeout(() => {
          if (this.deps.isDisposed() || this.deps.blockedReason() !== 'probe_key_secret_missing') return
          void this.ensureLocked()
            .then(() => {
              if (this.deps.blockedReason() !== 'probe_key_secret_missing') return
              this.deps.logger.info('探测 key 已补建成功，等待下一轮探测取数')
              this.deps.clearBlock('probe_key_secret_missing')
            })
            .catch((error: unknown) => {
              this.deps.logger.warn(`补建探测 key 仍失败，等下一轮探测再试：${describeError(error)}`)
            })
        }, PROBE_KEY_RETRY_MS),
      'modelProbe.keyRetry',
    )
  }

  /**
   * 真正的建 / 轮换动作（**不过闸门**，只由 `ensureLocked` 调用）。
   *
   * 拆成两个方法而不是一个：如果把「过闸门」写在同一个函数里，`ensureLocked` 会
   * 在闸门内部再调一次闸门 —— 而单飞对已在飞的任务返回的是**它自己的 Promise**，
   * 于是自己等自己，直接死锁。
   */
  private async doEnsure(): Promise<void> {
    const apiKey = apiKeySeam(this.deps.ctx)
    if (apiKey === undefined) {
      throw new ModelProbeKeyError('apiKey 服务不可用，无法创建探测 key')
    }
    const credentials = credentialsSeam(this.deps.ctx)
    if (credentials === undefined) {
      throw new ModelProbeKeyError('credentials 服务不可用，无法保存探测 key 的明文')
    }
    const state = await ensureProbeKey({
      apiKey,
      credentials,
      userId: this.deps.userId,
      ref: this.deps.ref,
      rememberKeyId: this.deps.rememberKeyId,
      recallKeyId: this.deps.recallKeyId,
      log: (message) => this.deps.logger.info(message),
    })
    this.deps.remember(state)
  }
}

/**
 * 建 key 失败的原因。
 *
 * 这里**不抛 `ModelProbeError`**：那个类型带着插件对外的稳定码，而这几条错误在服务层
 * 一律被折成 `probe_key_secret_missing` 这一条停摆原因（页面要看到的就是它）。
 * 用独立的小类型避免「内部错误码」与「对外错误码」两套语义混在一起。
 */
export class ModelProbeKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelProbeKeyError'
  }
}
