/**
 * 账号管理插件（服务名 `accountAdmin`）。
 *
 * 它是 identity 的**管理面门面**，不是第二个写者：
 * - 账号记录的持久化、令牌刷新、状态迁移全部委托给 identity（AGENTS.md D8 / D17）；
 * - 本插件没有存储、没有定时器、没有 HTTP 路由，禁用时只需回收服务本身（D5）；
 * - 返回给调用方的只有元数据与「凭据配没配」，令牌永远不出这层。
 *
 * 写操作要求显式 actor，且 actor 必须在 `adminPlugins` 白名单里（默认拒绝）。
 * 读操作（list / get / credentialStatus / previewImport）不限权——与 user / settings 一致。
 */
import { Service, type Context, type Logger } from 'cordis'
import { describeError } from '@dizzyapi/plugin-kit'
import {
  ACCOUNT_ADMIN_CONFIG_SCHEMA,
  ACCOUNT_ADMIN_DEFAULTS,
  type ResolvedAccountAdminConfig,
} from './config.ts'
import { AccountAdminError, errorCodeOf } from './errors.ts'
import {
  assertProviderKind,
  normalizeFormatHint,
  normalizeKindHint,
  normalizeProviderHint,
  parseCredentialImport,
  previewCredentialImport,
  type CredentialBundle,
  type ParsedCredential,
} from './importers.ts'
import type {
  AccountKind,
  AccountListQuery,
  AccountProvider,
  AccountRecord,
  AccountStatus,
  AccountView,
  BulkImportDefaults,
  BulkImportInput,
  BulkImportItemResult,
  BulkImportResult,
  CreateAccountInput,
  CredentialImportFormat,
  CredentialImportInput,
  CredentialImportPreview,
  ImportCredentialsInput,
  UpdateAccountInput,
} from './types.ts'

/** identity 的结构性视图：只声明管理面用到的写口，不 import 它的实现包。 */
interface IdentitySeam {
  list(): AccountRecord[]
  get(id: string): AccountRecord
  create(input: {
    readonly provider: AccountProvider
    readonly kind: AccountKind
    readonly label: string
    readonly email?: string
    readonly subject?: string
    readonly enabled?: boolean
    readonly secret?: CredentialBundle
  }): Promise<AccountRecord>
  update(
    id: string,
    patch: {
      readonly label?: string
      readonly email?: string | null
      readonly subject?: string | null
      readonly enabled?: boolean
    },
  ): Promise<AccountRecord>
  importCredentials(id: string, secret: CredentialBundle): Promise<AccountRecord>
  remove(id: string): Promise<void>
  credentialStatus(id: string): { readonly ref: string; readonly configured: boolean }
  refreshNow(id: string): Promise<AccountRecord>
}

const ACTOR_MAX_LENGTH = 200
const ID_MAX_LENGTH = 100
const LABEL_MAX_LENGTH = 200
const EMAIL_MAX_LENGTH = 320
const SUBJECT_MAX_LENGTH = 200
const SEARCH_MAX_LENGTH = 200

const QUERY_KEYS = ['provider', 'kind', 'enabled', 'status', 'search'] as const
const UPDATE_KEYS = ['label', 'email', 'subject'] as const
const BULK_DEFAULT_KEYS = ['format', 'provider', 'kind', 'enabled', 'labelPrefix'] as const

export class AccountAdminService extends Service {
  static Config = ACCOUNT_ADMIN_CONFIG_SCHEMA
  /** identity 是唯一的数据写者；它不在运行时，本插件也不该在（D16 的「依赖是否满足」）。 */
  static inject = ['identity']

  readonly config: ResolvedAccountAdminConfig
  private readonly adminPlugins: readonly string[]
  private readonly maxBatchSize: number
  private readonly logger: Logger

  constructor(ctx: Context, config: ResolvedAccountAdminConfig = {}) {
    super(ctx, 'accountAdmin')
    this.config = config
    this.adminPlugins = config.adminPlugins ?? ACCOUNT_ADMIN_DEFAULTS.adminPlugins
    this.maxBatchSize = config.maxBatchSize ?? ACCOUNT_ADMIN_DEFAULTS.maxBatchSize
    this.logger = ctx.logger('account-admin')

    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 1000) {
      throw new AccountAdminError('ACCOUNT_ADMIN_INPUT_INVALID', 'maxBatchSize 必须是 1–1000 的整数')
    }

    this.logger.info(
      `账号管理插件已装载：可管理账号的插件 ${this.adminPlugins.join(' / ') || '（无）'}；` +
        `批量导入上限 ${this.maxBatchSize}；账号与令牌仍由 identity 独占写入`,
    )
    if (this.adminPlugins.length === 0) {
      this.logger.warn('adminPlugins 为空：当前没有任何插件可以新建 / 修改 / 删除账号或导入凭据')
    }
  }

  // ───────────────────────────── 读面：不限权 ─────────────────────────────

  list(query: AccountListQuery = {}): AccountView[] {
    const filter = query === undefined ? {} : normalizeQuery(query)
    const identity = this.identity()
    return identity
      .list()
      .filter((account) => matches(account, filter))
      .map((account) => toView(account, identity.credentialStatus(account.id).configured))
  }

  get(id: string): AccountView {
    const accountId = normalizeId(id)
    const identity = this.identity()
    return toView(identity.get(accountId), identity.credentialStatus(accountId).configured)
  }

  /** 只回答「配没配」，不返回值——与 identity / credentials 的口径一致。 */
  credentialStatus(id: string): { readonly ref: string; readonly configured: boolean } {
    return this.identity().credentialStatus(normalizeId(id))
  }

  /** 导入预检：识别格式与元数据，不落盘、不返回令牌本体。 */
  previewImport(input: CredentialImportInput): CredentialImportPreview {
    return previewCredentialImport(input)
  }

  // ───────────────────────────── 写面：仅限白名单 ─────────────────────────────

  async create(actor: string, input: CreateAccountInput): Promise<AccountView> {
    this.assertAdmin(actor)
    if (!isRecord(input)) failInput('create 参数必须是对象')

    const provider = requireProvider(input.provider)
    const kind = requireKind(input.kind)
    assertProviderKind(provider, kind)
    const label = normalizeLabel(input.label)
    const enabled = normalizeOptionalBoolean(input.enabled, 'enabled')

    let parsed: ParsedCredential | undefined
    if (input.credential !== undefined) {
      if (!isRecord(input.credential)) failInput('credential 必须是对象')
      const credential = input.credential as unknown as CredentialImportInput
      // 账号的 provider / kind 是权威；credential 里重复声明且不一致，多半是调用方搞错了。
      if (credential.provider !== undefined && credential.provider !== provider) {
        throw new AccountAdminError(
          'ACCOUNT_ADMIN_IMPORT_CONFLICT',
          `credential.provider 是 ${String(credential.provider)}，与账号的 ${provider} 不一致`,
        )
      }
      if (credential.kind !== undefined && credential.kind !== kind) {
        throw new AccountAdminError(
          'ACCOUNT_ADMIN_IMPORT_CONFLICT',
          `credential.kind 是 ${String(credential.kind)}，与账号的 ${kind} 不一致`,
        )
      }
      parsed = parseCredentialImport({ ...credential, provider, kind })
    }

    const email = normalizeOptionalText(input.email, 'email', EMAIL_MAX_LENGTH) ?? parsed?.email ?? undefined
    const subject =
      normalizeOptionalText(input.subject, 'subject', SUBJECT_MAX_LENGTH) ?? parsed?.subject ?? undefined

    const identity = this.identity()
    const account = await identity.create({
      provider,
      kind,
      label,
      ...(email !== undefined ? { email } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(parsed !== undefined ? { secret: parsed.bundle } : {}),
    })
    return toView(account, identity.credentialStatus(account.id).configured)
  }

  /**
   * 只改非秘密元数据。启用 / 停用走独立的 enable / disable，
   * 因此这里会把 `enabled` 之类的键明确拒绝，而不是静默忽略。
   */
  async update(actor: string, id: string, patch: UpdateAccountInput): Promise<AccountView> {
    this.assertAdmin(actor)
    const accountId = normalizeId(id)
    if (!isRecord(patch)) failInput('update 参数必须是对象')
    for (const key of Object.keys(patch)) {
      if (!(UPDATE_KEYS as readonly string[]).includes(key)) {
        failInput(`update 不支持字段 ${key}；启用 / 停用请用 enable / disable`)
      }
    }

    const normalized: { label?: string; email?: string | null; subject?: string | null } = {}
    if ('label' in patch) normalized.label = normalizeLabel(patch.label)
    if ('email' in patch) normalized.email = normalizeNullableText(patch.email, 'email', EMAIL_MAX_LENGTH)
    if ('subject' in patch) normalized.subject = normalizeNullableText(patch.subject, 'subject', SUBJECT_MAX_LENGTH)

    // 空 patch 是幂等的读：不制造一次无意义的写盘与 updatedAt 变化。
    if (Object.keys(normalized).length === 0) return this.get(accountId)

    const identity = this.identity()
    const account = await identity.update(accountId, normalized)
    return toView(account, identity.credentialStatus(account.id).configured)
  }

  async remove(actor: string, id: string): Promise<void> {
    this.assertAdmin(actor)
    await this.identity().remove(normalizeId(id))
  }

  async enable(actor: string, id: string): Promise<AccountView> {
    this.assertAdmin(actor)
    return this.setEnabled(normalizeId(id), true)
  }

  async disable(actor: string, id: string): Promise<AccountView> {
    this.assertAdmin(actor)
    return this.setEnabled(normalizeId(id), false)
  }

  /** 向已有账号导入 / 重新授权凭据。provider / kind 由账号本身决定。 */
  async importCredentials(actor: string, id: string, input: ImportCredentialsInput): Promise<AccountView> {
    this.assertAdmin(actor)
    const accountId = normalizeId(id)
    if (!isRecord(input)) failInput('importCredentials 参数必须是对象')
    const identity = this.identity()
    const account = identity.get(accountId)
    const parsed = parseCredentialImport({
      ...(input.format !== undefined ? { format: input.format } : {}),
      payload: input.payload,
      provider: account.provider,
      kind: account.kind,
    })
    const updated = await identity.importCredentials(accountId, parsed.bundle)

    // 凭据里能解出的元数据（如 OpenAI id_token 的 email / account_id）只补空，
    // 不覆盖管理员已经手填的值。先写凭据再补元数据：即使这里失败，令牌也已经生效。
    const metadata: { email?: string; subject?: string } = {}
    if (account.email === null && parsed.email !== null) metadata.email = parsed.email
    if (account.subject === null && parsed.subject !== null) metadata.subject = parsed.subject
    const final = Object.keys(metadata).length === 0 ? updated : await identity.update(accountId, metadata)
    return toView(final, identity.credentialStatus(final.id).configured)
  }

  /**
   * 批量导入。每一项独立解析、独立创建：坏条目只影响它自己的结果，
   * 不会回滚已经成功的条目，也不阻塞后面的条目。
   */
  async importAccounts(actor: string, input: BulkImportInput): Promise<BulkImportResult> {
    this.assertAdmin(actor)
    if (!isRecord(input)) failInput('importAccounts 参数必须是对象')
    if (!Array.isArray(input.items)) failInput('items 必须是数组')
    if (input.items.length === 0) failInput('items 不能为空')
    if (input.items.length > this.maxBatchSize) {
      throw new AccountAdminError(
        'ACCOUNT_ADMIN_IMPORT_TOO_LARGE',
        `一次最多导入 ${this.maxBatchSize} 项，收到 ${input.items.length} 项`,
      )
    }

    const defaults = normalizeBulkDefaults(input.defaults)
    const identity = this.identity()
    const results: BulkImportItemResult[] = []

    for (let index = 0; index < input.items.length; index += 1) {
      try {
        const result = await this.importOne(identity, input.items[index], defaults, index)
        results.push({ index, ok: true, account: result, error: null })
      } catch (error) {
        results.push({
          index,
          ok: false,
          account: null,
          error: { code: errorCodeOf(error), message: describeError(error) },
        })
      }
    }

    const created = results.filter((item) => item.ok).length
    return {
      total: results.length,
      created,
      failed: results.length - created,
      items: results,
    }
  }

  /** 手动触发一次刷新；真正的 RT 交换与状态迁移仍在 identity（D18）。 */
  async refresh(actor: string, id: string): Promise<AccountView> {
    this.assertAdmin(actor)
    const accountId = normalizeId(id)
    const identity = this.identity()
    const account = await identity.refreshNow(accountId)
    return toView(account, identity.credentialStatus(account.id).configured)
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  private async importOne(
    identity: IdentitySeam,
    item: unknown,
    defaults: BulkImportDefaults,
    index: number,
  ): Promise<AccountView> {
    if (!isRecord(item)) failInput(`第 ${index + 1} 项必须是对象`)

    const format = item.format !== undefined ? item.format : defaults.format
    const provider = item.provider !== undefined ? item.provider : defaults.provider
    const kind = item.kind !== undefined ? item.kind : defaults.kind

    const parsed = parseCredentialImport({
      ...(format !== undefined ? { format: format as CredentialImportFormat } : {}),
      payload: item.payload as CredentialImportInput['payload'],
      ...(provider !== undefined ? { provider: provider as AccountProvider } : {}),
      ...(kind !== undefined ? { kind: kind as AccountKind } : {}),
    })

    const label =
      item.label !== undefined
        ? normalizeLabel(item.label)
        : defaults.labelPrefix !== undefined
          ? normalizeLabel(`${defaults.labelPrefix} #${index + 1}`)
          : normalizeLabel(parsed.email ?? defaultLabel(parsed))

    const email =
      (item.email !== undefined
        ? normalizeOptionalText(item.email, 'email', EMAIL_MAX_LENGTH)
        : undefined) ?? parsed.email ?? undefined
    const subject =
      (item.subject !== undefined
        ? normalizeOptionalText(item.subject, 'subject', SUBJECT_MAX_LENGTH)
        : undefined) ?? parsed.subject ?? undefined
    const enabled =
      item.enabled !== undefined
        ? normalizeOptionalBoolean(item.enabled, 'enabled')
        : defaults.enabled

    const account = await identity.create({
      provider: parsed.provider,
      kind: parsed.kind,
      label,
      ...(email !== undefined ? { email } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      secret: parsed.bundle,
    })
    return toView(account, identity.credentialStatus(account.id).configured)
  }

  private async setEnabled(accountId: string, enabled: boolean): Promise<AccountView> {
    const identity = this.identity()
    const account = await identity.update(accountId, { enabled })
    return toView(account, identity.credentialStatus(account.id).configured)
  }

  private identity(): IdentitySeam {
    const service = this.ctx.get('identity', false)
    if (service === undefined || service === null) {
      throw new AccountAdminError(
        'ACCOUNT_ADMIN_IDENTITY_UNAVAILABLE',
        'identity 服务不可用；账号管理依赖它持久化账号与刷新令牌',
      )
    }
    return service as unknown as IdentitySeam
  }

  private assertAdmin(actor: string): void {
    const name = normalizeActor(actor)
    if (!this.adminPlugins.includes(name)) {
      throw new AccountAdminError(
        'ACCOUNT_ADMIN_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权管理账号（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }
}

// ───────────────────────────────── 视图 ─────────────────────────────────

/**
 * 显式逐字段复制：不 spread identity 的记录。
 * 这样将来 identity 的记录里即使多出一个字段，也不会自动漏到管理面。
 */
function toView(account: AccountRecord, credentialConfigured: boolean): AccountView {
  return {
    id: account.id,
    provider: account.provider,
    kind: account.kind,
    label: account.label,
    enabled: account.enabled,
    status: account.status,
    credentialRef: account.credentialRef,
    email: account.email,
    subject: account.subject,
    accessExpiresAt: account.accessExpiresAt,
    refreshDueAt: account.refreshDueAt,
    lastRefreshAt: account.lastRefreshAt,
    lastError: account.lastError,
    failureCount: account.failureCount,
    backoffUntil: account.backoffUntil,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    credentialConfigured,
  }
}

function matches(account: AccountRecord, query: AccountListQuery): boolean {
  if (query.provider !== undefined && account.provider !== query.provider) return false
  if (query.kind !== undefined && account.kind !== query.kind) return false
  if (query.enabled !== undefined && account.enabled !== query.enabled) return false
  if (query.status !== undefined && account.status !== query.status) return false
  if (query.search !== undefined) {
    const haystack = [account.id, account.label, account.email ?? '', account.subject ?? '']
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(query.search)) return false
  }
  return true
}

function defaultLabel(parsed: ParsedCredential): string {
  const name = parsed.provider === 'claude' ? 'Claude' : parsed.provider === 'openai' ? 'OpenAI' : '外部 API'
  return parsed.kind === 'oauth' ? `${name} 订阅` : `${name} API key`
}

// ───────────────────────────────── 校验 ─────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failInput(message: string): never {
  throw new AccountAdminError('ACCOUNT_ADMIN_INPUT_INVALID', message)
}

function normalizeActor(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AccountAdminError('ACCOUNT_ADMIN_ACTOR_REQUIRED', '调用方必须声明自己的插件名')
  }
  const name = value.trim()
  if (name.length > ACTOR_MAX_LENGTH) {
    throw new AccountAdminError('ACCOUNT_ADMIN_ACTOR_REQUIRED', `插件名最长 ${ACTOR_MAX_LENGTH} 个字符`)
  }
  return name
}

function normalizeId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    failInput('账号 id 必须是非空字符串')
  }
  const id = value.trim()
  if (id.length > ID_MAX_LENGTH) failInput(`账号 id 最长 ${ID_MAX_LENGTH} 个字符`)
  return id
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') failInput('label 必须是字符串')
  const label = value.trim()
  if (label === '') failInput('label 不能为空')
  if (label.length > LABEL_MAX_LENGTH) failInput(`label 最长 ${LABEL_MAX_LENGTH} 个字符`)
  rejectControlCharacters(label, 'label')
  return label
}

function normalizeOptionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') failInput(`${field} 必须是字符串`)
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > max) failInput(`${field} 最长 ${max} 个字符`)
  rejectControlCharacters(text, field)
  return text
}

function normalizeNullableText(value: unknown, field: string, max: number): string | null {
  if (value === null) return null
  const text = normalizeOptionalText(value, field, max)
  return text ?? null
}

function normalizeOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') failInput(`${field} 必须是布尔值`)
  return value
}

function requireProvider(value: unknown): AccountProvider {
  const provider = normalizeProviderHint(value)
  if (provider === undefined) failInput('provider 必填（claude / openai / custom）')
  return provider
}

function requireKind(value: unknown): AccountKind {
  const kind = normalizeKindHint(value)
  if (kind === undefined) failInput('kind 必填（oauth / api_key）')
  return kind
}

function normalizeQuery(value: unknown): AccountListQuery {
  if (!isRecord(value)) failInput('查询条件必须是对象')
  for (const key of Object.keys(value)) {
    if (!(QUERY_KEYS as readonly string[]).includes(key)) failInput(`不支持的查询条件：${key}`)
  }

  const provider = normalizeProviderHint(value.provider)
  const kind = normalizeKindHint(value.kind)
  const enabled = normalizeOptionalBoolean(value.enabled, 'enabled')

  let status: AccountStatus | undefined
  if (value.status !== undefined) {
    if (value.status !== 'active' && value.status !== 'needs_reauth') {
      failInput('status 只能是 active / needs_reauth')
    }
    status = value.status
  }

  let search: string | undefined
  if (value.search !== undefined) {
    if (typeof value.search !== 'string') failInput('search 必须是字符串')
    const text = value.search.trim().toLowerCase()
    if (text.length > SEARCH_MAX_LENGTH) failInput(`search 最长 ${SEARCH_MAX_LENGTH} 个字符`)
    search = text === '' ? undefined : text
  }

  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(search !== undefined ? { search } : {}),
  }
}

function normalizeBulkDefaults(value: unknown): BulkImportDefaults {
  if (value === undefined) return {}
  if (!isRecord(value)) failInput('defaults 必须是对象')
  for (const key of Object.keys(value)) {
    if (!(BULK_DEFAULT_KEYS as readonly string[]).includes(key)) {
      failInput(`defaults 不支持字段 ${key}`)
    }
  }

  const format = normalizeFormatHint(value.format)
  const provider = normalizeProviderHint(value.provider)
  const kind = normalizeKindHint(value.kind)
  const enabled = normalizeOptionalBoolean(value.enabled, 'enabled')
  const labelPrefix = normalizeOptionalText(value.labelPrefix, 'labelPrefix', LABEL_MAX_LENGTH)

  return {
    ...(format !== undefined ? { format } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(labelPrefix !== undefined ? { labelPrefix } : {}),
  }
}

function rejectControlCharacters(value: string, field: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) failInput(`${field} 不得包含控制字符`)
}
