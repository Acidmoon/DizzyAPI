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
import { parseImportSource } from './import-sources.ts'
import {
  resolveTestBaseUrl,
  resolveTestModel,
  resolveTestProtocol,
  runConnectionTest,
} from './test-connection.ts'
import type {
  AccountHealth,
  AccountImportPreview,
  AccountImportPreviewItem,
  AccountImportSourceInput,
  AccountKind,
  AccountListItem,
  AccountListOptions,
  AccountListQuery,
  AccountProvider,
  AccountProtocol,
  AccountRecord,
  AccountStatus,
  AccountView,
  BulkImportDefaults,
  BulkImportInput,
  BulkImportItem,
  BulkImportItemResult,
  BulkImportResult,
  BulkOperationItemResult,
  BulkOperationResult,
  BulkUpdateInput,
  CreateAccountInput,
  ParsedImportItem,
  CredentialImportFormat,
  CredentialImportInput,
  CredentialImportPreview,
  ImportCredentialsInput,
  AccountTestInput,
  AccountTestResult,
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
    readonly baseUrl?: string
    readonly protocol?: AccountProtocol
    readonly models?: string[]
    readonly modelMap?: Record<string, string>
    /** 客户端指纹档案 id（`clientMask` 里的一档）；不传 = 不伪装。 */
    readonly clientProfile?: string
    readonly priority?: number
    readonly enabled?: boolean
    readonly secret?: CredentialBundle
  }): Promise<AccountRecord>
  update(
    id: string,
    patch: {
      readonly label?: string
      readonly email?: string | null
      readonly subject?: string | null
      readonly baseUrl?: string | null
      readonly protocol?: AccountProtocol | null
      readonly models?: string[] | null
      readonly modelMap?: Record<string, string> | null
      /** `null` = 清空为「不伪装」。 */
      readonly clientProfile?: string | null
      readonly priority?: number
      readonly labels?: string[] | null
      readonly weight?: number | null
      readonly concurrency?: number | null
      readonly enabled?: boolean
    },
  ): Promise<AccountRecord>
  /** 健康状态：与通用 update 分开，语义不同（调度输入，不是人改的字段）。 */
  setHealth(id: string, health: AccountHealth): Promise<AccountRecord>
  /** 系统自动停用：只改 status → auto_disabled，不动 enabled。 */
  autoDisable(id: string, reason: string): Promise<AccountRecord>
  /** 系统自动恢复：只把 auto_disabled 改回 active。 */
  autoEnable(id: string): Promise<AccountRecord>
  /** 最近使用时间回报；只前进不后退，未知账号 no-op。 */
  reportUsed(id: string, at: string): Promise<void>
  importCredentials(id: string, secret: CredentialBundle): Promise<AccountRecord>
  remove(id: string): Promise<void>
  credentialStatus(id: string): { readonly ref: string; readonly configured: boolean }
  refreshNow(id: string): Promise<AccountRecord>
  /** 进程内 seam：返回可用令牌；**不得**挂 HTTP。 */
  getAccessToken(id: string): Promise<string>
  /** 只写运营元数据（lastTest*），不发 identity/account-updated。 */
  recordTestResult(
    id: string,
    result: { readonly ok: boolean; readonly latencyMs: number; readonly error: string | null; readonly testedAt: string },
  ): Promise<AccountRecord>
}

const ACTOR_MAX_LENGTH = 200
const ID_MAX_LENGTH = 100
const LABEL_MAX_LENGTH = 200
const EMAIL_MAX_LENGTH = 320
const SUBJECT_MAX_LENGTH = 200
const SEARCH_MAX_LENGTH = 200
/** 客户端档案 id 的长度上限（与 identity 侧的归一化口径一致，宽松一点无妨）。 */
const CLIENT_PROFILE_MAX_LENGTH = 128

const QUERY_KEYS = ['provider', 'kind', 'enabled', 'status', 'search', 'labels', 'health'] as const
const UPDATE_KEYS = [
  'label',
  'email',
  'subject',
  'baseUrl',
  'protocol',
  'models',
  'modelMap',
  'clientProfile',
  'priority',
  'labels',
  'weight',
  'concurrency',
] as const
const BULK_DEFAULT_KEYS = ['format', 'provider', 'kind', 'enabled', 'labelPrefix'] as const

/**
 * 用量事件 → `lastUsedAt` 的节流窗口。
 *
 * `accounts.json` 是整文件原子重写，用量却是持续的：30 秒聚合一次，
 * 既能让「最近使用」足够新，也不会把磁盘打成热写。
 */
const USAGE_REPORT_THROTTLE_MS = 30_000

/** root 事件总线的结构视图：只声明监听用，不 import cordis 的实现细节。 */
interface EventRoot {
  on(
    name: string,
    listener: (...args: unknown[]) => void,
    options?: { global?: boolean },
  ): () => void
}

export class AccountAdminService extends Service {
  static Config = ACCOUNT_ADMIN_CONFIG_SCHEMA
  /** identity 是唯一的数据写者；它不在运行时，本插件也不该在（D16 的「依赖是否满足」）。 */
  static inject = ['identity']

  /** 能力清单：管理门面本身不落盘、不发事件、不暴露桥命令。 */
  static catalog = {
    capabilities: [
      'account-management',
      'credential-import',
      'upstream-account-admin',
      'account-connectivity-test',
      'account-import-source',
      'account-bulk-update',
      'account-health-management',
      'account-last-used-report',
    ],
    events: [],
    bridge: [],
    storage: [],
    methods: {
      testConnection: {
        description:
          '发一个真实的最小请求验证连通性；凭据走 identity.getAccessToken（进程内），结果落 lastTest*',
      },
      previewImportSource: { description: '把 new-api / sub2api / 纯 key 文本归一化并逐条预检，不含凭据' },
      importSource: { description: '按导入来源批量创建账号；部分成功，逐条返回错误' },
      bulkUpdate: { description: '批量改标签 / 权重 / 并发等字段；只提交声明过的字段，逐项返回结果' },
      bulkEnable: { description: '批量启用（人的手动开关），逐项返回结果' },
      bulkDisable: { description: '批量停用（人的手动开关），逐项返回结果' },
      setHealth: { description: '写入健康状态；Go 侧 Filter.Health 会用它过滤候选' },
      autoDisable: { description: '健康检查连续失败后自动停用：只改 status，不动 enabled' },
      autoEnable: { description: '健康恢复后自动启用：只把 auto_disabled 改回 active' },
      flushUsage: {
        description:
          '把 usage/account-used 事件聚合出的 lastUsedAt 立即写回 identity（节流窗口默认 30 秒）',
      },
    },
    shapes: {
      AccountView: {
        description: '管理面返回的账号元数据（不含令牌）',
        fields: {
          id: { type: 'string' },
          provider: { type: 'string' },
          kind: { type: 'string' },
          label: { type: 'string' },
          enabled: { type: 'boolean' },
          status: { type: 'string' },
          credentialRef: { type: 'string' },
          credentialConfigured: { type: 'boolean' },
          email: { type: 'string', optional: true },
          subject: { type: 'string', optional: true },
          baseUrl: { type: 'string', optional: true },
          protocol: { type: 'string', optional: true },
          models: { type: 'array<string>', optional: true },
          modelMap: { type: 'map<string, string>', optional: true },
          priority: { type: 'number' },
          labels: { type: 'array<string>' },
          weight: { type: 'number', optional: true },
          concurrency: { type: 'number', optional: true },
          health: { type: 'string' },
          autoDisabledAt: { type: 'string', optional: true },
          autoDisabledReason: { type: 'string', optional: true },
          lastUsedAt: { type: 'string', optional: true },
          lastTestAt: { type: 'string', optional: true },
          lastTestOk: { type: 'boolean', optional: true },
          lastTestError: { type: 'string', optional: true },
          lastTestLatencyMs: { type: 'number', optional: true },
        },
      },
      CredentialImportPreview: {
        description: '导入预检结果：只有识别信息与布尔位，没有令牌',
        fields: {
          format: { type: 'string' },
          provider: { type: 'string' },
          kind: { type: 'string' },
          email: { type: 'string', optional: true },
          subject: { type: 'string', optional: true },
          expiresAt: { type: 'string', optional: true },
          hasAccessToken: { type: 'boolean' },
          hasRefreshToken: { type: 'boolean' },
          hasApiKey: { type: 'boolean' },
        },
      },
    },
  } as const

  readonly config: ResolvedAccountAdminConfig
  private readonly adminPlugins: readonly string[]
  private readonly maxBatchSize: number
  private readonly logger: Logger
  /** 测试可替换；生产用全局 fetch。 */
  private fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init)
  /** 待汇报的 `lastUsedAt`：accountId → 最近一次使用时间（ISO）。 */
  private readonly pendingUsage = new Map<string, string>()
  private usageTimer: NodeJS.Timeout | undefined
  private disposed = false

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

  /**
   * 监听用量事件并节流汇报 `lastUsedAt`。
   *
   * 为什么经本插件转一手：`usage` 落库后只知道「哪些账号刚被用过」，而账号记录的写者是
   * identity；`accounts.json` 是整文件原子重写，不能为每条用量写一次盘。所以这里聚合并
   * 节流（`USAGE_REPORT_THROTTLE_MS`），再经 identity 的 `reportUsed` 写回。
   *
   * 监听器挂在 root 上并带 global（与 account-priority 的 watch 同一写法）；
   * 摘除函数由 `[Service.init]` 生成器 `yield` 出去，和 `ctx.effect` 一样随插件卸载回收（D5）：
   * 禁用后不再接收事件，也不留定时器。
   */
  async *[Service.init](): AsyncGenerator<() => void> {
    const root = this.ctx.root as unknown as EventRoot
    const off = root.on(
      'usage/account-used',
      (...args: unknown[]) => this.noteAccountUsage(args[0]),
      { global: true },
    )
    yield () => {
      this.disposed = true
      off()
      this.clearUsageTimer()
      // 卸载不带病回填：最多丢掉一个节流窗口内的 lastUsedAt 精度。
      this.pendingUsage.clear()
    }
  }

  // ───────────────────────────── 读面：不限权 ─────────────────────────────

  list(query?: AccountListQuery): AccountView[]
  list(query: AccountListQuery, options: { view: 'full' }): AccountView[]
  list(query: AccountListQuery, options: { view: 'lite' }): AccountListItem[]
  list(query: AccountListQuery, options: AccountListOptions): AccountView[] | AccountListItem[]
  list(query: AccountListQuery = {}, options: AccountListOptions = {}): AccountView[] | AccountListItem[] {
    const filter = query === undefined ? {} : normalizeQuery(query)
    const view = normalizeListView(options)
    const identity = this.identity()
    return identity
      .list()
      .filter((account) => matches(account, filter))
      .map((account) => {
        const configured = identity.credentialStatus(account.id).configured
        return view === 'lite' ? toListItem(account, configured) : toView(account, configured)
      })
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

  /**
   * 连通性测试：凭据只经 identity.getAccessToken 读取（进程内 seam），
   * 测试结果落 lastTest*。上游失败也是结果对象；配置缺失才抛错。
   */
  async testConnection(id: string, input: AccountTestInput = {}): Promise<AccountTestResult> {
    const accountId = normalizeId(id)
    const params = normalizeTestInput(input)
    const identity = this.identity()
    const account = identity.get(accountId)

    // 配置错误先于取令牌失败：custom 没有 baseUrl 这类问题不需要去碰凭据。
    const protocol = resolveTestProtocol(account, params.protocol)
    const model = resolveTestModel(account, params.model)
    resolveTestBaseUrl(account)

    let token: string
    try {
      token = await identity.getAccessToken(accountId)
    } catch (error) {
      const result: AccountTestResult = {
        ok: false,
        status: null,
        latencyMs: 0,
        model,
        protocol,
        error: `${errorCodeOf(error)}：${describeError(error)}`,
        testedAt: new Date().toISOString(),
      }
      await this.persistTestResult(identity, accountId, result)
      return result
    }

    const result = await runConnectionTest(
      {
        provider: account.provider,
        baseUrl: account.baseUrl,
        protocol: account.protocol,
        models: account.models,
      },
      token,
      params,
      { fetch: this.fetchImpl },
    )
    await this.persistTestResult(identity, accountId, result)
    return result
  }

  /** 导入来源预检：逐条归一化，不含凭据；单条失败不影响其它条。 */
  previewImportSource(input: AccountImportSourceInput): AccountImportPreview {
    const parsed = parseImportSource(normalizeImportSourceInput(input))
    const items: AccountImportPreviewItem[] = [
      ...parsed.items.map((item) => ({
        index: item.index,
        ok: true,
        label: item.label ?? null,
        provider: item.provider,
        kind: item.kind,
        baseUrl: item.baseUrl ?? null,
        models: item.models ?? null,
        error: null,
      })),
      ...parsed.issues.map((issue) => ({
        index: issue.index,
        ok: false,
        label: null,
        provider: null,
        kind: null,
        baseUrl: null,
        models: null,
        error: issue.message,
      })),
    ].sort((left, right) => left.index - right.index)

    return { source: parsed.source, total: items.length, items }
  }

  /**
   * 按导入来源批量创建账号：复用 `importAccounts` 的逐条语义（部分成功 + 每项 error），
   * 并把每个 item 的 baseUrl / protocol / models / modelMap / priority 透传给 identity。
   */
  async importSource(actor: string, input: AccountImportSourceInput): Promise<BulkImportResult> {
    this.assertAdmin(actor)
    const parsed = parseImportSource(normalizeImportSourceInput(input))
    const total = parsed.items.length + parsed.issues.length
    if (total === 0) failInput('没有可导入的账号')
    if (total > this.maxBatchSize) {
      throw new AccountAdminError(
        'ACCOUNT_ADMIN_IMPORT_TOO_LARGE',
        `一次最多导入 ${this.maxBatchSize} 项，收到 ${total} 项`,
      )
    }

    if (parsed.items.length === 0) {
      return {
        total,
        created: 0,
        failed: total,
        items: parsed.issues.map((issue) => ({
          index: issue.index,
          ok: false,
          account: null,
          error: { code: issue.code, message: issue.message },
        })),
      }
    }

    const bulk = await this.importAccounts(actor, {
      items: parsed.items.map(toBulkItem),
    })

    // importAccounts 的 index 是「有效项」的下标；这里映射回解析结果里的全局位置。
    const succeeded = new Map<number, BulkImportItemResult>()
    bulk.items.forEach((result, position) => {
      const parsedItem = parsed.items[position]
      if (parsedItem !== undefined) succeeded.set(parsedItem.index, { ...result, index: parsedItem.index })
    })
    const items: BulkImportItemResult[] = []
    for (let index = 0; index < total; index += 1) {
      const success = succeeded.get(index)
      if (success !== undefined) {
        items.push(success)
        continue
      }
      const issue = parsed.issues.find((entry) => entry.index === index)
      items.push({
        index,
        ok: false,
        account: null,
        error: issue === undefined
          ? { code: 'ACCOUNT_ADMIN_UNKNOWN', message: '导入结果缺失' }
          : { code: issue.code, message: issue.message },
      })
    }
    const created = items.filter((item) => item.ok).length
    return { total, created, failed: total - created, items }
  }

  // ───────────────────────────── 写面：仅限白名单 ─────────────────────────────

  async create(actor: string, input: CreateAccountInput): Promise<AccountView> {
    this.assertAdmin(actor)
    if (!isRecord(input)) failInput('create 参数必须是对象')

    const provider = requireProvider(input.provider)
    const kind = requireKind(input.kind)
    assertProviderKind(provider, kind)
    const label = normalizeLabel(input.label)
    const baseUrl = normalizeOptionalBaseUrl(input.baseUrl)
    const protocol = normalizeOptionalProtocol(input.protocol)
    const models = normalizeOptionalModels(input.models)
    const modelMap = normalizeOptionalModelMap(input.modelMap)
    const clientProfile = normalizeOptionalClientProfile(input.clientProfile)
    const priority = normalizeOptionalPriority(input.priority)
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
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(modelMap !== undefined ? { modelMap } : {}),
      ...(clientProfile !== undefined ? { clientProfile } : {}),
      ...(priority !== undefined ? { priority } : {}),
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

    const normalized: {
      label?: string
      email?: string | null
      subject?: string | null
      baseUrl?: string | null
      protocol?: AccountProtocol | null
      models?: string[] | null
      modelMap?: Record<string, string> | null
      clientProfile?: string | null
      priority?: number
      labels?: string[] | null
      weight?: number | null
      concurrency?: number | null
    } = {}
    if ('label' in patch) normalized.label = normalizeLabel(patch.label)
    if ('email' in patch) normalized.email = normalizeNullableText(patch.email, 'email', EMAIL_MAX_LENGTH)
    if ('subject' in patch) normalized.subject = normalizeNullableText(patch.subject, 'subject', SUBJECT_MAX_LENGTH)
    if ('baseUrl' in patch) normalized.baseUrl = normalizeNullableBaseUrl(patch.baseUrl)
    if ('protocol' in patch) normalized.protocol = normalizeNullableProtocol(patch.protocol)
    if ('models' in patch) normalized.models = normalizeNullableModels(patch.models)
    if ('modelMap' in patch) normalized.modelMap = normalizeNullableModelMap(patch.modelMap)
    if ('clientProfile' in patch) normalized.clientProfile = normalizeNullableClientProfile(patch.clientProfile)
    if ('priority' in patch) normalized.priority = normalizeRequiredPriority(patch.priority)
    if ('labels' in patch) normalized.labels = normalizeNullableLabels(patch.labels)
    if ('weight' in patch) normalized.weight = normalizeNullableWeight(patch.weight)
    if ('concurrency' in patch) normalized.concurrency = normalizeNullableConcurrency(patch.concurrency)

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

  // ───────────────────────── 健康与自动停用（仍是 identity 写） ─────────────────────────

  /** 写入健康状态。它是调度输入（Go 的 Filter.Health 会用到），所以走独立方法而不是通用 update。 */
  async setHealth(actor: string, id: string, health: AccountHealth): Promise<AccountView> {
    this.assertAdmin(actor)
    const accountId = normalizeId(id)
    const account = await this.identity().setHealth(accountId, requireHealth(health))
    return this.view(account)
  }

  /**
   * 健康检查连续失败后的自动停用：只改 `status → auto_disabled`，
   * **不动 `enabled`**（人的手动开关不能被自动化覆盖）。
   */
  async autoDisable(actor: string, id: string, reason: string): Promise<AccountView> {
    this.assertAdmin(actor)
    const accountId = normalizeId(id)
    const account = await this.identity().autoDisable(accountId, normalizeAutoDisableReason(reason))
    return this.view(account)
  }

  /** 健康恢复：只把 `auto_disabled` 改回 `active`，不碰 needs_reauth 与 enabled。 */
  async autoEnable(actor: string, id: string): Promise<AccountView> {
    this.assertAdmin(actor)
    const account = await this.identity().autoEnable(normalizeId(id))
    return this.view(account)
  }

  // ───────────────────────── 批量操作 ─────────────────────────

  /**
   * 批量改字段：只提交声明过的字段，逐项成功或失败，互不阻塞。
   * `ids` 去重保序，长度受 `maxBatchSize` 限制。
   */
  async bulkUpdate(actor: string, ids: readonly string[], patch: BulkUpdateInput): Promise<BulkOperationResult> {
    this.assertAdmin(actor)
    const targets = normalizeIds(ids, this.maxBatchSize)
    if (!isRecord(patch)) failInput('bulkUpdate 的 patch 必须是对象')
    if (Object.keys(patch).length === 0) failInput('bulkUpdate 至少要声明一个字段')
    for (const key of Object.keys(patch)) {
      if (!(UPDATE_KEYS as readonly string[]).includes(key)) {
        failInput(`bulkUpdate 不支持字段 ${key}；启用 / 停用请用 bulkEnable / bulkDisable`)
      }
    }
    return this.applyAll(targets, (id) => this.update(actor, id, patch))
  }

  /** 批量启用：逐项结果，不受个别失败影响。 */
  async bulkEnable(actor: string, ids: readonly string[]): Promise<BulkOperationResult> {
    this.assertAdmin(actor)
    return this.applyAll(normalizeIds(ids, this.maxBatchSize), (id) => this.setEnabled(id, true))
  }

  /** 批量停用：逐项结果，不受个别失败影响。 */
  async bulkDisable(actor: string, ids: readonly string[]): Promise<BulkOperationResult> {
    this.assertAdmin(actor)
    return this.applyAll(normalizeIds(ids, this.maxBatchSize), (id) => this.setEnabled(id, false))
  }

  // ───────────────────────────────── 内部 ─────────────────────────────────

  /** 读一份视图：凭据配置状态必须与账号记录同一次读取，避免两处口径不一。 */
  private view(account: AccountRecord): AccountView {
    return toView(account, this.identity().credentialStatus(account.id).configured)
  }

  /** 收一条用量事件：只记「更新的时间」，不立刻写盘（节流由定时器做）。 */
  private noteAccountUsage(payload: unknown): void {
    if (!isRecord(payload)) return
    const ids = payload.accountIds
    const at = payload.at
    if (!Array.isArray(ids) || typeof at !== 'string') return
    const parsed = new Date(at)
    if (Number.isNaN(parsed.getTime())) return
    const value = parsed.toISOString()
    let changed = false
    for (const raw of ids) {
      if (typeof raw !== 'string') continue
      const accountId = raw.trim()
      if (accountId === '') continue
      const previous = this.pendingUsage.get(accountId)
      if (previous !== undefined && previous >= value) continue
      this.pendingUsage.set(accountId, value)
      changed = true
    }
    if (changed) this.scheduleUsageFlush()
  }

  /**
   * 立即把待汇报的 `lastUsedAt` 写回 identity（节流窗口到了 / 测试与运维手动触发）。
   * 返回成功写入的条数；单个账号失败只记日志，不影响其它账号。
   */
  async flushUsage(): Promise<number> {
    this.clearUsageTimer()
    if (this.pendingUsage.size === 0) return 0
    const entries = [...this.pendingUsage]
    this.pendingUsage.clear()
    const identity = this.ctx.get('identity', false) as IdentitySeam | undefined
    if (identity === undefined || identity === null) {
      this.logger.warn('identity 不可用：本轮 lastUsedAt 汇报被丢弃')
      return 0
    }
    let written = 0
    for (const [id, at] of entries) {
      try {
        await identity.reportUsed(id, at)
        written += 1
      } catch (error) {
        this.logger.warn(`账号 ${id} 的 lastUsedAt 汇报失败：${describeError(error)}`)
      }
    }
    return written
  }

  private scheduleUsageFlush(): void {
    if (this.disposed || this.usageTimer !== undefined) return
    this.usageTimer = setTimeout(() => {
      this.usageTimer = undefined
      void this.flushUsage()
    }, USAGE_REPORT_THROTTLE_MS)
    this.usageTimer.unref?.()
  }

  private clearUsageTimer(): void {
    if (this.usageTimer !== undefined) {
      clearTimeout(this.usageTimer)
      this.usageTimer = undefined
    }
  }

  /** 批量执行：每项独立 try/catch，最后汇总成功 / 失败。 */
  private async applyAll(
    targets: readonly string[],
    action: (id: string) => Promise<AccountView>,
  ): Promise<BulkOperationResult> {
    const items: BulkOperationItemResult[] = []
    for (const id of targets) {
      try {
        items.push({ id, ok: true, account: await action(id), error: null })
      } catch (error) {
        items.push({
          id,
          ok: false,
          account: null,
          error: { code: errorCodeOf(error), message: describeError(error) },
        })
      }
    }
    const succeeded = items.filter((item) => item.ok).length
    return { total: items.length, succeeded, failed: items.length - succeeded, items }
  }

  private async persistTestResult(
    identity: IdentitySeam,
    id: string,
    result: AccountTestResult,
  ): Promise<void> {
    try {
      await identity.recordTestResult(id, {
        ok: result.ok,
        latencyMs: result.latencyMs,
        error: result.error,
        testedAt: result.testedAt,
      })
    } catch (error) {
      // 测试本身已经完成；持久化失败只影响面板展示，不能把结果吞掉。
      this.logger.warn(`账号 ${id} 的测试结果写入失败：${describeError(error)}`)
    }
  }

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
    const baseUrl = normalizeOptionalBaseUrl(item.baseUrl)
    const protocol = normalizeOptionalProtocol(item.protocol)
    const models = normalizeOptionalModels(item.models)
    const modelMap = normalizeOptionalModelMap(item.modelMap)
    const priority = normalizeOptionalPriority(item.priority)

    const account = await identity.create({
      provider: parsed.provider,
      kind: parsed.kind,
      label,
      ...(email !== undefined ? { email } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(protocol !== undefined ? { protocol } : {}),
      ...(models !== undefined ? { models } : {}),
      ...(modelMap !== undefined ? { modelMap } : {}),
      ...(priority !== undefined ? { priority } : {}),
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
    baseUrl: account.baseUrl,
    protocol: account.protocol,
    models: account.models,
    modelMap: account.modelMap,
    clientProfile: account.clientProfile,
    priority: account.priority,
    labels: [...account.labels],
    weight: account.weight,
    concurrency: account.concurrency,
    health: account.health,
    autoDisabledAt: account.autoDisabledAt,
    autoDisabledReason: account.autoDisabledReason,
    lastUsedAt: account.lastUsedAt,
    accessExpiresAt: account.accessExpiresAt,
    refreshDueAt: account.refreshDueAt,
    lastRefreshAt: account.lastRefreshAt,
    lastError: account.lastError,
    failureCount: account.failureCount,
    backoffUntil: account.backoffUntil,
    lastTestAt: account.lastTestAt,
    lastTestOk: account.lastTestOk,
    lastTestError: account.lastTestError,
    lastTestLatencyMs: account.lastTestLatencyMs,
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
  if (query.health !== undefined && account.health !== query.health) return false
  if (query.labels !== undefined && !query.labels.every((label) => account.labels.includes(label))) return false
  if (query.search !== undefined) {
    const haystack = [account.id, account.label, account.email ?? '', account.subject ?? '']
      .join('\n')
      .toLowerCase()
    if (!haystack.includes(query.search)) return false
  }
  return true
}

/**
 * 列表精简视图：只放列表页要看 / 要点的字段。
 * 详情字段（baseUrl / models / modelMap / 凭据时间线）走 `get()`，避免列表 DTO 越滚越大。
 */
function toListItem(account: AccountRecord, credentialConfigured: boolean): AccountListItem {
  return {
    id: account.id,
    label: account.label,
    provider: account.provider,
    kind: account.kind,
    enabled: account.enabled,
    status: account.status,
    credentialConfigured,
    priority: account.priority,
    labels: [...account.labels],
    weight: account.weight,
    concurrency: account.concurrency,
    health: account.health,
    autoDisabledAt: account.autoDisabledAt,
    autoDisabledReason: account.autoDisabledReason,
    lastUsedAt: account.lastUsedAt,
    lastTestAt: account.lastTestAt,
    lastTestOk: account.lastTestOk,
    lastTestError: account.lastTestError,
    lastTestLatencyMs: account.lastTestLatencyMs,
  }
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

function normalizeOptionalBaseUrl(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') failInput('baseUrl 必须是字符串')
  return normalizeBaseUrlText(value) ?? undefined
}

function normalizeNullableBaseUrl(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string') failInput('baseUrl 必须是字符串或 null')
  return normalizeBaseUrlText(value)
}

function normalizeBaseUrlText(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    failInput('baseUrl 必须是合法的 http(s) URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    failInput('baseUrl 只支持 http / https')
  }
  return trimmed.replace(/\/+$/, '')
}

function normalizeOptionalProtocol(value: unknown): AccountProtocol | undefined {
  if (value === undefined || value === null) return undefined
  return requireProtocol(value)
}

function normalizeNullableProtocol(value: unknown): AccountProtocol | null {
  if (value === null) return null
  return requireProtocol(value)
}

function requireProtocol(value: unknown): AccountProtocol {
  if (
    value !== 'openai-chat' &&
    value !== 'openai-responses' &&
    value !== 'anthropic' &&
    value !== 'gemini'
  ) {
    failInput('protocol 只能是 openai-chat / openai-responses / anthropic / gemini')
  }
  return value
}

function normalizeOptionalPriority(value: unknown): number | undefined {
  if (value === undefined) return undefined
  return normalizeRequiredPriority(value)
}

const MODELS_MAX_ENTRIES = 200
const MODEL_NAME_MAX_LENGTH = 200

function normalizeOptionalModels(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const models = requireModels(value)
  return models === null ? undefined : models
}

function normalizeNullableModels(value: unknown): string[] | null {
  if (value === null) return null
  return requireModels(value)
}

/** trim、丢弃空串、去重、保序；空数组归一成 `null`；非法值明确失败。 */
function requireModels(value: unknown): string[] | null {
  if (!Array.isArray(value)) failInput('models 必须是字符串数组或 null')
  if (value.length > MODELS_MAX_ENTRIES) failInput(`models 最多 ${MODELS_MAX_ENTRIES} 个`)
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') failInput('models 的元素必须是字符串')
    const name = item.trim()
    if (name === '') continue
    if (name.length > MODEL_NAME_MAX_LENGTH) failInput(`模型名最长 ${MODEL_NAME_MAX_LENGTH} 个字符`)
    rejectControlCharacters(name, '模型名')
    if (seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result.length === 0 ? null : result
}

function normalizeOptionalModelMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  const modelMap = requireModelMap(value)
  return modelMap === null ? undefined : modelMap
}

function normalizeNullableModelMap(value: unknown): Record<string, string> | null {
  if (value === null) return null
  return requireModelMap(value)
}

/**
 * 客户端指纹档案 id（`clientMask` 里的一档）。
 *
 * **这里只做形状校验**（非空串 / 长度 / 无控制字符），不检查「档案存在不存在」：
 * 档案归 `clientMask` 管，这里查不到引用只会让账号发请求时不伪装（安全降级），
 * 页面上再提示管理员处置。要一致性就得让两个插件互相依赖，不值得。
 */
function normalizeOptionalClientProfile(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const parsed = requireClientProfile(value)
  return parsed === null ? undefined : parsed
}

function normalizeNullableClientProfile(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return requireClientProfile(value)
}

function requireClientProfile(value: unknown): string | null {
  if (typeof value !== 'string') failInput('clientProfile 必须是字符串或 null')
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (trimmed.length > CLIENT_PROFILE_MAX_LENGTH) {
    failInput(`clientProfile 最长 ${String(CLIENT_PROFILE_MAX_LENGTH)} 个字符`)
  }
  rejectControlCharacters(trimmed, 'clientProfile')
  return trimmed
}

/** 键值都 trim 且非空；空对象归一成 `null`；非对象 / 非字符串值 / 控制字符 / 超长明确失败。 */
function requireModelMap(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    failInput('modelMap 必须是字符串映射或 null')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MODELS_MAX_ENTRIES) failInput(`modelMap 最多 ${MODELS_MAX_ENTRIES} 项`)
  const result: Record<string, string> = {}
  for (const [rawKey, rawValue] of entries) {
    if (typeof rawValue !== 'string') failInput('modelMap 的值必须是字符串')
    const key = rawKey.trim()
    const mapped = rawValue.trim()
    if (key === '' || mapped === '') continue
    if (key.length > MODEL_NAME_MAX_LENGTH || mapped.length > MODEL_NAME_MAX_LENGTH) {
      failInput(`modelMap 的键与值最长 ${MODEL_NAME_MAX_LENGTH} 个字符`)
    }
    rejectControlCharacters(key, 'modelMap 的键')
    rejectControlCharacters(mapped, 'modelMap 的值')
    result[key] = mapped
  }
  return Object.keys(result).length === 0 ? null : result
}

function normalizeRequiredPriority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1000) {
    failInput('priority 必须是 0–1000 的整数')
  }
  return value
}

const LABELS_MAX_ENTRIES = 50
const LABEL_VALUE_MAX_LENGTH = 100
const WEIGHT_MAX = 1_000_000
const CONCURRENCY_MAX = 10_000
const AUTO_DISABLE_REASON_MAX = 500

function requireHealth(value: unknown): AccountHealth {
  if (value !== 'unknown' && value !== 'healthy' && value !== 'degraded' && value !== 'unhealthy') {
    failInput('health 只能是 unknown / healthy / degraded / unhealthy')
  }
  return value
}

/** trim、丢弃空串、去重、保序；空数组保留为空数组（= 清空标签）。 */
function requireLabels(value: unknown): string[] {
  if (!Array.isArray(value)) failInput('labels 必须是字符串数组或 null')
  if (value.length > LABELS_MAX_ENTRIES) failInput(`labels 最多 ${LABELS_MAX_ENTRIES} 个`)
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') failInput('labels 的元素必须是字符串')
    const label = item.trim()
    if (label === '') continue
    if (label.length > LABEL_VALUE_MAX_LENGTH) failInput(`单个标签最长 ${LABEL_VALUE_MAX_LENGTH} 个字符`)
    rejectControlCharacters(label, '标签')
    if (seen.has(label)) continue
    seen.add(label)
    result.push(label)
  }
  return result
}

function normalizeNullableLabels(value: unknown): string[] | null {
  if (value === null) return null
  return requireLabels(value)
}

/** `null` = 清空为未声明；否则大于 0 的有限数值（与 identity / Go 同口径）。 */
function normalizeNullableWeight(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > WEIGHT_MAX) {
    failInput(`weight 必须是大于 0 且不超过 ${WEIGHT_MAX} 的有限数值，或 null`)
  }
  return value
}

/** `null` = 清空为未声明；否则 1–10000 的整数。 */
function normalizeNullableConcurrency(value: unknown): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > CONCURRENCY_MAX) {
    failInput(`concurrency 必须是 1–${CONCURRENCY_MAX} 的整数，或 null`)
  }
  return value
}

function normalizeAutoDisableReason(value: unknown): string {
  if (typeof value !== 'string') failInput('自动停用原因必须是字符串')
  const reason = value.trim()
  if (reason === '') failInput('自动停用原因不能为空')
  const singleLine = reason.replace(/[\r\n]+/g, ' ')
  return singleLine.length > AUTO_DISABLE_REASON_MAX
    ? `${singleLine.slice(0, AUTO_DISABLE_REASON_MAX)}…`
    : singleLine
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
    if (value.status !== 'active' && value.status !== 'needs_reauth' && value.status !== 'auto_disabled') {
      failInput('status 只能是 active / needs_reauth / auto_disabled')
    }
    status = value.status
  }

  let health: AccountHealth | undefined
  if (value.health !== undefined) {
    health = requireHealth(value.health)
  }

  let labels: string[] | undefined
  if (value.labels !== undefined) {
    const normalized = requireLabels(value.labels)
    labels = normalized === null ? [] : normalized
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
    ...(health !== undefined ? { health } : {}),
    ...(labels !== undefined ? { labels } : {}),
    ...(search !== undefined ? { search } : {}),
  }
}

/** `list` 的视图选择：只认 `view`，默认 full；非法值明确失败。 */
function normalizeListView(value: unknown): 'lite' | 'full' {
  if (!isRecord(value)) failInput('list 选项必须是对象')
  for (const key of Object.keys(value)) {
    if (key !== 'view') failInput(`不支持的 list 选项：${key}`)
  }
  const view = value.view
  if (view === undefined) return 'full'
  if (view !== 'lite' && view !== 'full') failInput('view 只能是 lite / full')
  return view
}

/** 批量操作的 id 列表：非空、受批量上限约束、去重保序。 */
function normalizeIds(value: unknown, maxBatchSize: number): string[] {
  if (!Array.isArray(value)) failInput('ids 必须是账号 id 数组')
  if (value.length === 0) failInput('ids 不能为空')
  if (value.length > maxBatchSize) {
    throw new AccountAdminError(
      'ACCOUNT_ADMIN_BATCH_TOO_LARGE',
      `一次最多操作 ${maxBatchSize} 个账号，收到 ${value.length} 个`,
    )
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const id = normalizeId(item)
    if (seen.has(id)) continue
    seen.add(id)
    result.push(id)
  }
  return result
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

/** 测试参数：只接受 model / protocol，且都是字符串。 */
function normalizeTestInput(value: unknown): AccountTestInput {
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) failInput('测试参数必须是对象')
  for (const key of Object.keys(value)) {
    if (key !== 'model' && key !== 'protocol') failInput(`测试参数不支持字段 ${key}`)
  }
  const model = normalizeOptionalText(value.model, 'model', MODEL_NAME_MAX_LENGTH)
  let protocol: string | undefined
  if (value.protocol !== undefined && value.protocol !== null) {
    if (typeof value.protocol !== 'string') failInput('protocol 必须是字符串')
    protocol = requireProtocol(value.protocol)
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(protocol !== undefined ? { protocol } : {}),
  }
}

function normalizeImportSourceInput(value: unknown): AccountImportSourceInput {
  if (!isRecord(value)) failInput('导入参数必须是对象')
  return value as unknown as AccountImportSourceInput
}

function toBulkItem(item: ParsedImportItem): BulkImportItem {
  return {
    payload: item.payload,
    provider: item.provider,
    kind: item.kind,
    ...(item.label === undefined ? {} : { label: item.label }),
    ...(item.baseUrl === undefined ? {} : { baseUrl: item.baseUrl }),
    ...(item.protocol === undefined ? {} : { protocol: item.protocol }),
    ...(item.models === undefined ? {} : { models: item.models }),
    ...(item.modelMap === undefined ? {} : { modelMap: item.modelMap }),
    ...(item.priority === undefined ? {} : { priority: item.priority }),
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
  }
}
