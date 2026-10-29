/**
 * 测试夹具：用假端口实现 `ApiRuntime`，不拉起 cordis、不碰真实存储。
 *
 * 假服务的行为只覆盖 HTTP 层需要观察的事：
 * - 会话令牌只通过 cookie 流动，响应 JSON 里没有 token / passwordHash；
 * - 账号响应里带 `credentialRef`，用来断言 HTTP 层把它剥掉；
 * - apiKey 的 secret 只在 create / rotate 的返回值里出现。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { validateApiConfig, type ResolvedApiConfig } from '../src/config.ts'
import { isIssueList } from '@dizzyapi/plugin-kit'
import type {
  AccountAdminPort,
  AccountPriorityPort,
  AccountViewLike,
  ApiKeyPort,
  ApiRuntime,
  AuditEntryLike,
  AuditPageLike,
  AuditPort,
  AuditQueryLike,
  AuditRecordLike,
  AuditStatsLike,
  ObservabilityPort,
  AuthPort,
  BillingPort,
  CatalogPluginLike,
  CatalogPort,
  FrontendPageLike,
  FrontendPort,
  LoginResultLike,
  ModelPriceLike,
  ModelCatalogLike,
  ModelHubPort,
  PricingPort,
  RedeemBatchLike,
  RedeemCodeLike,
  RedeemDeletionResultLike,
  RedeemPort,
  RedeemResultLike,
  RedeemStatsLike,
  RedemptionLike,
  SessionViewLike,
  SettlePageLike,
  SettleRecordLike,
  SettleSummaryLike,
  SettingsPort,
  TicketLike,
  TopupOptionsLike,
  TopupOrderLike,
  TopupOrderPageLike,
  TopupPort,
  TopupStatsLike,
  ConfirmTopupResultLike,
  UsagePort,
  UsageQueryLike,
  UsageRejectedPageLike,
  UsageRejectedQueryLike,
  UsageRejectedRowLike,
  UsageReplayResultLike,
  UsageRowLike,
  UsageStatsLike,
  UsageStatusLike,
  UsageSummaryLike,
  UserLike,
  UserPort,
  UserStatusLike,
} from '../src/types.ts'

/** 隔离区行：fixture 需要改 status，所以用可变版本。 */
type MutableRejected = { -readonly [Key in keyof UsageRejectedRowLike]: UsageRejectedRowLike[Key] }

export class DomainError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'DomainError'
    this.code = code
  }
}

export function resolvedConfig(overrides: Record<string, unknown> = {}): ResolvedApiConfig {
  const value = validateApiConfig({ port: 0, ...overrides })
  if (isIssueList(value)) throw new Error(`测试配置不合法：${value.map((item) => item.message).join('；')}`)
  return value
}

export class FakeUser implements UserPort {
  readonly users = new Map<number, UserLike>()
  readonly calls: { method: string; args: unknown[] }[] = []
  private nextId = 10

  constructor() {
    const at = '2026-10-19T00:00:00.000Z'
    this.users.set(1, {
      id: 1,
      name: 'owner',
      status: 'enabled',
      balance: 12_345_678n,
      role: 'admin',
      balanceEnabled: true,
      avatar: null,
      createdAt: at,
      updatedAt: at,
    })
    this.users.set(2, {
      id: 2,
      name: 'alice',
      status: 'enabled',
      balance: 500_000n,
      role: 'user',
      balanceEnabled: false,
      avatar: null,
      createdAt: at,
      updatedAt: at,
    })
    this.users.set(3, {
      id: 3,
      name: 'banned-user',
      status: 'banned',
      balance: 0n,
      role: 'user',
      balanceEnabled: false,
      avatar: null,
      createdAt: at,
      updatedAt: at,
    })
  }

  create(name: string): UserLike {
    const at = new Date().toISOString()
    const user: UserLike = {
      id: this.nextId++,
      name,
      status: 'enabled',
      balance: 0n,
      role: 'user',
      balanceEnabled: false,
      avatar: null,
      createdAt: at,
      updatedAt: at,
    }
    this.users.set(user.id, user)
    return user
  }

  async get(id: number): Promise<UserLike | undefined> {
    this.calls.push({ method: 'get', args: [id] })
    return this.users.get(id)
  }

  async list(query: { status?: UserStatusLike; offset?: number; limit?: number } = {}): Promise<UserLike[]> {
    this.calls.push({ method: 'list', args: [query] })
    const all = [...this.users.values()].filter(
      (user) => query.status === undefined || user.status === query.status,
    )
    return all.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100))
  }

  async count(): Promise<number> {
    this.calls.push({ method: 'count', args: [] })
    return this.users.size
  }

  async rename(actor: string, id: number, name: string): Promise<UserLike> {
    this.calls.push({ method: 'rename', args: [actor, id, name] })
    return this.replace(id, { name })
  }

  async setStatus(actor: string, id: number, status: UserStatusLike): Promise<UserLike> {
    this.calls.push({ method: 'setStatus', args: [actor, id, status] })
    return this.replace(id, { status })
  }

  async remove(actor: string, id: number): Promise<UserLike> {
    this.calls.push({ method: 'remove', args: [actor, id] })
    const user = this.users.get(id)
    if (user === undefined) throw new DomainError('USER_NOT_FOUND', '没有这个用户')
    this.users.delete(id)
    return user
  }

  async adjustBalance(actor: string, id: number, delta: bigint, reason: string): Promise<bigint> {
    this.calls.push({ method: 'adjustBalance', args: [actor, id, delta, reason] })
    const user = this.replace(id, { balance: (this.users.get(id)?.balance ?? 0n) + delta })
    return user.balance
  }

  async updateProfile(
    userId: number,
    patch: { name?: string; avatar?: string | null },
  ): Promise<unknown> {
    this.calls.push({ method: 'updateProfile', args: [userId, patch] })
    return this.replace(userId, patch)
  }

  async setRole(actor: string, id: number, role: 'admin' | 'user'): Promise<unknown> {
    this.calls.push({ method: 'setRole', args: [actor, id, role] })
    return this.replace(id, { role })
  }

  async setBalanceEnabled(actor: string, id: number, enabled: boolean): Promise<unknown> {
    this.calls.push({ method: 'setBalanceEnabled', args: [actor, id, enabled] })
    return this.replace(id, { balanceEnabled: enabled })
  }

  private replace(id: number, patch: Partial<UserLike>): UserLike {
    const user = this.users.get(id)
    if (user === undefined) throw new DomainError('USER_NOT_FOUND', '没有这个用户')
    const updated = { ...user, ...patch, updatedAt: new Date().toISOString() }
    this.users.set(id, updated)
    return updated
  }
}

interface TokenRecord {
  readonly userId: number
  readonly sessionId: string
  readonly createdAt: string
  readonly expiresAt: string
}

export class FakeAuth implements AuthPort {
  readonly user: FakeUser
  readonly tokens = new Map<string, TokenRecord>()
  readonly emails = new Map<number, string>()
  readonly passwords = new Map<string, string>()
  readonly codes = new Map<string, string>()
  /** 假 mailer 的「收件箱」：测试从这里读验证码。 */
  readonly sent: { to: string; code: string }[] = []
  lastCode: string | null = null
  private readonly names = new Map<string, string>()
  private sequence = 1

  constructor(user: FakeUser) {
    this.user = user
    this.emails.set(1, 'owner@example.com')
    this.passwords.set('owner@example.com', 'password1')
    this.emails.set(2, 'alice@example.com')
    this.passwords.set('alice@example.com', 'password2')
  }

  async requestRegistration(input: { email: string; password: string; name?: string }): Promise<TicketLike> {
    const code = String(100_000 + (this.sequence++ % 900_000))
    this.lastCode = code
    this.codes.set(`register:${input.email}`, code)
    this.sent.push({ to: input.email, code })
    this.passwords.set(input.email, input.password)
    if (input.name !== undefined) this.names.set(input.email, input.name)
    return { email: input.email, expiresAt: this.expiry(), resendAfterMs: 60_000 }
  }

  async confirmRegistration(input: { email: string; code: string }): Promise<LoginResultLike> {
    const expected = this.codes.get(`register:${input.email}`)
    if (expected === undefined || expected !== input.code) {
      throw new DomainError('AUTH_CODE_INVALID', '验证码无效或已过期')
    }
    this.codes.delete(`register:${input.email}`)
    let user = [...this.user.users.values()].find((item) => this.emails.get(item.id) === input.email)
    if (user === undefined) {
      const name = this.names.get(input.email) ?? input.email.split('@')[0] ?? 'user'
      user = this.user.create(name)
      this.emails.set(user.id, input.email)
    }
    return this.issue(user)
  }

  async login(input: { email: string; password: string }): Promise<LoginResultLike> {
    if (this.passwords.get(input.email) !== input.password) {
      throw new DomainError('AUTH_CREDENTIALS_INVALID', '邮箱或密码错误')
    }
    const user = [...this.user.users.values()].find((item) => this.emails.get(item.id) === input.email)
    if (user === undefined) throw new DomainError('AUTH_USER_MISSING', '账号已不存在')
    if (user.status === 'banned') throw new DomainError('AUTH_USER_BANNED', '账号已被封禁')
    return this.issue(user)
  }

  async logout(token: string): Promise<void> {
    this.tokens.delete(token)
  }

  async verifySession(token: string): Promise<SessionViewLike> {
    // 模拟新版 auth 的两种失败：原始 message 是内部细节，HTTP 层不得带出。
    if (token === 'banned-token') {
      throw new DomainError('AUTH_USER_BANNED', '内部细节：账号被上游封禁')
    }
    if (token === 'broken-session') {
      throw new DomainError('AUTH_SESSION_INVALID', '内部细节：令牌哈希不匹配')
    }
    const record = this.tokens.get(token)
    if (record === undefined) throw new DomainError('AUTH_SESSION_INVALID', '会话无效')
    const user = this.user.users.get(record.userId)
    if (user === undefined) throw new DomainError('AUTH_USER_MISSING', '账号已不存在')
    if (user.status === 'banned') throw new DomainError('AUTH_USER_BANNED', '账号已被封禁')
    return {
      sessionId: record.sessionId,
      userId: record.userId,
      user,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      lastSeenAt: record.createdAt,
    }
  }

  async changePassword(
    token: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ revokedSessions: number }> {
    const record = this.tokens.get(token)
    if (record === undefined) throw new DomainError('AUTH_SESSION_INVALID', '会话无效')
    const email = this.emails.get(record.userId)
    if (email === undefined) throw new DomainError('AUTH_USER_MISSING', '账号缺少凭证')
    if (this.passwords.get(email) !== currentPassword) {
      throw new DomainError('AUTH_CREDENTIALS_INVALID', '当前密码不正确')
    }
    this.passwords.set(email, newPassword)
    return { revokedSessions: 0 }
  }

  async requestPasswordReset(email: string): Promise<TicketLike> {
    const code = String(600_000 + (this.sequence++ % 300_000))
    this.lastCode = code
    this.codes.set(`reset:${email}`, code)
    this.sent.push({ to: email, code })
    return { email, expiresAt: this.expiry(), resendAfterMs: 60_000 }
  }

  async confirmPasswordReset(input: {
    email: string
    code: string
    password: string
  }): Promise<{ userId: number; revokedSessions: number }> {
    const expected = this.codes.get(`reset:${input.email}`)
    if (expected === undefined || expected !== input.code) {
      throw new DomainError('AUTH_CODE_INVALID', '验证码无效或已过期')
    }
    this.codes.delete(`reset:${input.email}`)
    this.passwords.set(input.email, input.password)
    const user = [...this.user.users.values()].find((item) => this.emails.get(item.id) === input.email)
    return { userId: user?.id ?? 0, revokedSessions: 0 }
  }

  getEmail(userId: number): string | null {
    return this.emails.get(userId) ?? null
  }

  /** 测试用：直接给某个用户发一个有效会话令牌。 */
  issueFor(userId: number): string {
    const user = this.user.users.get(userId)
    if (user === undefined) throw new Error(`没有用户 ${userId}`)
    return this.issue(user).token
  }

  private issue(user: UserLike): LoginResultLike {
    const token = `tok-${this.sequence++}-${Math.random().toString(16).slice(2, 10)}`
    const createdAt = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString()
    this.tokens.set(token, {
      userId: user.id,
      sessionId: `ses-${this.sequence}`,
      createdAt,
      expiresAt,
    })
    return { token, sessionId: `ses-${this.sequence}`, expiresAt, user }
  }

  private expiry(): string {
    return new Date(Date.now() + 600_000).toISOString()
  }
}

export interface FakeFrontend extends FrontendPort {
  readonly root: string
  readonly pagesList: FrontendPageLike[]
  setEnabled(enabled: boolean): Promise<void>
}

export async function createFakeFrontend(pages: FrontendPageLike[] = []): Promise<FakeFrontend> {
  const root = await mkdtemp(join(tmpdir(), 'dizzy-api-http-'))
  const versionDir = join(root, 'versions', 'v1')
  await mkdir(versionDir, { recursive: true })
  await writeFile(
    join(versionDir, 'index.html'),
    '<!doctype html><html><body><div id="app">index</div></body></html>\n',
    'utf8',
  )
  await writeFile(join(versionDir, 'app.js'), "console.log('asset')\n", 'utf8')
  await writeFile(join(versionDir, 'style.css'), 'body { color: black }\n', 'utf8')
  await writeFile(join(root, 'state.json'), JSON.stringify({ enabled: true }), 'utf8')

  const pagesList = [...pages]
  const frontend: FakeFrontend = {
    config: { publicBase: '/assets/frontend' },
    root,
    pagesList,
    async current() {
      return { version: 'v1' }
    },
    async assetPath(path: string, version?: string): Promise<string> {
      if (version !== undefined && version !== 'v1') throw new DomainError('FRONTEND_ASSET_NOT_FOUND', '版本不存在')
      if (path.includes('\\') || path.includes('\0')) {
        throw new DomainError('FRONTEND_ASSET_INVALID', '非法路径')
      }
      const segments = path.split('/')
      if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
        throw new DomainError('FRONTEND_ASSET_INVALID', '非法路径')
      }
      const base = resolve(root, 'versions', 'v1')
      const target = resolve(base, ...segments)
      if (target !== base && !target.startsWith(`${base}${sep}`)) {
        throw new DomainError('FRONTEND_ASSET_NOT_FOUND', '路径越界')
      }
      return target
    },
    async indexFile() {
      return join(root, 'versions', 'v1', 'index.html')
    },
    async manifest() {
      return {
        schemaVersion: 1,
        revision: 'manifest-1',
        generatedAt: new Date().toISOString(),
        pages: pagesList,
        assets: { version: 'v1', base: '/assets/frontend/v1/' },
      }
    },
    pages(area?: 'console' | 'admin') {
      return area === undefined ? pagesList : pagesList.filter((page) => page.area === area)
    },
    async assets() {
      return { dataPath: root }
    },
    async setEnabled(enabled: boolean) {
      await writeFile(join(root, 'state.json'), JSON.stringify({ enabled }), 'utf8')
    },
  }
  return frontend
}

export class FakeCatalog implements CatalogPort {
  readonly plugins: CatalogPluginLike[] = [
    {
      id: 'api',
      package: '@dizzyapi/plugin-api',
      kind: 'plugin',
      state: 'active',
      disabled: false,
      manifest: { description: '产品 HTTP 入口' },
      capabilities: ['http-api', 'spa-hosting'],
    },
    {
      id: 'off',
      package: '@dizzyapi/plugin-off',
      kind: 'plugin',
      state: 'disabled',
      disabled: true,
      manifest: { description: null },
      capabilities: [],
    },
  ]

  async query(): Promise<{ generatedAt: string; plugins: readonly CatalogPluginLike[] }> {
    return { generatedAt: '2026-10-19T00:00:00.000Z', plugins: this.plugins }
  }
}

export class FakeAccountAdmin implements AccountAdminPort {
  readonly accounts: AccountViewLike[] = [
    {
      id: 'acc_1',
      provider: 'openai',
      kind: 'api_key',
      label: 'primary',
      enabled: true,
      status: 'active',
      email: 'up@example.com',
      subject: 'org-1',
      baseUrl: 'https://api.openai.com/v1',
      protocol: 'openai-chat',
      models: ['gpt-5', 'gpt-5-codex'],
      modelMap: { 'gpt-5-codex': 'gpt-5-codex-2025-01-01' },
      priority: 5,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
      lastTestLatencyMs: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: 'acc_2',
      provider: 'claude',
      kind: 'oauth',
      label: 'backup',
      enabled: false,
      status: 'needs_reauth',
      email: null,
      subject: null,
      baseUrl: null,
      protocol: null,
      models: null,
      modelMap: null,
      priority: 0,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: 'invalid_grant',
      failureCount: 3,
      backoffUntil: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
      lastTestLatencyMs: null,
      createdAt: '2026-10-02T00:00:00.000Z',
      updatedAt: '2026-10-02T00:00:00.000Z',
    },
  ]
  /** 假装账号记录里有秘密引用名；HTTP 层必须把它剥掉。 */
  readonly extraSecret = { credentialRef: 'credential-ref-acc-1', credentialConfigured: true }
  readonly calls: { method: string; args: unknown[] }[] = []

  list(query: { provider?: string; status?: string } = {}): AccountViewLike[] {
    this.calls.push({ method: 'list', args: [query] })
    return this.accounts.filter(
      (account) =>
        (query.provider === undefined || account.provider === query.provider) &&
        (query.status === undefined || account.status === query.status),
    )
  }

  get(id: string): AccountViewLike {
    this.calls.push({ method: 'get', args: [id] })
    const account = this.accounts.find((item) => item.id === id)
    if (account === undefined) throw new DomainError('IDENTITY_NOT_FOUND', '没有这个账号')
    return { ...account, ...this.extraSecret } as AccountViewLike
  }

  async create(actor: string, input: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'create', args: [actor, input] })
    const account = {
      id: 'acc_new',
      provider: String(input.provider),
      kind: String(input.kind),
      label: String(input.label),
      enabled: input.enabled !== false,
      status: 'active',
      email: null,
      subject: null,
      baseUrl: typeof input.baseUrl === 'string' ? input.baseUrl : null,
      protocol: typeof input.protocol === 'string' ? input.protocol : null,
      models: Array.isArray(input.models) ? input.models : null,
      modelMap:
        typeof input.modelMap === 'object' && input.modelMap !== null
          ? (input.modelMap as Record<string, string>)
          : null,
      priority: typeof input.priority === 'number' ? input.priority : 0,
      accessExpiresAt: null,
      refreshDueAt: null,
      lastRefreshAt: null,
      lastError: null,
      failureCount: 0,
      backoffUntil: null,
      lastTestAt: null,
      lastTestOk: null,
      lastTestError: null,
      lastTestLatencyMs: null,
      createdAt: '2026-10-03T00:00:00.000Z',
      updatedAt: '2026-10-03T00:00:00.000Z',
    }
    this.accounts.push(account)
    return { ...account, ...this.extraSecret } as AccountViewLike
  }

  async update(actor: string, id: string, patch: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method: 'update', args: [actor, id, patch] })
    return this.replace(id, patch)
  }

  async enable(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'enable', args: [actor, id] })
    return this.replace(id, { enabled: true })
  }

  async disable(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'disable', args: [actor, id] })
    return this.replace(id, { enabled: false })
  }

  async remove(actor: string, id: string): Promise<unknown> {
    this.calls.push({ method: 'remove', args: [actor, id] })
    return { removed: true }
  }

  async importCredentials(actor: string, id: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'importCredentials', args: [actor, id, input] })
    return this.get(id)
  }

  async importAccounts(actor: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'importAccounts', args: [actor, input] })
    return {
      total: 1,
      created: 1,
      failed: 0,
      items: [{ index: 0, ok: true, account: this.get('acc_1'), error: null }],
    }
  }

  previewImport(input: unknown): unknown {
    this.calls.push({ method: 'previewImport', args: [input] })
    return {
      format: 'api-key',
      provider: 'openai',
      kind: 'api_key',
      email: null,
      subject: null,
      expiresAt: null,
      hasAccessToken: false,
      hasRefreshToken: false,
      hasApiKey: true,
    }
  }

  async testConnection(
    id: string,
    input: { model?: string; protocol?: string },
  ): Promise<{
    ok: boolean
    status: number | null
    latencyMs: number
    model: string | null
    protocol: string | null
    error: string | null
    testedAt: string
  }> {
    this.calls.push({ method: 'testConnection', args: [id, input] })
    const account = this.accounts.find((item) => item.id === id)
    if (account === undefined) throw new DomainError('IDENTITY_NOT_FOUND', '没有这个账号')
    return {
      ok: true,
      status: 200,
      latencyMs: 123,
      model: input.model ?? account.models?.[0] ?? null,
      protocol: input.protocol ?? account.protocol ?? 'openai-chat',
      error: null,
      testedAt: '2026-10-21T00:00:00.000Z',
    }
  }

  previewImportSource(input: unknown): unknown {
    this.calls.push({ method: 'previewImportSource', args: [input] })
    const source = (input as { source?: string }).source ?? 'auto'
    return {
      source: source === 'auto' ? 'plain-keys' : source,
      total: 1,
      items: [
        {
          index: 0,
          ok: true,
          label: 'from-source',
          provider: 'openai',
          kind: 'api_key',
          baseUrl: null,
          models: null,
          error: null,
        },
      ],
    }
  }

  async importSource(actor: string, input: unknown): Promise<unknown> {
    this.calls.push({ method: 'importSource', args: [actor, input] })
    return {
      total: 1,
      created: 1,
      failed: 0,
      items: [{ index: 0, ok: true, account: this.get('acc_1'), error: null }],
    }
  }

  private replace(id: string, patch: Record<string, unknown>): AccountViewLike {
    const index = this.accounts.findIndex((item) => item.id === id)
    if (index < 0) throw new DomainError('IDENTITY_NOT_FOUND', '没有这个账号')
    const updated = { ...this.accounts[index]!, ...patch, updatedAt: new Date().toISOString() }
    this.accounts[index] = updated
    return { ...updated, ...this.extraSecret } as AccountViewLike
  }
}

export class FakeSettings implements SettingsPort {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly namespaces = [{ ns: 'mailer', plugin: '@dizzyapi/plugin-mailer', writable: true, fields: [] }]
  /** 设置后 update / reset 抛带这个 code 的领域错误（验证失败路径）。 */
  failCode: string | undefined

  async describe(): Promise<unknown> {
    this.calls.push({ method: 'describe', args: [] })
    // 真实 settings 服务的形状；HTTP 层必须原样透传 `{ namespaces }`。
    return { namespaces: this.namespaces }
  }

  async update(actor: string, ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    this.calls.push({ method: 'update', args: [actor, ns, patch, expectedRevision] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：设置写入失败')
    return { ns, revision: 'rev-2', patch }
  }

  async reset(actor: string, ns: string): Promise<unknown> {
    this.calls.push({ method: 'reset', args: [actor, ns] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：设置重置失败')
    return { ns, overridden: false }
  }
}

export class FakeApiKey implements ApiKeyPort {
  readonly items = new Map<string, Record<string, unknown>>()
  readonly calls: { method: string; args: unknown[] }[] = []
  private sequence = 1

  constructor() {
    this.items.set('key_1', {
      id: 'key_1',
      name: 'ci',
      trackingId: 'trk-1',
      secret: 'sk-dizzy-secret-initial',
      maskedKey: 'sk-dizzy-****0001',
      createdAt: '2026-10-01T00:00:00.000Z',
      lastUsedAt: null,
      appManaged: false,
      enabled: true,
    })
  }

  async list(userId: number): Promise<unknown> {
    this.calls.push({ method: 'list', args: [userId] })
    return [...this.items.values()]
  }

  async count(): Promise<number> {
    this.calls.push({ method: 'count', args: [] })
    return this.items.size
  }

  async listAll(): Promise<unknown> {
    this.calls.push({ method: 'listAll', args: [] })
    return [...this.items.values()].map((item) => ({ ...item, secret: null }))
  }

  async create(userId: number, input: { name: string }): Promise<unknown> {
    this.calls.push({ method: 'create', args: [userId, input] })
    const id = `key_${++this.sequence}`
    const item = {
      id,
      name: input.name,
      trackingId: `trk-${this.sequence}`,
      secret: `sk-dizzy-secret-${this.sequence}`,
      maskedKey: `sk-dizzy-****000${this.sequence}`,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      appManaged: false,
      enabled: true,
    }
    this.items.set(id, item)
    // 真实 apiKey 服务返回 `{ key, secret }`；HTTP 层负责展开。
    return { key: item, secret: `sk-dizzy-secret-${this.sequence}` }
  }

  async update(userId: number, id: string, patch: { name?: string; enabled?: boolean }): Promise<unknown> {
    this.calls.push({ method: 'update', args: [userId, id, patch] })
    const item = this.items.get(id)
    if (item === undefined) throw new DomainError('KEY_NOT_FOUND', '没有这个 key')
    Object.assign(item, patch)
    return item
  }

  async remove(userId: number, id: string): Promise<unknown> {
    this.calls.push({ method: 'remove', args: [userId, id] })
    this.items.delete(id)
    return { removed: true }
  }

  async rotate(userId: number, id: string): Promise<unknown> {
    this.calls.push({ method: 'rotate', args: [userId, id] })
    const item = this.items.get(id)
    if (item === undefined) throw new DomainError('KEY_NOT_FOUND', '没有这个 key')
    item.maskedKey = `sk-dizzy-****rot${this.sequence}`
    item.secret = `sk-dizzy-rotated-${this.sequence}`
    return { key: item, secret: `sk-dizzy-rotated-${this.sequence}` }
  }
}

export class FakeAccountPriority implements AccountPriorityPort {
  status() {
    return {
      state: 'ready',
      bridgeConnected: true,
      transport: 'tcp' as const,
      address: '127.0.0.1:59321',
      revision: 'rev-1',
      accounts: 2,
    }
  }
}

/** 假用量服务：默认空表；测试可以 `usage.rows.push(...)` 后验证查询口径。 */
export class FakeUsage implements UsagePort {
  rows: UsageRowLike[] = []
  rejected: MutableRejected[] = []
  readonly rejectedActions: { method: 'ignore' | 'replay'; reqId: string }[] = []

  list(query: UsageQueryLike) {
    const filtered = this.filter(query)
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
    const page = filtered.filter((row) => query.cursor === undefined || row.id < query.cursor).slice(0, limit)
    return {
      items: page,
      nextCursor: page.length === limit && page.length > 0 ? page[page.length - 1]!.id : null,
    }
  }

  summary(query: UsageQueryLike): UsageSummaryLike {
    return { totals: totalsOf(this.filter(query)), daily: [], models: [] }
  }

  stats(): UsageStatsLike {
    return {
      today: totalsOf(this.rows),
      total: totalsOf(this.rows),
      series: [],
      models: [],
      topUsers: [],
    }
  }

  exportRows(query: UsageQueryLike, limit = 1000): readonly UsageRowLike[] {
    return this.filter(query).slice(0, limit)
  }

  status(): UsageStatusLike {
    return { records: this.rows.length, epoch: 'test-epoch', lastSeq: this.rows.length, polling: false, pricingAvailable: true }
  }

  listRejected(query: UsageRejectedQueryLike = {}): UsageRejectedPageLike {
    const filtered = this.rejected
      .filter((row) => query.status === undefined || row.status === query.status)
      .slice()
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.reqId.localeCompare(b.reqId))
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
    const offset = Math.max(query.offset ?? 0, 0)
    return {
      items: filtered.slice(offset, offset + limit),
      total: filtered.length,
      pending: this.rejected.filter((row) => row.status === 'pending').length,
    }
  }

  ignoreRejected(reqId: string): void {
    this.rejectedActions.push({ method: 'ignore', reqId })
    const row = this.rejected.find((item) => item.reqId === reqId)
    if (row === undefined) throw new DomainError('USAGE_REJECTED_NOT_FOUND', `没有这条隔离记录：${reqId}`)
    if (row.status === 'ignored') return
    if (row.status !== 'pending') {
      throw new DomainError('USAGE_REJECTED_STATE', `隔离记录已是 ${row.status}，不能再忽略`)
    }
    row.status = 'ignored'
  }

  async replayRejected(reqId: string): Promise<UsageReplayResultLike> {
    this.rejectedActions.push({ method: 'replay', reqId })
    const row = this.rejected.find((item) => item.reqId === reqId)
    if (row === undefined) throw new DomainError('USAGE_REJECTED_NOT_FOUND', `没有这条隔离记录：${reqId}`)
    if (row.status === 'ignored') {
      throw new DomainError('USAGE_REJECTED_STATE', '已忽略的隔离记录不再重放')
    }
    if (row.status === 'replayed') return { status: 'replayed', inserted: false }
    row.status = 'replayed'
    return { status: 'replayed', inserted: true }
  }

  private filter(query: UsageQueryLike): UsageRowLike[] {
    return this.rows
      .filter((row) => query.userId === undefined || row.userId === query.userId)
      .filter((row) => query.apiKeyId === undefined || row.apiKeyId === query.apiKeyId)
      .filter((row) => query.model === undefined || row.model === query.model)
      .filter((row) => query.status === undefined || row.status === query.status)
      .sort((a, b) => b.id - a.id)
  }
}

function totalsOf(rows: readonly UsageRowLike[]) {
  let requests = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  let costMicros = 0n
  for (const row of rows) {
    requests += 1
    inputTokens += row.inputTokens
    outputTokens += row.outputTokens
    cacheReadTokens += row.cacheReadTokens
    cacheWriteTokens += row.cacheWriteTokens
    reasoningTokens += row.reasoningTokens
    totalTokens += row.totalTokens
    costMicros += BigInt(row.costMicros)
  }
  return {
    requests,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    costMicros: costMicros.toString(),
  }
}

/** 假价格表：测试可以 `pricing.prices.set(...)`。 */
export class FakePricing implements PricingPort {
  prices = new Map<string, ModelPriceLike>()

  list(): readonly ModelPriceLike[] {
    return [...this.prices.values()]
  }

  get(model: string): ModelPriceLike | null {
    return this.prices.get(model) ?? null
  }

  async set(_actor: string, model: string, input: {
    inputPerMillion: string | number
    outputPerMillion: string | number
    cacheReadPerMillion?: string | number
    cacheWritePerMillion?: string | number
  }): Promise<ModelPriceLike> {
    const price: ModelPriceLike = {
      model,
      inputPerMillion: String(input.inputPerMillion),
      outputPerMillion: String(input.outputPerMillion),
      cacheReadPerMillion: String(input.cacheReadPerMillion ?? '0'),
      cacheWritePerMillion: String(input.cacheWritePerMillion ?? '0'),
      currency: 'CNY',
      updatedAt: '2026-10-19T12:00:00.000Z',
    }
    this.prices.set(model, price)
    return price
  }

  async remove(_actor: string, model: string): Promise<boolean> {
    return this.prices.delete(model)
  }
}

/**
 * 兑换码服务（`redeem`）的假实现。
 *
 * 只覆盖 HTTP 层需要观察的事：金额是 bigint 微元、明文只出现在 createBatch 的返回里、
 * 状态类拒绝走稳定 code。它不模拟事务与幂等（那是 redeem 插件自己的测试）。
 */
export class FakeRedeem implements RedeemPort {
  readonly calls: { method: string; args: unknown[] }[] = []
  readonly batches = new Map<string, RedeemBatchLike>()
  readonly codes = new Map<string, RedeemCodeLike>()
  /** 设置后 redeemCode 抛出带这个 code 的 DomainError，用于断言错误码 → 状态码。 */
  failRedeem: string | undefined

  async redeemCode(input: { userId: number; code: string }): Promise<RedeemResultLike> {
    this.calls.push({ method: 'redeemCode', args: [input] })
    if (this.failRedeem !== undefined) {
      throw new DomainError(this.failRedeem, '测试拒绝：兑换码不可用')
    }
    return { amount: 5_000_000n, balance: 12_345_678n, batchName: '测试批次' }
  }

  async listMyRedemptions(userId: number, limit?: number): Promise<readonly RedemptionLike[]> {
    this.calls.push({ method: 'listMyRedemptions', args: [userId, limit] })
    return [
      {
        codeId: 'code-1',
        codeMask: '****A3F7',
        amountMicro: 5_000_000n,
        batchName: '测试批次',
        redeemedAt: '2026-10-19T12:00:00.000Z',
      },
    ]
  }

  async createBatch(
    actor: string,
    input: {
      name: string
      amountMicro: bigint
      count: number
      expiresAt?: string | null
      notes?: string | null
    },
  ): Promise<{ batch: RedeemBatchLike; codes: readonly string[] }> {
    this.calls.push({ method: 'createBatch', args: [actor, input] })
    const id = `batch-${this.batches.size + 1}`
    const batch: RedeemBatchLike = {
      id,
      name: input.name,
      kind: 'balance',
      amountMicro: input.amountMicro,
      total: input.count,
      notes: input.notes ?? null,
      createdBy: actor,
      createdAt: '2026-10-19T12:00:00.000Z',
      expiresAt: input.expiresAt ?? null,
      codeCount: input.count,
      usedCount: 0,
    }
    this.batches.set(id, batch)
    const codes: string[] = []
    for (let index = 0; index < input.count; index += 1) {
      const plain = `ABCD-EFGH-JKMN-PQRS-TVWX-${String(index + 1).padStart(4, '0')}`
      codes.push(plain)
      const codeId = `code-${this.codes.size + 1}`
      this.codes.set(codeId, {
        id: codeId,
        batchId: id,
        batchName: batch.name,
        codeMask: `****${plain.slice(-4)}`,
        kind: 'balance',
        amountMicro: input.amountMicro,
        status: 'enabled',
        createdAt: batch.createdAt,
        expiresAt: batch.expiresAt,
        reservedAt: null,
        reservedBy: null,
        redeemedAt: null,
        redeemedBy: null,
        disabledBy: null,
        disabledAt: null,
      })
    }
    return { batch, codes }
  }

  async listBatches(
    _actor: string,
    query: { limit?: number; offset?: number } = {},
  ): Promise<readonly RedeemBatchLike[]> {
    this.calls.push({ method: 'listBatches', args: [query] })
    const all = [...this.batches.values()]
    return all.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? all.length))
  }

  async getBatch(_actor: string, batchId: string): Promise<RedeemBatchLike> {
    this.calls.push({ method: 'getBatch', args: [batchId] })
    const batch = this.batches.get(batchId)
    if (batch === undefined) throw new DomainError('REDEEM_NOT_FOUND', '批次不存在')
    return batch
  }

  async listCodes(
    _actor: string,
    query: { batchId?: string; status?: string; keyword?: string; limit?: number; offset?: number } = {},
  ): Promise<{ items: readonly RedeemCodeLike[]; total: number }> {
    this.calls.push({ method: 'listCodes', args: [query] })
    let items = [...this.codes.values()]
    if (query.batchId !== undefined) items = items.filter((code) => code.batchId === query.batchId)
    if (query.status === 'used' || query.status === 'enabled' || query.status === 'disabled' || query.status === 'redeeming') {
      items = items.filter((code) => code.status === query.status)
    }
    if (query.keyword !== undefined) {
      items = items.filter((code) => code.codeMask.includes(query.keyword as string))
    }
    return { items: items.slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100)), total: items.length }
  }

  async setCodeStatus(
    _actor: string,
    codeId: string,
    status: 'enabled' | 'disabled',
  ): Promise<RedeemCodeLike> {
    this.calls.push({ method: 'setCodeStatus', args: [codeId, status] })
    const code = this.codes.get(codeId)
    if (code === undefined) throw new DomainError('REDEEM_NOT_FOUND', '兑换码不存在')
    const updated: RedeemCodeLike = { ...code, status }
    this.codes.set(codeId, updated)
    return updated
  }

  async deleteCodes(_actor: string, ids: readonly string[]): Promise<RedeemDeletionResultLike> {
    this.calls.push({ method: 'deleteCodes', args: [ids] })
    const rejected = ids
      .filter((id) => this.codes.get(id)?.status === 'used')
      .map((id) => ({ id, reason: 'REDEEM_CODE_USED' }))
    let deleted = 0
    for (const id of ids) {
      if (rejected.some((item) => item.id === id)) continue
      if (this.codes.delete(id)) deleted += 1
    }
    return { deleted, rejected }
  }

  async resolveRedeeming(
    _actor: string,
    codeId: string,
    outcome: 'used' | 'enabled',
  ): Promise<RedeemCodeLike> {
    this.calls.push({ method: 'resolveRedeeming', args: [codeId, outcome] })
    const code = this.codes.get(codeId)
    if (code === undefined) throw new DomainError('REDEEM_NOT_FOUND', '兑换码不存在')
    const updated: RedeemCodeLike = {
      ...code,
      status: outcome,
      reservedAt: null,
      redeemedAt: outcome === 'used' ? '2026-10-19T12:00:00.000Z' : null,
    }
    this.codes.set(codeId, updated)
    return updated
  }

  async stats(_actor: string): Promise<RedeemStatsLike> {
    const all = [...this.codes.values()]
    const countOf = (status: string): number => all.filter((code) => code.status === status).length
    return {
      batches: this.batches.size,
      codes: all.length,
      enabled: countOf('enabled'),
      disabled: countOf('disabled'),
      redeeming: countOf('redeeming'),
      used: countOf('used'),
      expired: 0,
      redeemedAmountMicro: all
        .filter((code) => code.status === 'used')
        .reduce((sum, code) => sum + code.amountMicro, 0n),
    }
  }
}

/** 结算服务（`billing`）的假实现：只读面，金额是 bigint 微元。 */
export class FakeBilling implements BillingPort {
  readonly calls: { method: string; args: readonly unknown[] }[] = []
  /** 设置后 list / summary 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined

  private readonly record: SettleRecordLike = {
    reqId: 'req-1',
    userId: 2,
    accountId: 'account-1',
    model: 'deepseek-chat',
    day: '2026-10-19',
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMicro: 1_750_000n,
    overdrawn: false,
    balanceAfter: 8_250_000n,
    status: 'settled',
    note: null,
    attempts: 1,
    startedAt: '2026-10-19T11:00:00.000Z',
    claimedAt: '2026-10-19T11:00:02.000Z',
    settledAt: '2026-10-19T11:00:02.000Z',
    createdAt: '2026-10-19T11:00:02.000Z',
    updatedAt: '2026-10-19T11:00:02.000Z',
  }

  list(
    _actor: string,
    query: { readonly status?: string; readonly limit?: number; readonly offset?: number } = {},
  ): SettlePageLike {
    this.calls.push({ method: 'list', args: [query] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：结算读失败')
    const items = query.status === 'problem' ? [] : [this.record]
    return { items, total: items.length }
  }

  summary(_actor: string, nowMs?: number): SettleSummaryLike {
    this.calls.push({ method: 'summary', args: [nowMs] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：结算读失败')
    return {
      totals: {
        records: 1,
        settled: 1,
        noPrice: 0,
        noUser: 0,
        failed: 0,
        review: 0,
        settling: 0,
        overdrawn: 0,
        chargedMicros: 1_750_000n,
        todayChargedMicros: 1_750_000n,
      },
      daily: [{ date: '2026-10-19', records: 1, settled: 1, chargedMicros: 1_750_000n }],
      models: [{ model: 'deepseek-chat', records: 1, chargedMicros: 1_750_000n }],
    }
  }
}

/** 充值订单服务（`topup`）的假实现：只覆盖 HTTP 层要观察的行为。 */
export class FakeTopup implements TopupPort {
  readonly calls: { method: string; args: readonly unknown[] }[] = []
  /** 设置后 createOrder / confirmPaid 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined
  confirmCredited = true

  private readonly order: TopupOrderLike = {
    orderNo: 'T20261019110000ABCD1234',
    userId: 2,
    amountMicro: 100_000_000n,
    status: 'pending',
    provider: 'manual',
    providerLabel: '人工确认（线下转账）',
    providerOrderId: null,
    instructions: '请联系管理员线下转账，并在备注里写明单号；管理员确认后到账。',
    note: '对公转账',
    createdAt: '2026-10-19T11:00:00.000Z',
    expiresAt: '2026-10-19T11:30:00.000Z',
    paidAt: null,
    canceledAt: null,
  }

  options(): TopupOptionsLike {
    return {
      currency: 'CNY',
      providerId: 'manual',
      providerLabel: '人工确认（线下转账）',
      online: false,
      minAmountMicros: 1_000_000n,
      maxAmountMicros: 10_000_000_000n,
      expiresMinutes: 30,
      notice: '当前仅支持人工确认到账，不会自动到账。',
    }
  }

  async createOrder(input: {
    readonly userId: number
    readonly amountYuan: unknown
  }): Promise<{ readonly order: TopupOrderLike }> {
    this.calls.push({ method: 'createOrder', args: [input] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：创建订单失败')
    return { order: this.order }
  }

  listMine(userId: number, limit?: number): TopupOrderPageLike {
    this.calls.push({ method: 'listMine', args: [userId, limit] })
    return { items: [this.order], total: 1 }
  }

  getMine(userId: number, orderNo: string): TopupOrderLike {
    this.calls.push({ method: 'getMine', args: [userId, orderNo] })
    return this.order
  }

  cancelMine(userId: number, orderNo: string): TopupOrderLike {
    this.calls.push({ method: 'cancelMine', args: [userId, orderNo] })
    return { ...this.order, status: 'canceled', canceledAt: '2026-10-19T11:05:00.000Z' }
  }

  list(
    _actor: string,
    query: {
      readonly status?: string
      readonly userId?: number
      readonly fromMs?: number
      readonly toMs?: number
      readonly limit?: number
      readonly offset?: number
    } = {},
  ): TopupOrderPageLike {
    this.calls.push({ method: 'list', args: [query] })
    return { items: [this.order], total: 1 }
  }

  async confirmPaid(actor: string, orderNo: string): Promise<ConfirmTopupResultLike> {
    this.calls.push({ method: 'confirmPaid', args: [actor, orderNo] })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：确认到账失败')
    return {
      order: this.confirmCredited ? this.order : { ...this.order, status: 'paid' },
      credited: this.confirmCredited,
    }
  }

  cancel(actor: string, orderNo: string): TopupOrderLike {
    this.calls.push({ method: 'cancel', args: [actor, orderNo] })
    return { ...this.order, status: 'canceled', canceledAt: '2026-10-19T11:05:00.000Z' }
  }

  stats(_actor: string, nowMs?: number): TopupStatsLike {
    this.calls.push({ method: 'stats', args: [nowMs] })
    return {
      todayPaidCount: 1,
      todayPaidMicros: 100_000_000n,
      totalPaidCount: 2,
      totalPaidMicros: 300_000_000n,
      pendingCount: 3,
      expiredCount: 4,
    }
  }
}

/** 模型广场服务的假实现：只覆盖 HTTP 层要观察的行为。 */
export class FakeModelHub implements ModelHubPort {
  readonly calls: { readonly query?: unknown }[] = []
  /** 设置后 catalog 抛出带这个 code 的 DomainError。 */
  failCode: string | undefined

  catalog(query?: {
    readonly search?: string
    readonly availability?: 'all' | 'available' | 'unavailable'
    readonly priced?: 'all' | 'priced' | 'unpriced'
  }): ModelCatalogLike {
    this.calls.push({ query })
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：目录查询失败')
    const price = {
      model: 'deepseek-chat',
      inputPerMillion: '2',
      outputPerMillion: '8',
      cacheReadPerMillion: '0.5',
      cacheWritePerMillion: '0',
      currency: 'CNY',
      updatedAt: '2026-10-19T00:00:00.000Z',
    }
    return {
      available: [
        {
          model: 'deepseek-chat',
          priced: true,
          price,
          accountCount: 3,
          healthyAccountCount: 2,
          protocols: ['openai-chat'],
          upstreamModels: ['deepseek-chat-2026'],
          mapped: true,
        },
      ],
      unavailable: [
        {
          model: 'deepseek-reasoner',
          reason: 'no_healthy_account',
          detail: '提供这个模型的账号当前都不可用（停用、凭据缺失或健康检查未通过）',
          accountCount: 1,
          price: null,
          priced: false,
        },
      ],
      summary: {
        total: 2,
        availableCount: 1,
        unavailableCount: 1,
        pricedCount: 1,
        accountCount: 4,
      },
    }
  }
}

/** 审计服务的假实现：记录收到的写入、支持筛选与分页；可以让 record 抛错。 */
export class FakeAudit implements AuditPort {
  readonly calls: AuditEntryLike[] = []
  readonly reads: { readonly actor: string; readonly query?: AuditQueryLike }[] = []
  /** 置 true 后 `record` 抛错：用来验证「审计挂了业务照常成功」。 */
  failRecord = false
  private items: AuditRecordLike[] = []
  private nextId = 1

  record(entry: AuditEntryLike): AuditRecordLike {
    if (this.failRecord) throw new Error('审计库写入失败（测试注入）')
    const atMs = entry.atMs ?? Date.UTC(2026, 9, 19, 12, 0, 0)
    const stored: AuditRecordLike = {
      id: this.nextId++,
      at: new Date(atMs).toISOString(),
      atMs,
      actor: entry.actor,
      actorPlugin: entry.actorPlugin,
      action: entry.action,
      targetType: entry.targetType ?? '',
      targetId: entry.targetId ?? '',
      summary: entry.summary,
      metadata: entry.metadata ?? null,
      result: entry.result ?? 'ok',
      errorCode: entry.errorCode ?? null,
    }
    this.calls.push(entry)
    this.items.push(stored)
    return stored
  }

  list(actor: string, query: AuditQueryLike = {}): AuditPageLike {
    this.reads.push({ actor, query })
    const filtered = this.items.filter((item) => {
      if (query.actor !== undefined && item.actor !== query.actor) return false
      if (query.action !== undefined && item.action !== query.action) return false
      if (query.targetType !== undefined && item.targetType !== query.targetType) return false
      if (query.targetId !== undefined && item.targetId !== query.targetId) return false
      return true
    })
    const sorted = [...filtered].sort((a, b) => b.atMs - a.atMs || b.id - a.id)
    const offset = query.offset ?? 0
    const limit = query.limit ?? 50
    return {
      items: sorted.slice(offset, offset + limit),
      total: sorted.length,
      offset,
      limit,
    }
  }

  stats(actor: string): AuditStatsLike {
    this.reads.push({ actor })
    const byAction = new Map<string, number>()
    const byActor = new Map<string, number>()
    for (const item of this.items) {
      byAction.set(item.action, (byAction.get(item.action) ?? 0) + 1)
      byActor.set(item.actor, (byActor.get(item.actor) ?? 0) + 1)
    }
    return {
      total: this.items.length,
      today: this.items.length,
      last24h: this.items.length,
      failed: this.items.filter((item) => item.result === 'failed').length,
      lastAt: this.items.length === 0 ? null : this.items[this.items.length - 1]!.at,
      byAction: [...byAction].map(([action, count]) => ({ action, count })),
      byActor: [...byActor].map(([actor, count]) => ({ actor, count })),
    }
  }

  /** 只给用例读：预置一条历史记录（模拟「昨天有人改过余额」）。 */
  seed(entry: AuditEntryLike): AuditRecordLike {
    return this.record(entry)
  }
}

/** 运维总览的假实现：返回一份现成的报告，可让 observe 抛错。 */
export class FakeObservability implements ObservabilityPort {
  calls = 0
  /** 置 true 后 observe 抛领域错误（验证 5xx / 透传）。 */
  failCode: string | undefined
  report: unknown = sampleObservabilityReport()

  async observe(): Promise<unknown> {
    this.calls += 1
    if (this.failCode !== undefined) throw new DomainError(this.failCode, '测试拒绝：聚合失败')
    return this.report
  }
}

/** 一份「六块都有、金额是字符串、没有 bigint」的报告样本。 */
export function sampleObservabilityReport(): Record<string, unknown> {
  return {
    generatedAt: '2026-10-29T12:00:00.000Z',
    usage: {
      health: { state: 'ok', detail: '' },
      service: {
        records: 1234,
        polling: true,
        consecutiveFailures: 0,
        lastError: null,
        gapRecords: 17,
        rejectedCount: 2,
        rejectedPending: 1,
        pricingAvailable: true,
        epoch: 'epoch-1',
        lastSeq: 900,
      },
      gateway: {
        epoch: 'epoch-1',
        capacity: 32768,
        size: 120,
        firstSeq: 781,
        lastSeq: 900,
        dropped: 5,
        gap: 5,
      },
      gatewayHealth: { state: 'ok', detail: '' },
    },
    billing: {
      health: { state: 'ok', detail: '' },
      totals: {
        records: 100,
        settled: 90,
        pending: 3,
        settling: 0,
        noPrice: 3,
        noUser: 1,
        failed: 2,
        review: 1,
        overdrawn: 2,
      },
      chargedMicros: '12345678',
      today: { date: '2026-10-29', settled: 24, chargedMicros: '900000' },
    },
    quota: {
      health: { state: 'ok', detail: '' },
      ready: true,
      revision: 'rev-1',
      generation: 7,
      size: 3,
      ageMs: 1200,
      ttlMs: 15000,
      stale: false,
    },
    runtime: { health: { state: 'ok', detail: '' }, active: 4, cooling: 1 },
    audit: {
      health: { state: 'ok', detail: '' },
      total: 3,
      failed: 1,
      lastAt: '2026-10-29T11:00:00.000Z',
      recentActions: [{ action: 'user.balance.adjust', count: 2 }],
      windowLimit: 200,
      windowTruncated: false,
      latest: [
        {
          at: '2026-10-29T11:00:00.000Z',
          actor: 'user:1:admin',
          action: 'user.balance.adjust',
          targetType: 'user',
          targetId: '7',
          summary: '调整用户 #7 的余额',
          result: 'ok',
          errorCode: null,
        },
      ],
    },
    accounts: {
      health: { state: 'ok', detail: '' },
      total: 5,
      enabled: 4,
      unknown: 2,
      healthy: 1,
      degraded: 1,
      unhealthy: 1,
      autoDisabled: 1,
      lastPass: { checked: 5, healthy: 4, failed: 1, autoDisabled: 1, autoEnabled: 0 },
      lastPassAt: '2026-10-29T11:30:00.000Z',
      running: false,
    },
    warnings: ['USAGE_GAP', 'BILLING_REVIEW', 'QUOTA_SNAPSHOT_STALE'],
    degraded: true,
  }
}

export interface Fixture {
  readonly runtime: ApiRuntime
  readonly user: FakeUser
  readonly auth: FakeAuth
  readonly frontend: FakeFrontend
  readonly catalog: FakeCatalog
  readonly accountAdmin: FakeAccountAdmin
  readonly settings: FakeSettings
  readonly apiKey: FakeApiKey
  readonly priority: FakeAccountPriority
  readonly usage: FakeUsage
  readonly pricing: FakePricing
  readonly redeem: FakeRedeem
  readonly billing: FakeBilling
  readonly topup: FakeTopup
  readonly modelhub: FakeModelHub
  readonly audit: FakeAudit
  readonly observability: FakeObservability
  readonly cleanup: () => Promise<void>
}

export interface FixtureOptions {
  readonly config?: Record<string, unknown>
  readonly withApiKey?: boolean
  readonly withSettings?: boolean
  readonly withoutFrontend?: boolean
  /** 模拟新前端 web 在跑（旧 SPA 缺失时健康检查不再报 degraded）。 */
  readonly withWeb?: boolean
  readonly withoutCatalog?: boolean
  readonly withoutAccountAdmin?: boolean
  readonly withoutPriority?: boolean
  readonly withoutUsage?: boolean
  readonly withoutPricing?: boolean
  readonly withoutRedeem?: boolean
  readonly withoutBilling?: boolean
  readonly withoutTopup?: boolean
  readonly withoutModelHub?: boolean
  readonly withoutAudit?: boolean
  readonly withoutObservability?: boolean
  readonly pages?: FrontendPageLike[]
}

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const user = new FakeUser()
  const auth = new FakeAuth(user)
  const frontend = await createFakeFrontend(options.pages ?? [])
  const catalog = new FakeCatalog()
  const accountAdmin = new FakeAccountAdmin()
  const settings = new FakeSettings()
  const apiKey = new FakeApiKey()
  const priority = new FakeAccountPriority()
  const usage = new FakeUsage()
  const pricing = new FakePricing()
  const redeem = new FakeRedeem()
  const billing = new FakeBilling()
  const topup = new FakeTopup()
  const modelhub = new FakeModelHub()
  const audit = new FakeAudit()
  const observability = new FakeObservability()

  const runtime: ApiRuntime = {
    config: resolvedConfig(options.config),
    user,
    auth,
    frontend: () => (options.withoutFrontend === true ? undefined : frontend),
    web: () => options.withWeb === true ? {} : undefined,
    catalog: () => (options.withoutCatalog === true ? undefined : catalog),
    accountAdmin: () => (options.withoutAccountAdmin === true ? undefined : accountAdmin),
    settings: () => (options.withSettings === false ? undefined : settings),
    apiKey: () => (options.withApiKey === false ? undefined : apiKey),
    accountPriority: () => (options.withoutPriority === true ? undefined : priority),
    usage: () => (options.withoutUsage === true ? undefined : usage),
    pricing: () => (options.withoutPricing === true ? undefined : pricing),
    redeem: () => (options.withoutRedeem === true ? undefined : redeem),
    billing: () => (options.withoutBilling === true ? undefined : billing),
    topup: () => (options.withoutTopup === true ? undefined : topup),
    modelhub: () => (options.withoutModelHub === true ? undefined : modelhub),
    audit: () => (options.withoutAudit === true ? undefined : audit),
    observability: () => (options.withoutObservability === true ? undefined : observability),
    now: () => new Date('2026-10-19T12:00:00.000Z'),
    uptimeSec: () => 42,
    log: () => undefined,
  }

  return {
    runtime,
    user,
    auth,
    frontend,
    catalog,
    accountAdmin,
    settings,
    apiKey,
    priority,
    usage,
    pricing,
    redeem,
    billing,
    topup,
    modelhub,
    audit,
    observability,
    async cleanup() {
      await rm(frontend.root, { recursive: true, force: true })
    },
  }
}
