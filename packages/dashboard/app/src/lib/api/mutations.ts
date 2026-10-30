/**
 * 写操作的统一语义。
 *
 * SSR 那套「表单 POST + 303 整页刷新」（PRG）在 SPA 里不适用：SPA 不刷新页面，
 * 所以每个写操作必须自己回答三个问题——
 *
 * 1. **失败怎么办**：回滚到写之前的状态，还是重新拉一次？
 * 2. **连点怎么办**：同一条记录能不能并发写？要不要按 key 串行化？
 * 3. **用户看到什么**：失败提示由谁弹、弹在哪。
 *
 * 这里给三种**明确的策略**，而不是让每个页面各写一遍（那必然漂移）：
 *
 * - `rollback`：本地先改、失败改回去（适合「改个名字 / 开关」这种小而确定的操作）；
 * - `refetch`：失败后重新拉一次（适合服务端算出来的数据，比如余额、结算状态）；
 * - `manual`：不自动处理，调用方自己决定（适合不可逆或有确认流程的操作，比如删除）。
 *
 * **并发写**：同一个 `key` 的写操作**串行执行**（后一个等前一个），
 * 不同 key 之间互不阻塞。这样「连点两下保存」不会发出两条互相覆盖的请求。
 *
 * **失败提示**：本模块**不弹任何 UI**——它只把结构化错误交回去。
 * 弹提示是应用层的事（我们用 shadcn 的 `sonner`），这样客户端层没有 UI 依赖，
 * 也能在测试里断言「失败时回调被调用、状态被回滚」。
 */
import { ApiError } from './client.ts'

/** 写操作的策略。 */
export type MutationStrategy = 'rollback' | 'refetch' | 'manual'

/** 一次写操作的上下文。 */
export interface MutationOptions<T> {
  /** 并发串行化的 key（例如 `user:7`）。相同 key 的写排队，不同 key 并行。 */
  readonly key: string
  /** 策略（见 `MutationStrategy`）。 */
  readonly strategy: MutationStrategy
  /** 写之前先做（通常是「把当前状态存下来」）。 */
  readonly before?: () => void | Promise<void>
  /** 真正的写操作。 */
  readonly run: () => Promise<T>
  /** 失败后的回滚（`strategy: 'rollback'` 时调用）。 */
  readonly rollback?: () => void | Promise<void>
  /** 失败后的重新拉取（`strategy: 'refetch'` 时调用）。 */
  readonly refetch?: () => Promise<void>
  /** 失败回调（应用层在这里弹提示）。 */
  readonly onError?: (error: ApiError) => void
  /** 成功回调。 */
  readonly onSuccess?: (result: T) => void
}

/** 同一个 key 的写操作队列（串行化）。 */
const queues = new Map<string, Promise<unknown>>()

/**
 * 按 key 串行执行一个写操作。
 *
 * 关键点：**前一个失败不能卡住后一个**——所以队列里存的是「一定 settle」的 promise
 * （失败也 resolve），否则一次 500 会让这条 key 后面所有写操作永远排队。
 */
export function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  // 队列项只用来「排队」，不把结果给下一个人；失败也不该让队列中毒。
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, settled)
  void settled.then(() => {
    // 只有当队列尾还是自己时才清掉（避免误删后来者的位置）。
    if (queues.get(key) === settled) queues.delete(key)
  })
  return next
}

/**
 * 执行一次写操作（带并发串行化与失败处理）。
 *
 * 返回**成功时的结果**；失败时抛 `ApiError`（已按策略回滚 / 重拉，
 * 并调用过 `onError`）。
 */
export async function mutate<T>(options: MutationOptions<T>): Promise<T> {
  return enqueue(options.key, async () => {
    if (options.before !== undefined) await options.before()
    try {
      const result = await options.run()
      if (options.onSuccess !== undefined) options.onSuccess(result)
      return result
    } catch (error) {
      const apiError =
        error instanceof ApiError
          ? error
          : new ApiError({
            code: 'API_UNKNOWN_ERROR',
            message: error instanceof Error ? error.message : '操作失败',
            status: 0,
          })
      // 回滚 / 重拉都**不让失败被吞掉**：它们各自出错时保留原始错误。
      // 两者都可能返回 `void`，所以先 `Promise.resolve` 再 `catch`。
      if (options.strategy === 'rollback' && options.rollback !== undefined) {
        await Promise.resolve(options.rollback()).catch(() => undefined)
      }
      if (options.strategy === 'refetch' && options.refetch !== undefined) {
        await Promise.resolve(options.refetch()).catch(() => undefined)
      }
      if (options.onError !== undefined) options.onError(apiError)
      throw apiError
    }
  })
}

/**
 * 提示文案：把 `ApiError` 变成一句给用户看的中文。
 *
 * 服务端的 `message` 已经是人话（`describeError` 那层做的），这里只做兜底：
 * 拿不到 message 时给一句按状态码分的通用文案。
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.message !== '') return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return '操作失败，请稍后再试'
}

/** 401 / 403 的专门文案（前端据此决定要不要跳登录页）。 */
export function authErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return errorMessage(error)
  if (error.isUnauthorized) return '登录已失效，请重新登录'
  if (error.isForbidden) return '当前账号没有这个操作权限'
  if (error.isUnavailable) return '相关服务暂时不可用，请稍后再试'
  return errorMessage(error)
}
