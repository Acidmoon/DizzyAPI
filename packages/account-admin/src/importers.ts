/**
 * 凭据导入解析器：把管理员粘贴 / 上传的常见格式变成 identity 认识的令牌包。
 *
 * 支持的格式：
 * - `claude-oauth`：Claude Code `.credentials.json`（`claudeAiOauth` 包装，expiresAt 为毫秒）
 *   以及常见的 camelCase / snake_case OAuth 令牌响应；
 * - `openai-codex`：Codex CLI `auth.json`（`tokens` 包装，或只有 `OPENAI_API_KEY` 的 API-key 模式）
 *   以及 OAuth 令牌响应；id_token 只在本地解出 email / 主体标识，**不保存**；
 * - `api-key`：纯文本 key，或 `apiKey` / `api_key` / `key` / `token` 字段；
 * - `identity-bundle`：identity 的 camelCase / snake_case 令牌包；
 * - `auto`：按 payload 形状推断，推断不出 provider 时明确要求显式给出。
 *
 * 本文件是**纯函数**：不落盘、不调用服务、不写日志。错误信息只提字段名，
 * 绝不回显令牌值——这些字符串会直接进管理面。
 */
import { AccountAdminError, type AccountAdminErrorCode } from './errors.ts'
import type {
  AccountKind,
  AccountProvider,
  CredentialImportFormat,
  CredentialImportInput,
  CredentialImportPreview,
} from './types.ts'

/** identity 的 `IdentityTokenBundle` 的结构性副本（不 import 它的包，保持包间松耦合）。 */
export interface CredentialBundle {
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly tokenType?: string
  readonly scope?: string
  readonly expiresAt?: string
  readonly clientId?: string
  readonly apiKey?: string
}

export interface ParsedCredential {
  readonly format: Exclude<CredentialImportFormat, 'auto'>
  readonly bundle: CredentialBundle
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly email: string | null
  readonly subject: string | null
}

interface RawParsed {
  readonly format: Exclude<CredentialImportFormat, 'auto'>
  readonly bundle: CredentialBundle
  readonly provider: AccountProvider | null
  readonly kind: AccountKind
  readonly email: string | null
  readonly subject: string | null
}

const FORMATS = new Set<CredentialImportFormat>([
  'auto',
  'claude-oauth',
  'openai-codex',
  'api-key',
  'identity-bundle',
])

const PROVIDERS: ReadonlySet<string> = new Set(['claude', 'openai', 'custom'])
const KINDS: ReadonlySet<string> = new Set(['oauth', 'api_key'])
const TOKEN_MAX_LENGTH = 4096

function fail(code: AccountAdminErrorCode, message: string): never {
  throw new AccountAdminError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只用于错误信息里的不可信值，截断，避免把一大坨东西塞进 message。 */
function short(value: unknown): string {
  const text = typeof value === 'string' ? value : typeof value
  return text.length <= 40 ? text : `${text.slice(0, 40)}…`
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = nonEmptyString(value)
    if (text !== undefined) return text
  }
  return undefined
}

function firstDefined(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  ...keys: string[]
): unknown {
  for (const key of keys) {
    const value = first[key]
    if (value !== undefined && value !== null && value !== '') return value
    const outer = second[key]
    if (outer !== undefined && outer !== null && outer !== '') return outer
  }
  return undefined
}

/** 令牌类字段：非空、无空白 / 控制字符、长度有上限。 */
function assertToken(value: string, field: string): string {
  if (value.length > TOKEN_MAX_LENGTH) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', `${field} 超过 ${TOKEN_MAX_LENGTH} 字符上限`)
  }
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', `${field} 不能包含空白或控制字符`)
  }
  return value
}

/**
 * 时间统一成 ISO。数字按时间戳处理：>= 1e12 视为毫秒（Claude 的 expiresAt），
 * >= 1e9 视为秒（OAuth 的 expires_in 常见量级）。字符串优先按 ISO 解析。
 */
function readInstant(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') return fromTimestamp(value, field)
  if (typeof value !== 'string') {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', `${field} 必须是时间戳或 ISO 时间字符串`)
  }
  const text = value.trim()
  if (text === '') return undefined
  if (/^-?\d+(\.\d+)?$/.test(text)) return fromTimestamp(Number(text), field)
  const parsed = Date.parse(text)
  if (!Number.isFinite(parsed)) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', `${field} 不是可识别的时间`)
  }
  return new Date(parsed).toISOString()
}

function fromTimestamp(value: number, field: string): string {
  if (!Number.isFinite(value)) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', `${field} 不是有效时间戳`)
  }
  if (value >= 1_000_000_000_000) return new Date(value).toISOString()
  if (value >= 1_000_000_000) return new Date(value * 1000).toISOString()
  fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', `${field} 时间戳太小，无法判断是秒还是毫秒`)
}

function readExpiry(source: Record<string, unknown>, raw: Record<string, unknown>): string | undefined {
  const direct = firstDefined(source, raw, 'expiresAt', 'expires_at')
  if (direct !== undefined) return readInstant(direct, 'expiresAt')

  const expiresIn = firstDefined(source, raw, 'expires_in')
  if (expiresIn === undefined) return undefined
  const seconds =
    typeof expiresIn === 'number'
      ? expiresIn
      : typeof expiresIn === 'string' && /^\d+$/.test(expiresIn.trim())
        ? Number(expiresIn)
        : undefined
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return undefined
  return new Date(Date.now() + seconds * 1000).toISOString()
}

function readScope(source: Record<string, unknown>, raw: Record<string, unknown>): string | undefined {
  const direct = firstString(source.scope, raw.scope)
  if (direct !== undefined) return direct
  const scopes = Array.isArray(source.scopes)
    ? source.scopes
    : Array.isArray(raw.scopes)
      ? raw.scopes
      : undefined
  if (scopes === undefined) return undefined
  const parts = scopes
    .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    .map((item) => item.trim())
  return parts.length === 0 ? undefined : parts.join(' ')
}

function buildBundle(fields: {
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly tokenType?: string
  readonly scope?: string
  readonly expiresAt?: string
  readonly clientId?: string
  readonly apiKey?: string
}): CredentialBundle {
  return {
    ...(fields.accessToken !== undefined ? { accessToken: assertToken(fields.accessToken, 'accessToken') } : {}),
    ...(fields.refreshToken !== undefined ? { refreshToken: assertToken(fields.refreshToken, 'refreshToken') } : {}),
    ...(fields.tokenType !== undefined ? { tokenType: fields.tokenType } : {}),
    ...(fields.scope !== undefined ? { scope: fields.scope } : {}),
    ...(fields.expiresAt !== undefined ? { expiresAt: fields.expiresAt } : {}),
    ...(fields.clientId !== undefined ? { clientId: fields.clientId } : {}),
    ...(fields.apiKey !== undefined ? { apiKey: assertToken(fields.apiKey, 'apiKey') } : {}),
  }
}

// ───────────────────────────────── 格式解析 ─────────────────────────────────

function parseClaude(raw: Record<string, unknown>): RawParsed {
  const source = isRecord(raw.claudeAiOauth) ? raw.claudeAiOauth : isRecord(raw.oauth) ? raw.oauth : raw
  const accessToken = firstString(source.accessToken, source.access_token, raw.accessToken, raw.access_token)
  const refreshToken = firstString(source.refreshToken, source.refresh_token, raw.refreshToken, raw.refresh_token)
  if (accessToken === undefined && refreshToken === undefined) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', 'Claude 凭据至少要包含 accessToken 或 refreshToken')
  }
  const tokenType = firstString(source.tokenType, source.token_type, raw.tokenType, raw.token_type)
  const scope = readScope(source, raw)
  const expiresAt = readExpiry(source, raw)
  const clientId = firstString(source.clientId, source.client_id, raw.clientId, raw.client_id)

  return {
    format: 'claude-oauth',
    bundle: buildBundle({
      ...(accessToken !== undefined ? { accessToken } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(tokenType !== undefined ? { tokenType } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    }),
    provider: 'claude',
    kind: 'oauth',
    email: firstString(source.email, raw.email, source.accountEmail, raw.accountEmail) ?? null,
    subject:
      firstString(
        source.accountUuid,
        source.account_uuid,
        source.accountId,
        source.account_id,
        raw.accountUuid,
        raw.account_uuid,
      ) ?? null,
  }
}

function parseOpenAI(raw: Record<string, unknown>): RawParsed {
  const source = isRecord(raw.tokens) ? raw.tokens : raw
  const accessToken = firstString(source.access_token, source.accessToken, raw.access_token, raw.accessToken)
  const refreshToken = firstString(source.refresh_token, source.refreshToken, raw.refresh_token, raw.refreshToken)
  const idToken = firstString(source.id_token, source.idToken, raw.id_token, raw.idToken)
  const apiKey = firstString(source.api_key, source.apiKey, raw.OPENAI_API_KEY, raw.api_key, raw.apiKey)
  const accountId = firstString(source.account_id, source.accountId, raw.account_id, raw.accountId)

  const claims = idToken === undefined ? undefined : decodeJwtPayload(idToken)
  const authClaim =
    claims !== undefined && isRecord(claims['https://api.openai.com/auth'])
      ? claims['https://api.openai.com/auth']
      : undefined
  const email =
    firstString(source.email, raw.email, claims?.email) ??
    null
  const subject =
    accountId ??
    firstString(authClaim?.chatgpt_account_id, authClaim?.chatgpt_accountId, claims?.sub) ??
    null

  if (accessToken === undefined && refreshToken === undefined) {
    if (apiKey === undefined) {
      fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', 'OpenAI 凭据里没有 tokens.access_token / tokens.refresh_token，也没有 OPENAI_API_KEY')
    }
    return {
      format: 'openai-codex',
      bundle: buildBundle({ apiKey }),
      provider: 'openai',
      kind: 'api_key',
      email,
      subject,
    }
  }

  const tokenType = firstString(source.token_type, source.tokenType, raw.token_type, raw.tokenType)
  const scope = readScope(source, raw)
  const expiresAt = readExpiry(source, raw)
  const clientId = firstString(source.client_id, source.clientId, raw.client_id, raw.clientId)

  return {
    format: 'openai-codex',
    bundle: buildBundle({
      ...(accessToken !== undefined ? { accessToken } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(tokenType !== undefined ? { tokenType } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
    }),
    provider: 'openai',
    kind: 'oauth',
    email,
    subject,
  }
}

function parseApiKeyObject(raw: Record<string, unknown>): RawParsed {
  const value = firstString(raw.apiKey, raw.api_key, raw.key, raw.token, raw.OPENAI_API_KEY)
  if (value === undefined) {
    fail(
      'ACCOUNT_ADMIN_IMPORT_FIELD_INVALID',
      'API key 凭据必须包含 apiKey / api_key / key / token 之一',
    )
  }
  return {
    format: 'api-key',
    bundle: buildBundle({ apiKey: value }),
    provider: null,
    kind: 'api_key',
    email: null,
    subject: null,
  }
}

function parseIdentityBundle(raw: Record<string, unknown>): RawParsed {
  const source = isRecord(raw.secret) ? raw.secret : raw
  const accessToken = firstString(source.accessToken, source.access_token, raw.accessToken, raw.access_token)
  const refreshToken = firstString(source.refreshToken, source.refresh_token, raw.refreshToken, raw.refresh_token)
  const apiKey = firstString(source.apiKey, source.api_key, raw.apiKey, raw.api_key)

  const hasOauth = accessToken !== undefined || refreshToken !== undefined
  const hasApiKey = apiKey !== undefined
  if (hasOauth && hasApiKey) {
    fail('ACCOUNT_ADMIN_IMPORT_CONFLICT', '凭据同时包含 apiKey 与 OAuth 令牌，无法确定账号类型')
  }
  if (!hasOauth && !hasApiKey) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', '凭据里没有 apiKey，也没有 accessToken / refreshToken')
  }

  const tokenType = firstString(source.tokenType, source.token_type, raw.tokenType, raw.token_type)
  const scope = readScope(source, raw)
  const expiresAt = readExpiry(source, raw)
  const clientId = firstString(source.clientId, source.client_id, raw.clientId, raw.client_id)

  return {
    format: 'identity-bundle',
    bundle: buildBundle({
      ...(accessToken !== undefined ? { accessToken } : {}),
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(tokenType !== undefined ? { tokenType } : {}),
      ...(scope !== undefined ? { scope } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(clientId !== undefined ? { clientId } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
    }),
    provider: null,
    kind: hasApiKey ? 'api_key' : 'oauth',
    email: firstString(source.email, raw.email) ?? null,
    subject: firstString(source.subject, raw.subject, source.accountId, source.account_id) ?? null,
  }
}

function detectFormat(raw: Record<string, unknown>): Exclude<CredentialImportFormat, 'auto'> {
  if (isRecord(raw.claudeAiOauth)) return 'claude-oauth'
  if (isRecord(raw.tokens)) return 'openai-codex'
  if (typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim() !== '') return 'openai-codex'
  if (typeof raw.id_token === 'string' || typeof raw.idToken === 'string') return 'openai-codex'
  if (raw.apiKey !== undefined || raw.api_key !== undefined || raw.key !== undefined) return 'api-key'
  if (
    raw.accessToken !== undefined ||
    raw.access_token !== undefined ||
    raw.refreshToken !== undefined ||
    raw.refresh_token !== undefined
  ) {
    return 'identity-bundle'
  }
  fail(
    'ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID',
    '无法识别的凭据格式；请显式给出 format（claude-oauth / openai-codex / api-key / identity-bundle）',
  )
}

// ───────────────────────────────── 解析入口 ─────────────────────────────────

export function parseCredentialImport(input: CredentialImportInput): ParsedCredential {
  if (!isRecord(input)) {
    fail('ACCOUNT_ADMIN_INPUT_INVALID', '凭据导入参数必须是对象')
  }
  const format = normalizeFormat(input.format)
  const providerHint = normalizeProviderHint(input.provider)
  const kindHint = normalizeKindHint(input.kind)

  const payload = input.payload
  if (typeof payload === 'string') {
    const text = payload.trim()
    if (text === '') fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', 'payload 不能为空')

    if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        fail('ACCOUNT_ADMIN_IMPORT_JSON_INVALID', 'payload 不是合法 JSON')
      }
      if (typeof parsed === 'string') {
        if (format !== 'auto' && format !== 'api-key') {
          fail('ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID', `${format} 需要 JSON 对象，收到的是 JSON 字符串`)
        }
        return finalize(
          { format: 'api-key', bundle: buildBundle({ apiKey: parsed }), provider: null, kind: 'api_key', email: null, subject: null },
          providerHint,
          kindHint,
        )
      }
      if (!isRecord(parsed)) {
        fail('ACCOUNT_ADMIN_IMPORT_JSON_INVALID', 'payload 必须是 JSON 对象')
      }
      return parseObject(parsed, format, providerHint, kindHint)
    }

    if (format !== 'auto' && format !== 'api-key') {
      fail('ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID', `${format} 需要 JSON 对象，收到的是纯文本`)
    }
    return finalize(
      {
        format: 'api-key',
        bundle: buildBundle({ apiKey: text }),
        provider: null,
        kind: 'api_key',
        email: null,
        subject: null,
      },
      providerHint,
      kindHint,
    )
  }

  if (!isRecord(payload)) {
    fail('ACCOUNT_ADMIN_IMPORT_FIELD_INVALID', 'payload 必须是 JSON 对象或字符串')
  }
  return parseObject(payload, format, providerHint, kindHint)
}

function parseObject(
  raw: Record<string, unknown>,
  format: CredentialImportFormat,
  providerHint: AccountProvider | undefined,
  kindHint: AccountKind | undefined,
): ParsedCredential {
  const resolvedFormat = format === 'auto' ? detectFormat(raw) : format
  switch (resolvedFormat) {
    case 'claude-oauth':
      return finalize(parseClaude(raw), providerHint, kindHint)
    case 'openai-codex':
      return finalize(parseOpenAI(raw), providerHint, kindHint)
    case 'api-key':
      return finalize(parseApiKeyObject(raw), providerHint, kindHint)
    case 'identity-bundle':
      return finalize(parseIdentityBundle(raw), providerHint, kindHint)
    default:
      fail('ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID', `不认识的凭据格式：${short(resolvedFormat)}`)
  }
}

// ───────────────────────────────── 收尾与预检 ─────────────────────────────────

function finalize(
  raw: RawParsed,
  providerHint: AccountProvider | undefined,
  kindHint: AccountKind | undefined,
): ParsedCredential {
  const kind = resolveKind(raw.kind, kindHint)
  const provider = resolveProvider(raw.provider, providerHint, kind)
  return { ...raw, provider, kind }
}

export function normalizeFormatHint(value: unknown): CredentialImportFormat | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !FORMATS.has(value as CredentialImportFormat)) {
    fail(
      'ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID',
      `不认识的凭据格式：${short(value)}（可用：auto / claude-oauth / openai-codex / api-key / identity-bundle）`,
    )
  }
  return value as CredentialImportFormat
}

function normalizeFormat(value: unknown): CredentialImportFormat {
  if (value === undefined) return 'auto'
  if (typeof value !== 'string' || !FORMATS.has(value as CredentialImportFormat)) {
    fail(
      'ACCOUNT_ADMIN_IMPORT_FORMAT_INVALID',
      `不认识的凭据格式：${short(value)}（可用：auto / claude-oauth / openai-codex / api-key / identity-bundle）`,
    )
  }
  return value as CredentialImportFormat
}

export function normalizeProviderHint(value: unknown): AccountProvider | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !PROVIDERS.has(value)) {
    fail('ACCOUNT_ADMIN_INPUT_INVALID', `不认识的 provider：${short(value)}（只认 claude / openai / custom）`)
  }
  return value as AccountProvider
}

export function normalizeKindHint(value: unknown): AccountKind | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !KINDS.has(value)) {
    fail('ACCOUNT_ADMIN_INPUT_INVALID', `不认识的账号类型：${short(value)}（只认 oauth / api_key）`)
  }
  return value as AccountKind
}

function resolveKind(parsed: AccountKind, hint: AccountKind | undefined): AccountKind {
  if (hint === undefined) return parsed
  if (hint !== parsed) {
    fail('ACCOUNT_ADMIN_IMPORT_CONFLICT', `凭据是 ${parsed}，但要求按 ${hint} 导入`)
  }
  return hint
}

function resolveProvider(
  parsed: AccountProvider | null,
  hint: AccountProvider | undefined,
  kind: AccountKind,
): AccountProvider {
  if (parsed !== null && hint !== undefined && hint !== parsed) {
    fail('ACCOUNT_ADMIN_IMPORT_CONFLICT', `凭据属于 ${parsed}，但目标是 ${hint}`)
  }
  const provider = hint ?? parsed ?? (kind === 'api_key' ? 'custom' : undefined)
  if (provider === undefined) {
    fail(
      'ACCOUNT_ADMIN_IMPORT_PROVIDER_REQUIRED',
      '无法从凭据判断 provider；OAuth 账号必须显式给出 claude 或 openai',
    )
  }
  assertProviderKind(provider, kind)
  return provider
}

/** 供服务层复用：custom 只能用于 api_key，订阅账号必须 claude / openai。 */
export function assertProviderKind(provider: AccountProvider, kind: AccountKind): void {
  if (kind === 'oauth' && provider === 'custom') {
    fail('ACCOUNT_ADMIN_INPUT_INVALID', 'custom provider 只能用于 api_key 账号')
  }
}

/**
 * 导入预检：识别格式与元数据，但不返回任何令牌本体。
 * 管理面 / 前端可以先用它做「能不能导入」的即时校验。
 */
export function previewCredentialImport(input: CredentialImportInput): CredentialImportPreview {
  const parsed = parseCredentialImport(input)
  return {
    format: parsed.format,
    provider: parsed.provider,
    kind: parsed.kind,
    email: parsed.email,
    subject: parsed.subject,
    expiresAt: parsed.bundle.expiresAt ?? null,
    hasAccessToken: parsed.bundle.accessToken !== undefined,
    hasRefreshToken: parsed.bundle.refreshToken !== undefined,
    hasApiKey: parsed.bundle.apiKey !== undefined,
  }
}

// ───────────────────────────────── JWT 元数据 ─────────────────────────────────

/**
 * 只解码 id_token 的 payload 取 email / 主体标识，**不验证签名、不保存 id_token**。
 * 解码失败就当没有元数据，不让导入失败。
 */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const text = Buffer.from(parts[1] as string, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}
