/**
 * 会话夹具：假用户表与假认证（令牌只经 cookie 流动）。
 *
 * 从 `test/fixtures.ts` 按域拆出（§5.6：测试文件 500 行上限）。行为逐字未改。
 */
import type {
  AuthPort,
  LoginResultLike,
  SessionViewLike,
  TicketLike,
  UserLike,
  UserPort,
  UserStatusLike,
} from '../../src/types.ts'
import { DomainError } from './support.ts'

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
