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
  AuthPort,
  CatalogPluginLike,
  CatalogPort,
  FrontendPageLike,
  FrontendPort,
  LoginResultLike,
  ModelPriceLike,
  PricingPort,
  SessionViewLike,
  SettingsPort,
  TicketLike,
  UsagePort,
  UsageQueryLike,
  UsageRowLike,
  UsageStatsLike,
  UsageStatusLike,
  UsageSummaryLike,
  UserLike,
  UserPort,
  UserStatusLike,
} from '../src/types.ts'

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

  async describe(): Promise<unknown> {
    this.calls.push({ method: 'describe', args: [] })
    // 真实 settings 服务的形状；HTTP 层必须原样透传 `{ namespaces }`。
    return { namespaces: this.namespaces }
  }

  async update(actor: string, ns: string, patch: Record<string, unknown>, expectedRevision?: string): Promise<unknown> {
    this.calls.push({ method: 'update', args: [actor, ns, patch, expectedRevision] })
    return { ns, revision: 'rev-2', patch }
  }

  async reset(actor: string, ns: string): Promise<unknown> {
    this.calls.push({ method: 'reset', args: [actor, ns] })
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
  readonly cleanup: () => Promise<void>
}

export interface FixtureOptions {
  readonly config?: Record<string, unknown>
  readonly withApiKey?: boolean
  readonly withSettings?: boolean
  readonly withoutFrontend?: boolean
  readonly withoutCatalog?: boolean
  readonly withoutAccountAdmin?: boolean
  readonly withoutPriority?: boolean
  readonly withoutUsage?: boolean
  readonly withoutPricing?: boolean
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

  const runtime: ApiRuntime = {
    config: resolvedConfig(options.config),
    user,
    auth,
    frontend: () => (options.withoutFrontend === true ? undefined : frontend),
    catalog: () => (options.withoutCatalog === true ? undefined : catalog),
    accountAdmin: () => (options.withoutAccountAdmin === true ? undefined : accountAdmin),
    settings: () => (options.withSettings === false ? undefined : settings),
    apiKey: () => (options.withApiKey === false ? undefined : apiKey),
    accountPriority: () => (options.withoutPriority === true ? undefined : priority),
    usage: () => (options.withoutUsage === true ? undefined : usage),
    pricing: () => (options.withoutPricing === true ? undefined : pricing),
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
    async cleanup() {
      await rm(frontend.root, { recursive: true, force: true })
    },
  }
}
