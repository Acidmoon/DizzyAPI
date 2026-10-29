/**
 * 导入来源解析器：把 new-api / sub2api / 纯 key 文本归一化成 identity 能创建的账号条目。
 *
 * 参考的是两个项目的**导出 / 导入字段**，不是实现：
 * - new-api 没有渠道导出，事实上的格式是 `Channel` 对象（`type/key/name/base_url/
 *   models/model_mapping/status/priority`）以及批量新增时按换行拆 key；
 * - sub2api 的导出文件是 `{ type: 'sub2api-data', version, proxies, accounts }`，
 *   账号带 `platform` / `type` / `credentials`。
 *
 * 本文件是**纯函数**：不落盘、不调用服务、不写日志。错误信息只提字段名与位置
 * （`第 N 项`），绝不回显 `key` / `credentials` 的内容。
 */
import { AccountAdminError } from './errors.ts'
import {
  assertProviderKind,
  normalizeKindHint,
  normalizeProviderHint,
} from './importers.ts'
import type {
  AccountImportDefaults,
  AccountImportSourceFormat,
  AccountImportSourceInput,
  AccountKind,
  AccountProtocol,
  AccountProvider,
  ParsedImportIssue,
  ParsedImportItem,
  ParsedImportSource,
} from './types.ts'

const SOURCE_FORMATS: ReadonlySet<string> = new Set(['auto', 'new-api', 'sub2api', 'plain-keys'])
const PROTOCOLS: ReadonlySet<string> = new Set([
  'openai-chat',
  'openai-responses',
  'anthropic',
  'gemini',
])
const DEFAULT_KEYS = ['provider', 'kind', 'baseUrl', 'protocol', 'enabled', 'labelPrefix'] as const

function fail(code: 'ACCOUNT_IMPORT_SOURCE_INVALID' | 'ACCOUNT_IMPORT_FIELD_INVALID', message: string): never {
  throw new AccountAdminError(code, message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ───────────────────────────────── 入口 ─────────────────────────────────

/**
 * 解析导入来源。结构性错误（不是 sub2api 导出、不是合法 JSON）抛稳定 code；
 * 单个渠道 / 账号的问题进 `issues`，不影响同一批里的其它项。
 */
export function parseImportSource(input: AccountImportSourceInput): ParsedImportSource {
  if (!isRecord(input)) fail('ACCOUNT_IMPORT_SOURCE_INVALID', '导入参数必须是对象')
  const source = normalizeSource(input.source)
  if (typeof input.payload !== 'string' || input.payload.trim() === '') {
    fail('ACCOUNT_IMPORT_FIELD_INVALID', 'payload 不能为空')
  }
  const defaults = normalizeDefaults(input.defaults)
  const resolved = source === 'auto' ? detectSource(input.payload) : source

  if (resolved === 'new-api') return parseNewApi(input.payload)
  if (resolved === 'sub2api') return parseSub2Api(input.payload)
  return parsePlainKeys(input.payload, defaults)
}

function normalizeSource(value: unknown): AccountImportSourceFormat {
  if (typeof value !== 'string' || !SOURCE_FORMATS.has(value)) {
    fail('ACCOUNT_IMPORT_SOURCE_INVALID', 'source 只能是 auto / new-api / sub2api / plain-keys')
  }
  return value as AccountImportSourceFormat
}

/** 只看 payload 形状：sub2api 的 `type` 最明确，其次 new-api 的 `key/type/base_url`。 */
export function detectSource(payload: string): Exclude<AccountImportSourceFormat, 'auto'> {
  const parsed = tryJson(payload.trim())
  if (isRecord(parsed) && parsed.type === 'sub2api-data' && Array.isArray(parsed.accounts)) {
    return 'sub2api'
  }
  if (Array.isArray(parsed)) {
    if (parsed.some((item) => isRecord(item) && ('key' in item || 'type' in item || 'base_url' in item))) {
      return 'new-api'
    }
    return 'plain-keys'
  }
  if (isRecord(parsed)) {
    if ('key' in parsed || 'type' in parsed || 'base_url' in parsed || 'channels' in parsed) {
      return 'new-api'
    }
    return 'plain-keys'
  }
  return 'plain-keys'
}

function normalizeDefaults(value: unknown): AccountImportDefaults {
  if (value === undefined) return {}
  if (!isRecord(value)) fail('ACCOUNT_IMPORT_FIELD_INVALID', 'defaults 必须是对象')
  for (const key of Object.keys(value)) {
    if (!(DEFAULT_KEYS as readonly string[]).includes(key)) {
      fail('ACCOUNT_IMPORT_FIELD_INVALID', `defaults 不支持字段 ${key}`)
    }
  }
  const provider = normalizeProviderHint(value.provider)
  const kind = normalizeKindHint(value.kind)
  if (provider !== undefined && kind !== undefined) assertProviderKind(provider, kind)
  const baseUrl = normalizeDefaultBaseUrl(value.baseUrl)
  const protocol = normalizeProtocol(value.protocol)
  const enabled = normalizeBoolean(value.enabled)

  let labelPrefix: string | undefined
  if (value.labelPrefix !== undefined) {
    if (typeof value.labelPrefix !== 'string') {
      fail('ACCOUNT_IMPORT_FIELD_INVALID', 'labelPrefix 必须是字符串')
    }
    labelPrefix = value.labelPrefix.trim() === '' ? undefined : value.labelPrefix.trim()
  }

  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(labelPrefix !== undefined ? { labelPrefix } : {}),
  }
}

function normalizeDefaultBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail('ACCOUNT_IMPORT_FIELD_INVALID', 'baseUrl 必须是字符串')
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    fail('ACCOUNT_IMPORT_FIELD_INVALID', 'baseUrl 必须是合法的 http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('ACCOUNT_IMPORT_FIELD_INVALID', 'baseUrl 只支持 http / https')
  }
  return trimmed.replace(/\/+$/, '')
}

function normalizeProtocol(value: unknown): AccountProtocol | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !PROTOCOLS.has(value)) {
    fail(
      'ACCOUNT_IMPORT_FIELD_INVALID',
      'protocol 只能是 openai-chat / openai-responses / anthropic / gemini',
    )
  }
  return value as AccountProtocol
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail('ACCOUNT_IMPORT_FIELD_INVALID', 'enabled 必须是布尔值')
  return value
}

// ───────────────────────────────── 收集器 ─────────────────────────────────

interface Collector {
  readonly source: Exclude<AccountImportSourceFormat, 'auto'>
  readonly items: ParsedImportItem[]
  readonly issues: ParsedImportIssue[]
  readonly warnings: string[]
  index: number
}

function collectorOf(source: Exclude<AccountImportSourceFormat, 'auto'>): Collector {
  return { source, items: [], issues: [], warnings: [], index: 0 }
}

function addItem(collector: Collector, item: Omit<ParsedImportItem, 'index'>): void {
  collector.items.push({ ...item, index: collector.index })
  collector.index += 1
  for (const warning of item.warnings) collector.warnings.push(warning)
}

function addIssue(
  collector: Collector,
  sourceIndex: number,
  code: string,
  message: string,
): void {
  collector.issues.push({ index: collector.index, sourceIndex, code, message })
  collector.index += 1
}

function finish(collector: Collector): ParsedImportSource {
  return {
    source: collector.source,
    items: collector.items,
    issues: collector.issues,
    warnings: collector.warnings,
  }
}

// ───────────────────────────────── new-api ─────────────────────────────────

interface ChannelShape {
  readonly provider: AccountProvider
  readonly kind: AccountKind
  readonly protocol: AccountProtocol
}

const CHANNEL_TYPES: Readonly<Record<number, ChannelShape>> = {
  1: { provider: 'openai', kind: 'api_key', protocol: 'openai-chat' },
  8: { provider: 'custom', kind: 'api_key', protocol: 'openai-chat' },
  14: { provider: 'claude', kind: 'api_key', protocol: 'anthropic' },
  57: { provider: 'openai', kind: 'oauth', protocol: 'openai-responses' },
}

function parseNewApi(payload: string): ParsedImportSource {
  const parsed = tryJson(payload.trim())
  const channels = channelListOf(parsed)
  if (channels === undefined) {
    fail('ACCOUNT_IMPORT_SOURCE_INVALID', 'new-api 导入必须是 Channel 对象、Channel 数组或 { channels: [...] }')
  }
  if (channels.length === 0) fail('ACCOUNT_IMPORT_FIELD_INVALID', '没有可导入的渠道')

  const collector = collectorOf('new-api')
  channels.forEach((raw, channelIndex) => parseChannel(collector, raw, channelIndex))
  return finish(collector)
}

function channelListOf(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed
  if (isRecord(parsed)) {
    if (Array.isArray(parsed.channels)) return parsed.channels
    return [parsed]
  }
  return undefined
}

function parseChannel(collector: Collector, raw: unknown, channelIndex: number): void {
  const position = channelIndex + 1
  if (!isRecord(raw)) {
    addIssue(collector, channelIndex, 'ACCOUNT_IMPORT_FIELD_INVALID', `第 ${position} 项必须是对象`)
    return
  }

  const type = readInteger(raw.type)
  const shape = type === undefined ? undefined : CHANNEL_TYPES[type]
  if (type === undefined || shape === undefined) {
    addIssue(
      collector,
      channelIndex,
      'ACCOUNT_IMPORT_UNSUPPORTED_TYPE',
      `第 ${position} 项的 type ${type === undefined ? '缺失或不是整数' : String(type)} 不受支持（只支持 1 / 8 / 14 / 57）`,
    )
    return
  }

  const key = raw.key
  if (typeof key !== 'string' || key.trim() === '') {
    addIssue(collector, channelIndex, 'ACCOUNT_IMPORT_FIELD_INVALID', `第 ${position} 项缺少 key`)
    return
  }
  const keys = key
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (keys.length === 0) {
    addIssue(collector, channelIndex, 'ACCOUNT_IMPORT_FIELD_INVALID', `第 ${position} 项缺少 key`)
    return
  }

  const baseUrl = readChannelBaseUrl(optionalStringField(raw.base_url))
  if (baseUrl === false) {
    addIssue(
      collector,
      channelIndex,
      'ACCOUNT_IMPORT_FIELD_INVALID',
      `第 ${position} 项的 base_url 必须是 http(s) URL`,
    )
    return
  }
  const models = readModels(raw.models)
  if (models === false) {
    addIssue(
      collector,
      channelIndex,
      'ACCOUNT_IMPORT_FIELD_INVALID',
      `第 ${position} 项的 models 必须是逗号分隔字符串或字符串数组`,
    )
    return
  }
  const modelMap = readModelMap(raw.model_mapping)
  if (modelMap === false) {
    addIssue(
      collector,
      channelIndex,
      'ACCOUNT_IMPORT_FIELD_INVALID',
      `第 ${position} 项的 model_mapping 必须是 JSON 字符串或字符串映射`,
    )
    return
  }

  const label = nonEmptyString(raw.name)
  const priority = readPriority(raw.priority)
  const enabled = readStatus(raw.status)
  const base = {
    provider: shape.provider,
    kind: shape.kind,
    protocol: shape.protocol,
    ...(label === undefined ? {} : { label }),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(modelMap !== undefined ? { modelMap } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    warnings: [] as string[],
  }

  // type 57 的 key 是 JSON：每行一个 `{ access_token, account_id? }`。
  if (type === 57) {
    keys.forEach((keyLine, keyIndex) => {
      const parsedKey = tryJson(keyLine)
      const accessToken =
        isRecord(parsedKey) && typeof parsedKey.access_token === 'string' ? parsedKey.access_token.trim() : ''
      if (!isRecord(parsedKey) || accessToken === '') {
        addIssue(
          collector,
          channelIndex,
          'ACCOUNT_IMPORT_FIELD_INVALID',
          `第 ${position} 项的第 ${keyIndex + 1} 个 key 不是含 access_token 的 JSON 对象`,
        )
        return
      }
      addItem(collector, {
        ...base,
        sourceIndex: channelIndex,
        ...(label !== undefined && keys.length > 1 ? { label: `${label} #${keyIndex + 1}` } : {}),
        payload: JSON.stringify(parsedKey),
      })
    })
    return
  }

  keys.forEach((keyLine, keyIndex) => {
    addItem(collector, {
      ...base,
      sourceIndex: channelIndex,
      ...(label !== undefined && keys.length > 1 ? { label: `${label} #${keyIndex + 1}` } : {}),
      payload: keyLine,
    })
  })
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/** `undefined` = 未给；`false` = 给错类型。 */
function optionalStringField(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * new-api 的 `base_url` 是「源站」（`https://api.openai.com`），而 DizzyAPI 的
 * `baseUrl` 自带版本前缀（`https://api.openai.com/v1`）。
 *
 * 只给「路径为空或 `/`」的裸源站补 `/v1`；已经有路径的原样保留——那可能是
 * `/openai`、`/anthropic` 之类的自定义前缀，补上去反而会拼出错误的 URL。
 */
function readChannelBaseUrl(value: string | undefined | false): string | undefined | false {
  if (value === undefined || value === false) return value
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const trimmed = value.replace(/\/+$/, '')
  if (url.pathname !== '' && url.pathname !== '/') return trimmed
  return `${trimmed}/v1`
}

/** `undefined` = 未声明（不参与过滤）；`false` = 形状非法。 */
function readModels(value: unknown): string[] | undefined | false {
  if (value === undefined || value === null) return undefined
  let parts: string[]
  if (typeof value === 'string') {
    parts = value.split(',')
  } else if (Array.isArray(value)) {
    if (value.some((item) => typeof item !== 'string')) return false
    parts = value as string[]
  } else {
    return false
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const name = part.trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result.length === 0 ? undefined : result
}

/** `undefined` = 未声明；`false` = 形状非法。 */
function readModelMap(value: unknown): Record<string, string> | undefined | false {
  if (value === undefined || value === null || value === '') return undefined
  let parsed: unknown = value
  if (typeof value === 'string') {
    parsed = tryJson(value)
    if (parsed === undefined) return false
  }
  if (!isRecord(parsed)) return false
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== 'string') return false
    const key = rawKey.trim()
    const mapped = rawValue.trim()
    if (key === '' || mapped === '') continue
    result[key] = mapped
  }
  return Object.keys(result).length === 0 ? undefined : result
}

function readPriority(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : readInteger(value)
  if (parsed === undefined || !Number.isFinite(parsed)) return undefined
  return Math.max(0, Math.min(1000, Math.trunc(parsed)))
}

/** new-api：1 = 启用，0 / 2 / 3 = 停用；其它值不猜。 */
function readStatus(value: unknown): boolean | undefined {
  const parsed = typeof value === 'number' ? value : readInteger(value)
  if (parsed === 1) return true
  if (parsed === 0 || parsed === 2 || parsed === 3) return false
  return undefined
}

// ───────────────────────────────── sub2api ─────────────────────────────────

function parseSub2Api(payload: string): ParsedImportSource {
  const parsed = tryJson(payload.trim())
  if (!isRecord(parsed) || parsed.type !== 'sub2api-data') {
    fail('ACCOUNT_IMPORT_SOURCE_INVALID', 'sub2api 导入的 type 必须是 sub2api-data')
  }
  if (!Array.isArray(parsed.accounts)) {
    fail('ACCOUNT_IMPORT_SOURCE_INVALID', 'sub2api 导入必须包含 accounts 数组')
  }
  if (parsed.accounts.length === 0) fail('ACCOUNT_IMPORT_FIELD_INVALID', '没有可导入的账号')

  const collector = collectorOf('sub2api')
  parsed.accounts.forEach((raw, accountIndex) => parseSub2ApiAccount(collector, raw, accountIndex))
  return finish(collector)
}

function parseSub2ApiAccount(collector: Collector, raw: unknown, accountIndex: number): void {
  const position = accountIndex + 1
  if (!isRecord(raw)) {
    addIssue(collector, accountIndex, 'ACCOUNT_IMPORT_FIELD_INVALID', `第 ${position} 项必须是对象`)
    return
  }

  const platform = nonEmptyString(raw.platform)
  let provider: AccountProvider
  if (platform === 'anthropic') provider = 'claude'
  else if (platform === 'openai') provider = 'openai'
  else {
    addIssue(
      collector,
      accountIndex,
      'ACCOUNT_IMPORT_UNSUPPORTED_PLATFORM',
      `第 ${position} 项的 platform ${platform === undefined ? '缺失' : '不受支持'}（只支持 anthropic / openai）`,
    )
    return
  }

  const rawType = nonEmptyString(raw.type)
  const kind: AccountKind | undefined =
    rawType === 'oauth' ? 'oauth' : rawType === 'apikey' || rawType === 'api_key' ? 'api_key' : undefined
  if (kind === undefined) {
    addIssue(
      collector,
      accountIndex,
      'ACCOUNT_IMPORT_UNSUPPORTED_TYPE',
      `第 ${position} 项的 type ${rawType === undefined ? '缺失' : '不受支持'}（只支持 oauth / apikey）`,
    )
    return
  }

  const credentials = raw.credentials
  if (!isRecord(credentials)) {
    addIssue(collector, accountIndex, 'ACCOUNT_IMPORT_FIELD_INVALID', `第 ${position} 项缺少 credentials 对象`)
    return
  }

  let credentialPayload: string
  if (kind === 'oauth') {
    const accessToken = nonEmptyString(credentials.access_token)
    if (accessToken === undefined) {
      addIssue(
        collector,
        accountIndex,
        'ACCOUNT_IMPORT_FIELD_INVALID',
        `第 ${position} 项的 credentials 缺少 access_token`,
      )
      return
    }
    const refreshToken = nonEmptyString(credentials.refresh_token)
    const expiresAt = credentials.expires_at
    credentialPayload = JSON.stringify({
      access_token: accessToken,
      ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
      ...(expiresAt === undefined || expiresAt === null ? {} : { expires_at: expiresAt }),
    })
  } else {
    const apiKey = nonEmptyString(credentials.api_key)
    if (apiKey === undefined) {
      addIssue(
        collector,
        accountIndex,
        'ACCOUNT_IMPORT_FIELD_INVALID',
        `第 ${position} 项的 credentials 缺少 api_key`,
      )
      return
    }
    credentialPayload = apiKey
  }

  const warnings: string[] = []
  for (const ignored of ['rate_multiplier', 'concurrency', 'proxy_id']) {
    if (raw[ignored] !== undefined && raw[ignored] !== null) {
      warnings.push(`第 ${position} 项忽略 ${ignored}`)
    }
  }

  const label = nonEmptyString(raw.name)
  const priority = readPriority(raw.priority)
  const protocol: AccountProtocol =
    provider === 'claude' ? 'anthropic' : kind === 'oauth' ? 'openai-responses' : 'openai-chat'

  addItem(collector, {
    sourceIndex: accountIndex,
    ...(label === undefined ? {} : { label }),
    provider,
    kind,
    protocol,
    ...(priority !== undefined ? { priority } : {}),
    payload: credentialPayload,
    warnings,
  })
}

// ───────────────────────────────── plain-keys ─────────────────────────────────

function parsePlainKeys(payload: string, defaults: AccountImportDefaults): ParsedImportSource {
  const lines = payload
    .split(/\r?\n/)
    .map((line, lineIndex) => ({ key: line.trim(), lineIndex }))
    .filter((entry) => entry.key !== '')
  if (lines.length === 0) fail('ACCOUNT_IMPORT_FIELD_INVALID', 'payload 里没有可导入的 key')

  const provider = defaults.provider ?? 'openai'
  const kind = defaults.kind ?? 'api_key'
  assertProviderKind(provider, kind)
  const protocol = defaults.protocol ?? 'openai-chat'

  const collector = collectorOf('plain-keys')
  lines.forEach((entry, index) => {
    addItem(collector, {
      sourceIndex: entry.lineIndex,
      ...(defaults.labelPrefix === undefined ? {} : { label: `${defaults.labelPrefix} #${index + 1}` }),
      provider,
      kind,
      protocol,
      ...(defaults.baseUrl === undefined ? {} : { baseUrl: defaults.baseUrl }),
      ...(defaults.enabled === undefined ? {} : { enabled: defaults.enabled }),
      payload: entry.key,
      warnings: [],
    })
  })
  return finish(collector)
}
