/**
 * 前端 API 客户端的核心传输层。
 *
 * 三个不可省的事，每个都在这里做**一次**、所有端点函数共用：
 *
 * 1. **`X-Requested-With: dizzyapi`**（`/api/*` 每一个请求都要，GET 也要）。
 *    这是服务端挡跨站请求的开关（`packages/api/src/http.ts` 的 `assertApiRequestHeader`）。
 *    漏了就是 403 `API_REQUEST_HEADER_REQUIRED`——**不是**「权限不足」，
 *    排查时很容易误判成登录问题，所以在这里写死，调用方不许自己拼 fetch。
 * 2. **cookie**：`credentials: 'include'`。会话只走 HttpOnly cookie
 *    （`dizzyapi_session`），前端**拿不到也存不了**它——这是秘密纪律。
 * 3. **错误信封**：服务端统一是 `{ error: { code, message, requestId } }`
 *    （`packages/api/src/http_respond.ts` 的 `respondError`）。这里把它解析成
 *    结构化的 `ApiError`，调用方按 `code` 分支，不去猜 HTTP 状态码。
 *
 * 另外三条纪律：
 * - **超时**：默认 15 秒。避免一个卡住的请求把 UI 永远挂在「加载中」。
 * - **重定向**：`redirect: 'manual'`。SPA 里 fetch 跟到 302 会拿到登录页的 HTML，
 *   当 JSON 解析会炸；手动模式下 3xx 直接当错误处理。
 * - **秘密不进 URL**：密码、验证码、完整 API key 一律只走 POST body。
 */
import type { ApiErrorEnvelope } from './types.ts'

/**
 * 请求头名与值。
 *
 * 注意命名：`@dizzyapi/plugin-api` 里的 `API_REQUEST_HEADER` 指的是**值** `'dizzyapi'`
 * （见 `packages/api/src/constants.ts`），所以这里刻意用 `_NAME` / `_VALUE` 后缀，
 * 免得两个包同名不同义——**值必须与服务端一致，否则 403**。
 */
export const API_REQUEST_HEADER_NAME = 'X-Requested-With'
export const API_REQUEST_HEADER_VALUE = 'dizzyapi'

/** 默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 15_000

/** 结构化错误：服务端错误信封的客户端表示。 */
export class ApiError extends Error {
  /** 服务端的稳定错误码（如 `AUTH_RATE_LIMITED`）。 */
  readonly code: string
  /** HTTP 状态码。 */
  readonly status: number
  /** 服务端给的 requestId（报障时把它一起给出来）。 */
  readonly requestId: string | undefined

  constructor(options: {
    readonly code: string
    readonly message: string
    readonly status: number
    readonly requestId?: string
  }) {
    super(options.message)
    this.name = 'ApiError'
    this.code = options.code
    this.status = options.status
    this.requestId = options.requestId
  }

  /** 是「没登录 / 会话过期」吗？前端据此跳登录页。 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }

  /** 是「没权限」吗？（会话有效但不是管理员） */
  get isForbidden(): boolean {
    return this.status === 403
  }

  /** 是「服务端暂时不可用」吗？（插件缺席这类 503） */
  get isUnavailable(): boolean {
    return this.status === 503
  }
}

/** 客户端配置。 */
export interface ApiClientOptions {
  /**
   * API 的基地址。
   *
   * 生产与开发都**同源**（nginx 把 `/api/*` 反代到 7791），所以默认是空串
   * （相对路径）。本地开发若 Next 跑在另一个端口，把这里填成
   * `http://127.0.0.1:7791` —— 但那样是**跨域**，服务端不发 CORS 头，
   * 浏览器会直接拒绝。所以生产必须走同源反代。
   */
  readonly baseUrl?: string
  /** 超时（毫秒）。 */
  readonly timeoutMs?: number
  /** 注入的 fetch 实现（测试用；默认取全局 `fetch`）。 */
  readonly fetchImpl?: typeof fetch
  /**
   * 401 时的回调（跳登录页）。
   *
   * 由应用层注入，**客户端层不自己跳路由**——它不知道前端路由长什么样。
   */
  readonly onUnauthorized?: (error: ApiError) => void
}

/** 单次请求的参数。 */
export interface RequestOptions {
  readonly method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 查询参数；值为 `undefined` / `''` 的会被丢掉（不拼进 URL）。 */
  readonly query?: Readonly<Record<string, string | number | boolean | undefined | null>>
  /** 请求体（会被 JSON 序列化）。 */
  readonly body?: unknown
  /** 覆盖默认超时。 */
  readonly timeoutMs?: number
  /** 覆盖实例级的 fetch 实现。 */
  readonly fetchImpl?: typeof fetch
}

/** 把查询参数拼成 `?a=1&b=2`（空值丢弃，值一律 encodeURIComponent）。 */
export function buildQuery(query: RequestOptions['query']): string {
  if (query === undefined) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

/** 从响应里解析错误信封；不是标准信封就按状态码兜底。 */
async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('X-Request-Id') ?? undefined
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    payload = undefined
  }
  const envelope = payload as Partial<ApiErrorEnvelope> | undefined
  const inner = envelope?.error
  if (inner !== undefined && inner !== null && typeof inner === 'object') {
    const code = typeof inner.code === 'string' && inner.code !== '' ? inner.code : 'API_INTERNAL'
    const message = typeof inner.message === 'string' && inner.message !== '' ? inner.message : '操作失败'
    const id = typeof inner.requestId === 'string' && inner.requestId !== '' ? inner.requestId : requestId
    return new ApiError({ code, message, status: response.status, ...(id === undefined ? {} : { requestId: id }) })
  }
  // 不是错误信封（例如反代返回了 HTML 错误页）：给一句人话 + 原始状态码。
  return new ApiError({
    code: `HTTP_${String(response.status)}`,
    message: `接口返回了 ${String(response.status)}`,
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
  })
}

/** 客户端。持有配置，提供 `request`（返回 JSON）与 `requestVoid`（不读体）。 */
export class ApiClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch | undefined
  private readonly onUnauthorized: ((error: ApiError) => void) | undefined

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.fetchImpl = options.fetchImpl
    this.onUnauthorized = options.onUnauthorized
  }

  /** 完整 URL（基地址 + 路径 + 查询串）。 */
  url(path: string, query?: RequestOptions['query']): string {
    const normalized = path.startsWith('/') ? path : `/${path}`
    return `${this.baseUrl}${normalized}${buildQuery(query)}`
  }

  /** 发一个请求，返回解析后的 JSON。 */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(path, options)
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (text === '') return undefined as T
    try {
      return JSON.parse(text) as T
    } catch {
      // 200 但不是 JSON：多半是反代把某页 HTML 当成接口返回了。
      throw new ApiError({
        code: 'API_RESPONSE_INVALID',
        message: '接口返回的不是 JSON',
        status: response.status,
        ...(response.headers.get('X-Request-Id') === null
          ? {}
          : { requestId: response.headers.get('X-Request-Id') as string }),
      })
    }
  }

  /** 发一个请求，不读响应体（DELETE / POST 之类只关心状态码时用）。 */
  async requestVoid(path: string, options: RequestOptions = {}): Promise<void> {
    await this.raw(path, options)
  }

  /** 只发请求、拿原始响应（导出 CSV 之类要读 blob 时用）。 */
  async raw(path: string, options: RequestOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET'
    const fetchImpl = options.fetchImpl ?? this.fetchImpl ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new ApiError({ code: 'API_NO_FETCH', message: '当前环境没有 fetch', status: 0 })
    }
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    const headers: Record<string, string> = {
      // 这个头是服务端的跨站闸门，**每个**请求都要带（GET 也一样）。
      [API_REQUEST_HEADER_NAME]: API_REQUEST_HEADER_VALUE,
      Accept: 'application/json',
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const response = await fetchImpl(this.url(path, options.query), {
        method,
        headers,
        // 会话只走 HttpOnly cookie；同源下 'include' 才会带上。
        credentials: 'include',
        // 手动处理重定向：SPA 里跟到 302 会拿到 HTML。
        redirect: 'manual',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = await toApiError(response)
        // 401 有专门分支：交给应用层跳登录页。
        if (error.isUnauthorized && this.onUnauthorized !== undefined) {
          this.onUnauthorized(error)
        }
        throw error
      }
      return response
    } catch (error) {
      if (error instanceof ApiError) throw error
      // AbortError = 超时；其余是网络层错误。
      const aborted = error instanceof Error && error.name === 'AbortError'
      throw new ApiError({
        code: aborted ? 'API_TIMEOUT' : 'API_NETWORK_ERROR',
        message: aborted ? '请求超时，请稍后再试' : '网络异常，请检查连接',
        status: 0,
      })
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 默认实例（生产同源：基地址空串）。 */
export const api = new ApiClient()
