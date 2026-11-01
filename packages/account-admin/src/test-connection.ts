/**
 * 连通性测试：发一个**真实的最小请求**，而不是只查模型列表。
 *
 * 参考 new-api 的渠道测试（`GET /api/channel/test/:id`）：它同样发最小可用请求
 * （`max_tokens` 16、`messages:[{role:'user',content:'hi'}]`），因为「模型列表能取」
 * 不代表「这个 key 能推理」。这里只读设计，不复制实现。
 *
 * 秘密边界：access token 只在本文件的请求头里出现；返回结果与错误文本必须脱敏，
 * 不能带 token、URL-encoded token、`Bearer <token>`，也不能把完整 URL（尤其 query）
 * 拼进错误信息。本文件是纯函数：不落盘、不写日志。
 */
import { AccountAdminError } from './errors.ts'
import { applyAccountMask, type AccountMask } from './client-mask-apply.ts'
import { firstLine, networkErrorText, truncate } from './test-error-text.ts'
import { endpointOf, redactToken as redact, snippetOf } from './test-snippet.ts'
import type {
  AccountProtocol,
  AccountProvider,
  AccountTestInput,
  AccountTestRequest,
  AccountTestResult,
} from './types.ts'

/**
 * 探针提示词：**请求体里发的是它，测试详情里展示的也是它**（只此一份，
 * 不允许前端硬编一个、请求里再发另一个）。
 */
const PROBE_PROMPT = 'hi'

/** 账号里与测试相关的只读字段（不 import identity 的实现）。 */
export interface ConnectionTestTarget {
  readonly provider: AccountProvider
  readonly baseUrl: string | null
  readonly protocol: AccountProtocol | null
  readonly models: readonly string[] | null
}

export interface ConnectionTestDeps {
  readonly fetch: typeof fetch
  /** 当前时间（毫秒）；测试可注入固定时钟。 */
  readonly now?: () => number
  /** 超时；默认 15s。 */
  readonly timeoutMs?: number
  /** 被测账号的 id：`{{session}}` 要按「账号 + 首条用户消息」算，与 Go 同口径。 */
  readonly accountId?: string
  /** 账号挂的客户端指纹档案（解析后的那一小段）；缺席 = 照旧发裸请求。 */
  readonly mask?: AccountMask
}

const DEFAULT_TIMEOUT_MS = 15_000
const BODY_LIMIT = 8 * 1024
const MODEL_NAME_LIMIT = 200

const PROVIDER_DEFAULT_BASE_URL: Readonly<Record<AccountProvider, string | null>> = {
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com/v1',
  custom: null,
}

const PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
])

/** 参数 → 账号声明 → provider 推断。 */
export function resolveTestProtocol(
  target: Pick<ConnectionTestTarget, 'provider' | 'protocol'>,
  requested: unknown,
): AccountProtocol {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string' || !PROTOCOLS.has(requested)) {
      throw new AccountAdminError(
        'ACCOUNT_TEST_PROTOCOL_INVALID',
        'protocol 只能是 openai-chat / openai-responses / anthropic / gemini',
      )
    }
    return requested as AccountProtocol
  }
  if (target.protocol !== null) {
    if (!PROTOCOLS.has(target.protocol)) {
      throw new AccountAdminError(
        'ACCOUNT_TEST_PROTOCOL_INVALID',
        '账号声明的 protocol 不合法（只能是 openai-chat / openai-responses / anthropic / gemini）',
      )
    }
    return target.protocol
  }
  if (target.provider === 'claude') return 'anthropic'
  return 'openai-chat'
}

/** 参数 → 账号 `models[0]`；都没有时返回 null（改走 GET /models）。 */
export function resolveTestModel(
  target: Pick<ConnectionTestTarget, 'models'>,
  requested: unknown,
): string | null {
  if (requested !== undefined && requested !== null) {
    if (typeof requested !== 'string') {
      throw new AccountAdminError('ACCOUNT_TEST_MODEL_INVALID', 'model 必须是字符串')
    }
    const model = requested.trim()
    if (model === '') return null
    if (model.length > MODEL_NAME_LIMIT) {
      throw new AccountAdminError('ACCOUNT_TEST_MODEL_INVALID', `model 最长 ${MODEL_NAME_LIMIT} 个字符`)
    }
    return model
  }
  const first = target.models?.[0]
  if (typeof first !== 'string') return null
  const model = first.trim()
  return model === '' ? null : model
}

export function resolveTestBaseUrl(target: Pick<ConnectionTestTarget, 'provider' | 'baseUrl'>): string {
  const explicit = target.baseUrl?.trim()
  const base = explicit === undefined || explicit === '' ? PROVIDER_DEFAULT_BASE_URL[target.provider] : explicit
  if (base === null || base === undefined || base === '') {
    throw new AccountAdminError(
      'ACCOUNT_TEST_BASE_URL_MISSING',
      'custom 账号没有 baseUrl，无法测试连通性；请先填写上游地址',
    )
  }
  return base.replace(/\/+$/, '')
}

interface PlannedRequest {
  readonly method: 'GET' | 'POST'
  readonly url: string
  readonly headers: Record<string, string>
  readonly body?: string
}

function planRequest(
  target: ConnectionTestTarget,
  token: string,
  protocol: AccountProtocol,
  model: string | null,
): PlannedRequest {
  const base = resolveTestBaseUrl(target)
  const headers: Record<string, string> = { accept: 'application/json' }
  if (protocol === 'anthropic') {
    headers['x-api-key'] = token
    headers['anthropic-version'] = '2023-06-01'
  } else if (protocol === 'gemini') {
    // Gemini 用 x-goog-api-key，不要同时带 Authorization。
    headers['x-goog-api-key'] = token
  } else {
    headers.authorization = `Bearer ${token}`
  }

  if (model === null) {
    return { method: 'GET', url: `${base}/models`, headers }
  }

  headers['content-type'] = 'application/json'
  if (protocol === 'openai-chat') {
    return {
      method: 'POST',
      url: `${base}/chat/completions`,
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROBE_PROMPT }],
        max_tokens: 16,
        stream: false,
      }),
    }
  }
  if (protocol === 'openai-responses') {
    return {
      method: 'POST',
      url: `${base}/responses`,
      headers,
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content: PROBE_PROMPT }],
        max_output_tokens: 16,
        stream: false,
      }),
    }
  }
  if (protocol === 'gemini') {
    // Gemini：模型名在路径里，密钥走 x-goog-api-key 头。
    return {
      method: 'POST',
      url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: PROBE_PROMPT }] }],
        generationConfig: { maxOutputTokens: 16 },
      }),
    }
  }
  return {
    method: 'POST',
    url: `${base}/messages`,
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
    }),
  }
}

/**
 * 执行一次测试。网络层失败也会返回结果对象（`ok: false`），只有配置本身不完整
 * （例如 custom 没有 baseUrl、protocol 非法）才会抛 `AccountAdminError`。
 */
export async function runConnectionTest(
  target: ConnectionTestTarget,
  token: string,
  input: AccountTestInput = {},
  deps: ConnectionTestDeps,
): Promise<AccountTestResult> {
  const protocol = resolveTestProtocol(target, input.protocol)
  const model = resolveTestModel(target, input.model)
  const plan = planRequest(target, token, protocol, model)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const startedAt = now()

  // 详情块：真的发出去的东西（提示词取自计划里的正文，端点去掉 query）。
  // **不含任何请求头** —— 鉴权头根本没有出口。
  const requestInfo: AccountTestRequest = {
    prompt: plan.body === undefined ? null : PROBE_PROMPT,
    model,
    protocol,
    endpoint: endpointOf(plan.url),
  }

  // 档案头贴在**网关自己的头之后**，受保护头由 applyAccountMask 跳过（与 Go 一致）。
  const headers: Record<string, string> = { ...plan.headers }
  if (deps.mask !== undefined) {
    applyAccountMask(headers, deps.mask, { accountId: deps.accountId ?? '', body: plan.body })
  }

  let response: Response
  let text: string
  try {
    response = await deps.fetch(plan.url, {
      method: plan.method,
      headers,
      ...(plan.body === undefined ? {} : { body: plan.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = (await response.text()).slice(0, BODY_LIMIT)
  } catch (error) {
    // 没拿到 HTTP 响应：`response` 块为 null（「未拿到响应」与「HTTP 500」必须能分开读）。
    return {
      ok: false,
      status: null,
      latencyMs: elapsed(now, startedAt),
      model,
      protocol,
      error: redact(networkErrorText(error, timeoutMs), token),
      testedAt: new Date(now()).toISOString(),
      request: requestInfo,
      response: null,
    }
  }

  const latencyMs = elapsed(now, startedAt)
  const testedAt = new Date(now()).toISOString()
  const parsed = parseJson(text)
  // 响应片段：截断 + 打码。非 2xx 时这里就是**上游的错误正文**，正是 owner 要看的那个。
  const responseInfo = { status: response.status, ...snippetOf(text, token) }

  if (response.status < 200 || response.status >= 300) {
    const detail = parsed.ok ? errorDetail(parsed.value) : firstLine(text)
    return {
      ok: false,
      status: response.status,
      latencyMs,
      model,
      protocol,
      error: redact(`HTTP ${response.status}${detail === undefined ? '' : `：${truncate(detail)}`}`, token),
      testedAt,
      request: requestInfo,
      response: responseInfo,
    }
  }

  if (!parsed.ok) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      model,
      protocol,
      error: redact(`响应不是 JSON${text.trim() === '' ? '（响应体为空）' : ''}`, token),
      testedAt,
      request: requestInfo,
      response: responseInfo,
    }
  }

  const payloadError = topLevelErrorDetail(parsed.value)
  if (payloadError !== undefined) {
    return {
      ok: false,
      status: response.status,
      latencyMs,
      model,
      protocol,
      error: redact(`上游返回错误：${truncate(payloadError)}`, token),
      testedAt,
      request: requestInfo,
      response: responseInfo,
    }
  }

  return {
    ok: true,
    status: response.status,
    latencyMs,
    model,
    protocol,
    error: null,
    testedAt,
    request: requestInfo,
    response: responseInfo,
  }
}

function elapsed(now: () => number, startedAt: number): number {
  return Math.max(0, Math.round(now() - startedAt))
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 成功响应里的错误载荷：只认顶层 `error` 字段（`error: null` 不算错误）。 */
function topLevelErrorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.error === undefined || value.error === null) return undefined
  if (typeof value.error === 'string' && value.error.trim() !== '') return value.error.trim()
  if (isRecord(value.error)) {
    for (const key of ['message', 'detail', 'type']) {
      const candidate = value.error[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
    }
    return '上游返回了无法识别的 error 载荷'
  }
  return '上游返回了无法识别的 error 载荷'
}

/** 非 2xx 响应的可读 detail：优先 JSON 的错误字段，其次第一行文本。 */
function errorDetail(value: unknown): string | undefined {
  if (!isRecord(value)) return typeof value === 'string' ? value : undefined
  if (value.error !== undefined && value.error !== null) {
    if (typeof value.error === 'string' && value.error.trim() !== '') return value.error.trim()
    if (isRecord(value.error)) {
      for (const key of ['message', 'detail', 'type']) {
        const candidate = value.error[key]
        if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
      }
    }
  }
  for (const key of ['message', 'detail', 'error_description']) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/** token、URL-encoded token、`Bearer <token>` → 打码。实现见 `test-snippet.ts`（与响应片段共用一套，不重复）。 */
export { redactToken as redact } from './test-snippet.ts'
