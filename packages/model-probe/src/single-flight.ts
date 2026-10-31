/**
 * 进程内**单飞**：同一时刻只允许一个任务在跑，后来的调用共享同一个 Promise。
 *
 * 为什么需要它（2026-10-31 生产事故）：
 *
 * `model-probe` 的 `ensureKey()` 会 `apiKey.create(...)` 建一把探测 key。
 * 它在两个地方被调用：`[Service.init]` 和每一轮探测（自愈补建）。cordis 的
 * 装载顺序不保证「`api-key` 先于 `model-probe` 到 ACTIVE」，而 `ready = true` 又是在
 * `init` 里 `await ensureKey()` **之前**设的 —— 于是外部 `runOnce()` 完全可能在
 * init 那次 `ensureKey` 还挂着的时候进来，形成**两条并发的建 key 路径**。
 *
 * `ensureProbeKey` 自己按名字查重是幂等的（先 `list` 再决定建不建），但**并发下两边
 * 都会先看到「没有」**，然后各建一把 —— 于是同一个账号下出现两把 `__probe__dizzy`，
 * `credentials` 里只留得下最后一把的明文，另一把成了永远用不上的垃圾 key。
 *
 * 所以锁必须加在**调用点**：把「查重 + 建 / 轮换」整段串行化，而不是在里面逐个方法加锁。
 *
 * 归还语义：任务结束后立刻释放，**失败也释放** —— 否则一次失败会把补建能力永久锁死，
 * 那和这次事故的根因（`init` 里失败一次就再也不重试）是同一个病。
 */

export interface SingleFlight {
  /** 跑一个任务；已有任务在跑时直接共享它（**不**另起一个）。 */
  run<T>(task: () => Promise<T>): Promise<T>
  /** 眼下有没有任务在跑（只读，排障 / 用例用）。 */
  readonly running: boolean
}

export function createSingleFlight(): SingleFlight {
  let current: Promise<unknown> | undefined

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      if (current !== undefined) return current as Promise<T>
      // `finally` 里清空：成功与失败都要释放，下一位调用者才有机会重试。
      const started = task().finally(() => {
        if (current === started) current = undefined
      })
      current = started
      return started
    },
    get running(): boolean {
      return current !== undefined
    },
  }
}
