/**
 * 假 `fetch`：记录每一次调用，按队列回放响应。
 *
 * 为什么不启真 HTTP 服务器：客户端层要断言的是**发出去的东西**
 * （方法 / 路径 / 查询串 / 请求头 / body / credentials / redirect），
 * 假 fetch 能逐字抓住这些，而且**不占端口**——AGENTS.md §5.4 记着多 worktree
 * 并行跑测试会抢端口、把真进程用例弄成假失败，这里刻意绕开那个坑。
 *
 * 响应一律用真的 `Response`（Node 自带），这样 JSON / 状态码 / 响应头的解析
 * 走的还是生产代码那条路。
 */

/** 一次被记录的调用。 */
export interface RecordedCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | undefined
  readonly credentials: RequestInit['credentials']
  readonly redirect: RequestInit['redirect']
}

/** 一条待回放的响应。 */
export interface ResponseSpec {
  readonly status?: number
  /** JSON 响应体（会被 `JSON.stringify`）。 */
  readonly json?: unknown
  /** 原始文本（优先于 `json`）。 */
  readonly text?: string
  readonly headers?: Readonly<Record<string, string>>
  /** 不返回响应，而是让 `signal` 中止（模拟超时）。 */
  readonly abort?: boolean
}

/** 假 fetch 连同它的记录。 */
export interface FakeFetch {
  readonly fetch: typeof fetch
  readonly calls: RecordedCall[]
  /** 最后一次调用的记录（没有调用过就抛）。 */
  last(): RecordedCall
  /** 第一次调用的记录（没有调用过就抛）。 */
  first(): RecordedCall
  /** 还剩多少条没回放。 */
  remaining(): number
}

function headersOf(init: RequestInit): Record<string, string> {
  const result: Record<string, string> = {}
  const raw = init.headers
  if (raw === undefined) return result
  const pairs: [string, string][] = Array.isArray(raw)
    ? raw.map(([key, value]) => [key, value])
    : raw instanceof Headers
      ? [...raw.entries()]
      : Object.entries(raw as Record<string, string>)
  for (const [key, value] of pairs) result[key.toLowerCase()] = value
  return result
}

/** 造一个假 fetch；`specs` 用完后一律回 `200 {}`。 */
export function fakeFetch(...specs: ResponseSpec[]): FakeFetch {
  const queue = [...specs]
  const calls: RecordedCall[] = []

  const impl = (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: headersOf(init),
      body: typeof init.body === 'string' ? init.body : undefined,
      credentials: init.credentials,
      redirect: init.redirect,
    })
    const spec = queue.shift() ?? { status: 200, json: {} }
    if (spec.abort === true) {
      return new Promise<Response>((_resolve, reject) => {
        const fail = (): void => {
          const error = new Error('aborted')
          error.name = 'AbortError'
          reject(error)
        }
        const signal = init.signal ?? undefined
        if (signal === undefined || signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      })
    }
    const status = spec.status ?? 200
    const body = spec.text ?? (spec.json === undefined ? null : JSON.stringify(spec.json))
    return Promise.resolve(
      new Response(body, {
        status,
        ...(spec.headers === undefined ? {} : { headers: spec.headers as Record<string, string> }),
      }),
    )
  }

  const calls0 = calls
  return {
    fetch: impl as typeof fetch,
    calls: calls0,
    last(): RecordedCall {
      const call = calls0[calls0.length - 1]
      if (call === undefined) throw new Error('还没有发出任何请求')
      return call
    },
    first(): RecordedCall {
      const call = calls0[0]
      if (call === undefined) throw new Error('还没有发出任何请求')
      return call
    },
    remaining(): number {
      return queue.length
    },
  }
}

/** 断言调用里带了 `/api/*` 必须的跨站请求头。 */
export function requestHeaderOf(call: RecordedCall): string | undefined {
  return call.headers['x-requested-with']
}
