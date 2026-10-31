/**
 * 发一次探测请求并把它分类成 `ok` / `degraded` / `failed` / `probe-error`。
 *
 * 走真网关（`/v1/chat/completions` + 真探测 key），所以它测的正是**用户真实请求那条链路**：
 * key-auth → 额度闸门 → 定价闸门 → modelroute（按模型过滤账号）→ protoconv → 上游 → 用量落库。
 *
 * ## 分类是整个功能的地基
 *
 * - `ok`：2xx 且耗时 ≤ `degradedThresholdMs`。
 * - `degraded`：2xx 但慢。
 * - `probe-error`：**探测自己出问题**，模型可能完全健康。
 *   - 402 `INSUFFICIENT_BALANCE`（探测用户没钱）
 *   - 401 `API_KEY_EXPIRED` / `API_KEY_SPENDING_LIMIT` / key 无效
 *   - 403 `MODEL_NOT_PRICED` / `PRICING_SNAPSHOT_UNAVAILABLE` / `QUOTA_SNAPSHOT_UNAVAILABLE`
 *   - 连不上网关（ECONNREFUSED）或探测请求本身超时
 * - `failed`：**模型真的不可用**。503 `MODEL_NOT_SERVED`、5xx、上游错误、429 等。
 *
 * 分错的代价：把「探测账户没钱」记成 `failed`，全站模型一起变红，
 * 而模型其实一个都没挂 —— 假红比不监测更糟（总工定死的硬要求）。
 */
import type { ModelProbeSample, ModelProbeStatus } from './types.ts'

/** 网关认为「这是个探测自身的配置 / 额度问题」的稳定错误码。 */
const PROBE_SIDE_ERROR_CODES: ReadonlySet<string> = new Set([
  // 额度闸门（Go `modules/quotagate`）
  'INSUFFICIENT_BALANCE',
  'QUOTA_SNAPSHOT_UNAVAILABLE',
  // 定价闸门（Go `modules/pricinggate` / `internal/quota`）
  'MODEL_NOT_PRICED',
  'PRICING_SNAPSHOT_UNAVAILABLE',
  // key 闸门（Go `modules/keygate`）
  'API_KEY_EXPIRED',
  'API_KEY_INVALID',
  'API_KEY_SPENDING_LIMIT',
  'API_KEY_CONCURRENCY_LIMIT',
  'USER_CONCURRENCY_LIMIT',
  // 内容审核闸门快照缺失（也是网关侧配置问题，不是模型问题）
  'CONTENT_AUDIT_SNAPSHOT_UNAVAILABLE',
])

/** 探测请求的形状；`max_tokens` 压到最小，成本按一条最短请求算。 */
export interface ProbeRequestTarget {
  readonly model: string
}

export interface ProbeDeps {
  readonly fetch: typeof fetch
  readonly now: () => number
  /** 网关入口，已去掉末尾斜杠。 */
  readonly gatewayBaseUrl: string
  readonly timeoutMs: number
  readonly degradedThresholdMs: number
}

/**
 * 发一次探测。**永不抛**：所有失败都变成结果对象里的状态。
 * 只有「探测 key 的明文不存在」这种前置条件错误才由调用方在更外层处理。
 */
export async function runProbe(
  target: ProbeRequestTarget,
  token: string,
  deps: ProbeDeps,
): Promise<ModelProbeSample> {
  const startedAt = deps.now()
  const url = `${deps.gatewayBaseUrl}/v1/chat/completions`
  const body = JSON.stringify({
    model: target.model,
    messages: [{ role: 'user', content: 'ping' }],
    max_tokens: 1,
    stream: false,
  })

  let response: Response
  let text: string
  try {
    response = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
    // 探测不解析响应体：只留稳定原因码。这里截断只是为解析错误码，**绝不落库**。
    text = await response.text()
  } catch (error) {
    const latencyMs = elapsed(deps.now, startedAt)
    const timedOut = isTimeout(error)
    return {
      model: target.model,
      // 连不上网关 / 探测请求超时 = 探测自身的问题，不是模型挂了。
      status: 'probe-error',
      latencyMs,
      httpStatus: null,
      errorCode: timedOut ? 'probe_timeout' : 'gateway_unreachable',
      testedAtMs: deps.now(),
    }
  }

  const latencyMs = elapsed(deps.now, startedAt)
  const testedAtMs = deps.now()
  const code = extractErrorCode(text)

  if (response.status >= 200 && response.status < 300) {
    // 2xx 但响应体里有顶层 error（少见，但上游代理会这么回）→ 模型侧问题。
    if (code !== null) {
      return { model: target.model, status: 'failed', latencyMs, httpStatus: response.status, errorCode: code, testedAtMs }
    }
    const status: ModelProbeStatus = latencyMs > deps.degradedThresholdMs ? 'degraded' : 'ok'
    return { model: target.model, status, latencyMs, httpStatus: response.status, errorCode: null, testedAtMs }
  }

  // 非 2xx：先看错误码是不是「探测自身的问题」。
  if (code !== null && PROBE_SIDE_ERROR_CODES.has(code)) {
    return { model: target.model, status: 'probe-error', latencyMs, httpStatus: response.status, errorCode: code, testedAtMs }
  }
  // 402 / 401 / 403 即使没解析出 code，也基本只能是探测侧问题（真模型挂了不会 401）。
  if (response.status === 401 || response.status === 402) {
    return {
      model: target.model,
      status: 'probe-error',
      latencyMs,
      httpStatus: response.status,
      errorCode: code ?? `http_${response.status}`,
      testedAtMs,
    }
  }
  return {
    model: target.model,
    status: 'failed',
    latencyMs,
    httpStatus: response.status,
    errorCode: code ?? `http_${response.status}`,
    testedAtMs,
  }
}

/**
 * 从错误体里取稳定 code。三种协议形状都认（见 `contracts/protocol.go`）：
 * - OpenAI：`{ error: { code } }`
 * - Anthropic：`{ type: "error", error: { code } }`
 * - Gemini：`{ error: { reason } }`
 *
 * 只取**短字符串**，长文本一律丢弃 —— 那可能是上游返回的正文，不该进库。
 */
export function extractErrorCode(raw: string): string | null {
  const text = raw.trim()
  if (text === '' || text.length > 64 * 1024) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const root = parsed as Record<string, unknown>
  // 2xx 响应里也有顶层 error 的情况。
  const error = root.error
  if (typeof error === 'object' && error !== null) {
    const detail = error as Record<string, unknown>
    for (const key of ['code', 'reason'] as const) {
      const candidate = detail[key]
      if (isShortCode(candidate)) return candidate
    }
  }
  const top = root.code
  if (isShortCode(top)) return top
  return null
}

function isShortCode(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function isTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt))
}
