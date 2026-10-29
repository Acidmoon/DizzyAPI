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
import type {
  AccountProtocol,
  AccountProvider,
  AccountTestInput,
  AccountTestResult,
} from './types.ts'

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
}

const DEFAULT_TIMEOUT_MS = 15_000
const BODY_LIMIT = 8 * 1024
const ERROR_DETAIL_LIMIT = 300
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
        messages: [{ role: 'user', content: 'hi' }],
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
        input: [{ role: 'user', content: 'hi' }],
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
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
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
      messages: [{ role: 'user', content: 'hi' }],
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

  let response: Response
  let text: string
  try {
    response = await deps.fetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      ...(plan.body === undefined ? {} : { body: plan.body }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = (await response.text()).slice(0, BODY_LIMIT)
  } catch (error) {
    return {
      ok: false,
      status: null,
      latencyMs: elapsed(now, startedAt),
      model,
      protocol,
      error: redact(networkErrorText(error, timeoutMs), token),
      testedAt: new Date(now()).toISOString(),
    }
  }

  const latencyMs = elapsed(now, startedAt)
  const testedAt = new Date(now()).toISOString()
  const parsed = parseJson(text)

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
    }
  }

  return { ok: true, status: response.status, latencyMs, model, protocol, error: null, testedAt }
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

function firstLine(text: string): string | undefined {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line === '' ? undefined : line
}

function truncate(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length <= ERROR_DETAIL_LIMIT ? single : `${single.slice(0, ERROR_DETAIL_LIMIT)}…`
}

/** 网络错误只保留短原因；绝不拼接请求 URL（尤其 query）。 */
function networkErrorText(error: unknown, timeoutMs: number): string {
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (name === 'TimeoutError' || name === 'AbortError') return `请求超时（${timeoutMs}ms）`
  }
  if (error instanceof TypeError) {
    const cause = (error as { cause?: unknown }).cause
    const code =
      typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string'
        ? (cause as { code: string }).code
        : undefined
    return code === undefined ? '网络请求失败' : `网络请求失败：${code}`
  }
  if (error instanceof Error) {
    const message = firstLine(error.message)
    return message === undefined ? '网络请求失败' : `网络请求失败：${message}`
  }
  return '网络请求失败'
}

/** token、URL-encoded token、`Bearer <token>` → `[REDACTED]`。 */
export function redact(text: string, token: string): string {
  if (token === '') return text
  let out = text.split(`Bearer ${token}`).join('[REDACTED]')
  out = out.split(token).join('[REDACTED]')
  let encoded = token
  try {
    encoded = encodeURIComponent(token)
  } catch {
    encoded = token
  }
  if (encoded !== token && encoded !== '') out = out.split(encoded).join('[REDACTED]')
  return out
}
