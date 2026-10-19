/**
 * 两家首发上游的 RT 交换。
 *
 * 这里只做一件事：拿 refresh_token 换一对新令牌。不构造模型请求、不碰代理、
 * 不碰计费——那是 transport / gateway 的事（AGENTS.md D17）。
 *
 * 端点与客户端 ID 取自上游 CLI 的公开 OAuth 流程：
 * - Claude Code：platform.claude.com 的 token 端点，JSON body；
 * - Codex CLI：auth.openai.com 的 token 端点，form body。
 */
import type { IdentityProvider, IdentityTokenBundle } from './types.ts'

export interface TokenExchangeContext {
  readonly timeoutMs: number
  readonly fetch: typeof fetch
}

export interface TokenExchangeResult {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly tokenType?: string
  readonly scope?: string
  readonly expiresAt: string
}

/** 上游返回的可分类错误。`retryable=false` 表示账号需要人工重新授权。 */
export class ProviderExchangeError extends Error {
  readonly retryable: boolean
  readonly status: number | null
  readonly oauthCode: string | null

  constructor(
    message: string,
    options: { readonly retryable: boolean; readonly status?: number | null; readonly oauthCode?: string | null },
  ) {
    super(message)
    this.name = 'ProviderExchangeError'
    this.retryable = options.retryable
    this.status = options.status ?? null
    this.oauthCode = options.oauthCode ?? null
  }
}

const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token'
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const OPENAI_REFRESH_SCOPE = 'openid profile email'

const DEFAULT_EXPIRES_IN_SECONDS = 3600

export function supportsRefresh(provider: IdentityProvider): boolean {
  return provider === 'claude' || provider === 'openai'
}

export async function exchangeRefreshToken(
  provider: IdentityProvider,
  bundle: IdentityTokenBundle,
  context: TokenExchangeContext,
): Promise<TokenExchangeResult> {
  const refreshToken = bundle.refreshToken
  if (refreshToken === undefined || refreshToken === '') {
    throw new ProviderExchangeError('没有 refresh_token，无法交换新令牌', {
      retryable: false,
      oauthCode: 'missing_refresh_token',
    })
  }

  let response: Response
  try {
    const [url, init] = requestFor(provider, bundle, refreshToken)
    response = await context.fetch(url, { ...init, signal: AbortSignal.timeout(context.timeoutMs) })
  } catch (error) {
    throw new ProviderExchangeError(`令牌端点请求失败：${errorText(error)}`, { retryable: true })
  }

  if (!response.ok) {
    const failure = await readOAuthError(response)
    throw new ProviderExchangeError(failure.message, {
      retryable: failure.retryable,
      status: response.status,
      oauthCode: failure.code,
    })
  }

  let payload: Record<string, unknown>
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    throw new ProviderExchangeError('令牌端点返回的不是 JSON', { retryable: true })
  }

  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  if (accessToken === '') {
    throw new ProviderExchangeError('令牌端点没有返回 access_token', { retryable: true })
  }

  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) && payload.expires_in > 0
      ? payload.expires_in
      : DEFAULT_EXPIRES_IN_SECONDS

  return {
    accessToken,
    ...(typeof payload.refresh_token === 'string' && payload.refresh_token !== ''
      ? { refreshToken: payload.refresh_token }
      : {}),
    ...(typeof payload.token_type === 'string' ? { tokenType: payload.token_type } : {}),
    ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
  }
}

function requestFor(
  provider: IdentityProvider,
  bundle: IdentityTokenBundle,
  refreshToken: string,
): [string, RequestInit] {
  switch (provider) {
    case 'claude': {
      const body = JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: bundle.clientId ?? CLAUDE_CLIENT_ID,
      })
      return [
        CLAUDE_TOKEN_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'User-Agent': 'DizzyAPI-Identity/0.1',
          },
          body,
        },
      ]
    }
    case 'openai': {
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: bundle.clientId ?? OPENAI_CLIENT_ID,
        scope: OPENAI_REFRESH_SCOPE,
      })
      return [
        OPENAI_TOKEN_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'codex_cli_rs/0.0.0 (DizzyAPI identity)',
            originator: 'codex_cli_rs',
          },
          body: form.toString(),
        },
      ]
    }
    default:
      throw new ProviderExchangeError(`没有为 ${provider} 实现 RT 交换`, {
        retryable: false,
        oauthCode: 'provider_unsupported',
      })
  }
}

async function readOAuthError(
  response: Response,
): Promise<{ message: string; code: string | null; retryable: boolean }> {
  let code: string | null = null
  let description: string | null = null
  try {
    const text = await response.text()
    if (text !== '') {
      try {
        const payload = JSON.parse(text) as Record<string, unknown>
        if (typeof payload.error === 'string') code = payload.error
        if (typeof payload.error_description === 'string') description = payload.error_description
      } catch {
        // 非 JSON 错误体：不把正文带进错误里，可能夹带敏感信息
      }
    }
  } catch {
    // 读不动就算了，状态码本身足够分类
  }

  const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
  const detail = [code, description].filter((part) => part !== null && part !== '').join('：')
  const message = `上游返回 ${response.status}${detail === '' ? '' : `（${trim(detail, 200)}）`}`
  return { message, code, retryable }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '请求超时'
    return error.message
  }
  return String(error)
}

function trim(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}
