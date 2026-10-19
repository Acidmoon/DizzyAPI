import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import { addMilliseconds, describeError, isExpired, isIssueList, nowIso } from '@dizzyapi/plugin-kit'
import type { MailerService } from '@dizzyapi/plugin-mailer'
import { isUserError, type User, type UserId, type UserService } from '@dizzyapi/plugin-user'
import { AUTH_CONFIG_SCHEMA, validateAuthConfig, type AuthConfig, type ResolvedAuthConfig } from './config.ts'
import {
  constantTimeEqualHex,
  consumeDummyVerify,
  hashPassword,
  randomCode,
  randomSalt,
  randomSessionId,
  randomToken,
  sha256Hex,
  verifyPassword,
} from './crypto.ts'
import { AuthDatabase } from './db.ts'
import { AuthError } from './errors.ts'
import type {
  DeviceMeta,
  LoginResult,
  PendingCode,
  PendingPurpose,
  Session,
  SessionSummary,
  SessionView,
  Ticket,
} from './model.ts'

/** 会话的 lastSeenAt 最多每分钟写一次库：界面请求会把库写爆，而它只用于排障。 */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

/**
 * 鉴权插件：注册（邮箱验证码）、登录（密码校验）、会话签发与校验。
 *
 * **它不进 LLM 请求链路**。LLM 请求的身份是 API key，
 * 由 Go 的 key-auth 阶段在数据面解析；这里服务的是**界面请求**：
 * 用户在浏览器里没有 API key 的生命周期，需要「登录 → 会话令牌」。
 *
 * 依赖两个插件，用 `inject` 声明（没有它们就不启动）：
 * - `user`：用户表。注册成功的最后一步是往用户表新增用户。
 * - `mailer`：外部通讯模块。验证码必须真发出去，发不出去就失败（D7 的取向）。
 *
 * 全部改动串行执行（同一条队列）。存储是 SQLite（`node:sqlite` 的 DatabaseSync）：
 * 单次改动在一个 `BEGIN IMMEDIATE` 事务里完成，事务里不 await 任何异步服务；
 * 密码派生、发信这些异步动作发生在事务之外。
 * 这是控制面流量，量小，串行没有代价。
 */
export class AuthService extends Service {
  static Config = AUTH_CONFIG_SCHEMA

  /**
   * 依赖声明。**必须是类上的静态属性**：loader 拿到的是模块的默认导出（这个类），
   * 模块级的 `export const inject` 它看不见——那样写的结果是插件在依赖就绪之前就构造，
   * 表现为「mailer 明明启用了却报 mailer 不在运行」。
   *
   * 声明之后 cordis 会把 fiber 挂在 PENDING，等 user 与 mailer 都就绪才构造；
   * 依赖被禁用时本插件也就不启动（这正是 D16 说的「依赖是否满足」）。
   */
  static inject = ['user', 'mailer']

  /** 能力清单：鉴权 / 会话是界面请求的入口，与 LLM 请求无关。 */
  static catalog = {
    capabilities: ['authentication', 'sessions', 'registration', 'password-reset'],
    events: [],
    bridge: [],
    storage: [{ key: 'dataPath', kind: 'file', description: '凭证 / 会话 / 验证码 / 计数 SQLite' }],
  } as const

  readonly config: ResolvedAuthConfig
  private db: AuthDatabase
  private user: UserService
  private mailer: MailerService
  private logger: Logger
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: AuthConfig | ResolvedAuthConfig = {}) {
    super(ctx, 'auth')

    const resolved = validateAuthConfig(config)
    if (isIssueList(resolved)) {
      throw new AuthError('AUTH_DEPENDENCY_MISSING', `鉴权配置不合法：${resolved.map((item) => item.message).join('；')}`)
    }
    this.config = resolved

    const user = ctx.get('user') as UserService | undefined
    if (user === undefined) {
      throw new AuthError('AUTH_DEPENDENCY_MISSING', '用户插件（user）不在运行：注册最后一步要往用户表新增用户')
    }
    const mailer = ctx.get('mailer') as MailerService | undefined
    if (mailer === undefined) {
      throw new AuthError('AUTH_DEPENDENCY_MISSING', '外部通讯模块（mailer）不在运行：验证码发不出去')
    }
    this.user = user
    this.mailer = mailer
    this.db = new AuthDatabase(resolveDataPath(ctx, this.config.dataPath))
    this.logger = ctx.logger('auth')

    this.logger.info(
      `鉴权插件已装载：存储 ${this.db.describe}；建用户时自报 ${this.config.userActor}；` +
        `验证码 ${this.config.codeDigits} 位 / ${Math.round(this.config.codeTtlMs / 60_000)} 分钟；` +
        `会话 ${Math.round(this.config.sessionTtlMs / 3600_000)} 小时`,
    )
    if (this.db.legacyImport !== undefined) {
      this.logger.info(
        `已从旧 auth.json 导入 ${this.db.legacyImport.credentials} 条凭证、` +
          `${this.db.legacyImport.pendings} 条验证码、${this.db.legacyImport.sessions} 个会话、` +
          `${this.db.legacyImport.counters} 个计数窗口（旧文件保留）`,
      )
    }

    // 注册即副作用：插件被卸载时数据库连接跟着关闭（AGENTS.md D5）。
    ctx.effect(() => () => this.db.close(), 'auth.db')
  }

  // ────────────────────────────── 注册 ──────────────────────────────

  /**
   * 第一步：申请注册，网关生成验证码并交给外部通讯模块发给该邮箱。
   *
   * 返回的回执**不透露该邮箱是否已经注册**：邮箱已被占用时不发信，但回执形状一致，
   * 否则这个接口就成了账号枚举器。
   */
  async requestRegistration(input: { email: string; password: string; name?: string }): Promise<Ticket> {
    const email = normalizeEmail(input?.email)
    const passwordHash = await hashPassword(assertPasswordStrength(input?.password, this.config))
    const name = input?.name === undefined ? undefined : normalizeRequestedName(input.name)

    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)

      const count = this.db.bumpCounter(`code:register:${email}`, 3600_000, now)
      if (count > this.config.codeRequestsPerHour) {
        throw new AuthError('AUTH_RATE_LIMITED', '验证码请求过于频繁，请稍后再试')
      }

      const existing = this.db.getCredentialByEmail(email)
      if (existing !== undefined) {
        const user = await this.user.get(existing.userId)
        if (user !== undefined) {
          this.logger.warn(`注册申请：邮箱已占用，按防枚举策略静默受理 email=${email}`)
          return this.genericTicket(email, now)
        }
        // 用户被删掉了但凭证还在（孤儿）：允许重新注册，顺手清干净
        this.dropCredential(existing.userId)
      }

      const cooldown = this.cooldownRemaining('register', email, now)
      if (cooldown > 0) {
        return { email, expiresAt: addMilliseconds(now, this.config.codeTtlMs), resendAfterMs: cooldown }
      }

      const ticket = await this.issueCode('register', email, now, { name, passwordHash })
      this.logger.info(`注册申请：验证码已发出 email=${email}`)
      return ticket
    })
  }

  /**
   * 第二步：核对验证码。通过之后才在用户表新增用户、写入凭证，并直接签发会话
   * （注册即登录，省掉一次密码校验）。
   */
  async confirmRegistration(input: { email: string; code: string }): Promise<LoginResult> {
    const email = normalizeEmail(input?.email)
    const code = normalizeCode(input?.code)

    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)

      const pending = await this.verifyCode('register', email, code, now)

      const existing = this.db.getCredentialByEmail(email)
      if (existing !== undefined) {
        const user = await this.user.get(existing.userId)
        if (user !== undefined) {
          this.db.deletePending('register', email)
          throw new AuthError('AUTH_EMAIL_TAKEN', `邮箱 ${email} 已经注册过了，直接登录即可`)
        }
        this.dropCredential(existing.userId)
      }

      const passwordHash = pending.passwordHash
      if (passwordHash === undefined) {
        this.db.deletePending('register', email)
        throw new AuthError('AUTH_CODE_INVALID', '这次注册缺少密码信息，请重新申请验证码')
      }

      const user = await this.createUser(email, pending.name)
      const session = this.newSession(user.id, now)
      try {
        this.db.transaction(() => {
          this.db.insertCredential({
            userId: user.id,
            email,
            passwordHash,
            createdAt: now,
            updatedAt: now,
          })
          this.db.deletePending('register', email)
          this.db.insertSession(session.record)
        })
        this.logger.info(`注册完成：user=#${user.id} name=${user.name} email=${email}`)
        return {
          token: session.token,
          sessionId: session.record.id,
          expiresAt: session.record.expiresAt,
          user,
        }
      } catch (error) {
        // 凭证 / 会话事务已回滚 → 把刚建的用户删掉（余额为 0，用户插件允许删），
        // 不留「有用户没凭证」的孤儿。跨两个存储，只能这样补偿。
        try {
          await this.user.remove(this.config.userActor, user.id)
        } catch (cleanupError) {
          this.logger.error(
            `注册失败后清理用户 #${user.id} 也失败，请人工检查：${describeError(cleanupError)}`,
          )
        }
        throw error
      }
    })
  }

  // ────────────────────────── 登录与会话 ──────────────────────────

  /**
   * 登录：先核对凭证里的密码，再核对用户表里的身份与状态
   * （用户不存在 / 已封禁都在这一步拦下）。
   */
  async login(input: { email: string; password: string; meta?: DeviceMeta }): Promise<LoginResult> {
    const email = normalizeEmail(input?.email)
    const password = input?.password
    if (typeof password !== 'string' || password === '') {
      throw new AuthError('AUTH_CREDENTIALS_INVALID', '邮箱或密码错误')
    }

    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)

      if (
        this.db.readCounter(`login:${email}`, this.config.loginWindowMs, now) >=
        this.config.loginMaxFailures
      ) {
        throw new AuthError('AUTH_RATE_LIMITED', '登录失败次数过多，请稍后再试')
      }

      const credential = this.db.getCredentialByEmail(email)
      if (credential === undefined) {
        // 邮箱不存在时也走一次等价的派生运算，别让响应时间泄漏「这个邮箱没注册」
        await consumeDummyVerify(password)
        this.db.bumpCounter(`login:${email}`, this.config.loginWindowMs, now)
        this.logger.warn(`登录失败：邮箱不存在 email=${email}`)
        throw new AuthError('AUTH_CREDENTIALS_INVALID', '邮箱或密码错误')
      }

      if (!(await verifyPassword(credential.passwordHash, password))) {
        this.db.bumpCounter(`login:${email}`, this.config.loginWindowMs, now)
        this.logger.warn(`登录失败：密码不正确 user=#${credential.userId}`)
        throw new AuthError('AUTH_CREDENTIALS_INVALID', '邮箱或密码错误')
      }

      const user = await this.user.get(credential.userId)
      if (user === undefined) {
        throw new AuthError('AUTH_USER_MISSING', '账号已不存在，请联系管理员')
      }
      if (user.status === 'banned') {
        this.logger.warn(`登录被拒：账号已封禁 user=#${user.id}`)
        throw new AuthError('AUTH_USER_BANNED', '账号已被封禁')
      }

      this.db.resetCounter(`login:${email}`)
      const session = this.newSession(user.id, now)
      this.db.transaction(() => this.db.insertSession(session.record))
      this.logger.info(`登录成功：user=#${user.id} name=${user.name} session=${session.record.id}`)
      return {
        token: session.token,
        sessionId: session.record.id,
        expiresAt: session.record.expiresAt,
        user,
      }
    })
  }

  /**
   * 校验会话：**界面请求的身份入口**。
   * 调用方（用户站 / 管理台，或经桥过来的 Go）拿令牌换来「这是谁」。
   */
  async verifySession(token: string): Promise<SessionView> {
    const raw = normalizeToken(token)
    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)
      const { record, user } = await this.requireSession(raw, now)

      let lastSeenAt = record.lastSeenAt
      if (Date.parse(now) - Date.parse(record.lastSeenAt) > LAST_SEEN_WRITE_INTERVAL_MS) {
        lastSeenAt = now
        this.db.updateSessionLastSeen(record.id, now)
      }

      const credential = this.db.getCredentialByUserId(record.userId)
      return {
        sessionId: record.id,
        userId: record.userId,
        user,
        ...(credential === undefined ? {} : { email: credential.email }),
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        lastSeenAt,
      }
    })
  }

  /** 登出：删掉这一个会话。令牌无效也不报错——登出要幂等。 */
  async logout(token: string): Promise<void> {
    const raw = normalizeToken(token)
    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)
      const record = this.db.getSessionByTokenHash(sha256Hex(raw))
      if (record !== undefined) this.db.deleteSessionById(record.id)
    })
  }

  async listSessions(token: string): Promise<SessionSummary[]> {
    const raw = normalizeToken(token)
    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)
      const { record } = await this.requireSession(raw, now)
      return this.db.listSessionsByUser(record.userId).map((item) => ({
        sessionId: item.id,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        lastSeenAt: item.lastSeenAt,
        current: item.id === record.id,
      }))
    })
  }

  /** 吊销指定会话；只能吊销自己的。 */
  async revokeSession(token: string, sessionId: string): Promise<void> {
    const raw = normalizeToken(token)
    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)
      const { record } = await this.requireSession(raw, now)

      const target = this.db.getSessionById(sessionId)
      if (target === undefined || target.userId !== record.userId) {
        throw new AuthError('AUTH_SESSION_INVALID', '没有这个会话')
      }
      this.db.deleteSessionById(sessionId)
      this.logger.info(`会话已吊销：user=#${record.userId} session=${sessionId}`)
    })
  }

  /** 吊销该用户的全部会话（含当前这个）。 */
  async revokeAllSessions(token: string): Promise<number> {
    const raw = normalizeToken(token)
    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)
      const { record } = await this.requireSession(raw, now)

      const removed = this.db.deleteSessionsByUser(record.userId)
      this.logger.info(`全部会话已吊销：user=#${record.userId} 共 ${removed} 个`)
      return removed
    })
  }

  // ────────────────────────────── 密码 ──────────────────────────────

  /** 改密：先验当前密码；改完把**其它**会话都作废，当前会话保留。 */
  async changePassword(
    token: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ revokedSessions: number }> {
    const raw = normalizeToken(token)
    const next = assertPasswordStrength(newPassword, this.config)

    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)
      const { record, user } = await this.requireSession(raw, now)

      const credential = this.db.getCredentialByUserId(user.id)
      if (credential === undefined) {
        throw new AuthError('AUTH_USER_MISSING', '账号缺少凭证，请联系管理员')
      }
      if (
        typeof currentPassword !== 'string' ||
        !(await verifyPassword(credential.passwordHash, currentPassword))
      ) {
        throw new AuthError('AUTH_CREDENTIALS_INVALID', '当前密码不正确')
      }

      const nextHash = await hashPassword(next)
      const others = this.db.transaction(() => {
        this.db.updateCredentialPassword(user.id, nextHash, now)
        return this.db.deleteOtherSessionsByUser(user.id, record.id)
      })
      this.logger.info(`密码已修改：user=#${user.id}，作废其它会话 ${others} 个`)
      return { revokedSessions: others }
    })
  }

  /** 申请重置密码：同样不透露邮箱是否存在。 */
  async requestPasswordReset(emailInput: string): Promise<Ticket> {
    const email = normalizeEmail(emailInput)

    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)

      const count = this.db.bumpCounter(`code:reset:${email}`, 3600_000, now)
      if (count > this.config.codeRequestsPerHour) {
        throw new AuthError('AUTH_RATE_LIMITED', '验证码请求过于频繁，请稍后再试')
      }

      const credential = this.db.getCredentialByEmail(email)
      if (credential === undefined || (await this.user.get(credential.userId)) === undefined) {
        return this.genericTicket(email, now)
      }

      const cooldown = this.cooldownRemaining('reset', email, now)
      if (cooldown > 0) {
        return { email, expiresAt: addMilliseconds(now, this.config.codeTtlMs), resendAfterMs: cooldown }
      }

      const ticket = await this.issueCode('reset', email, now, {})
      this.logger.info(`重置密码：验证码已发出 user=#${credential.userId}`)
      return ticket
    })
  }

  /** 重置密码：验证码通过后换掉密码，并把该用户的**全部**会话作废。 */
  async confirmPasswordReset(input: {
    email: string
    code: string
    password: string
  }): Promise<{ userId: UserId; revokedSessions: number }> {
    const email = normalizeEmail(input?.email)
    const code = normalizeCode(input?.code)
    const next = assertPasswordStrength(input?.password, this.config)

    return this.exclusive(async () => {
      const now = nowIso()
      this.prune(now)

      await this.verifyCode('reset', email, code, now)

      const credential = this.db.getCredentialByEmail(email)
      if (credential === undefined) {
        throw new AuthError('AUTH_CODE_INVALID', '验证码无效或已过期')
      }
      const user = await this.user.get(credential.userId)
      if (user === undefined) {
        throw new AuthError('AUTH_USER_MISSING', '账号已不存在，请联系管理员')
      }

      const nextHash = await hashPassword(next)
      const revoked = this.db.transaction(() => {
        this.db.updateCredentialPassword(user.id, nextHash, now)
        this.db.deletePending('reset', email)
        return this.db.deleteSessionsByUser(user.id)
      })
      this.logger.info(`密码已重置：user=#${user.id}，作废会话 ${revoked} 个`)
      return { userId: user.id, revokedSessions: revoked }
    })
  }

  // ────────────────────────────── 资料 ──────────────────────────────

  /**
   * 只读查询某用户的邮箱，供 API 层组装资料 DTO。
   * 返回 null 表示没有凭证；**不返回密码哈希**。
   */
  async getEmail(userId: UserId): Promise<string | null> {
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0) return null
    return this.exclusive(async () => this.db.getCredentialByUserId(userId)?.email ?? null)
  }

  // ────────────────────────────── 内部 ──────────────────────────────

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.then(noop, noop)
    return result
  }

  /** 清掉过期的验证码、会话与计数窗口。同步、幂等。 */
  private prune(now: string): void {
    this.db.prune(now)
  }

  /** 生成验证码、落库，然后交给外部通讯模块发出去；发信失败就撤掉这个码。 */
  private async issueCode(
    purpose: PendingPurpose,
    email: string,
    now: string,
    extra: { name?: string; passwordHash?: string },
  ): Promise<Ticket> {
    const code = randomCode(this.config.codeDigits)
    const salt = randomSalt()
    const pending: PendingCode = {
      purpose,
      email,
      codeHash: sha256Hex(`${salt}:${code}`),
      salt,
      attempts: 0,
      createdAt: now,
      expiresAt: addMilliseconds(now, this.config.codeTtlMs),
      name: extra.name,
      passwordHash: extra.passwordHash,
    }

    // 先把码写进存储再发信：否则会出现「用户收到了码，服务器不认」
    this.db.transaction(() => {
      this.db.deletePending(purpose, email)
      this.db.upsertPending(pending)
    })

    try {
      await this.mailer.send({
        to: email,
        subject: `${this.config.mailSubjectPrefix} ${purpose === 'register' ? '注册验证码' : '重置密码验证码'}`,
        text: composeMailText(purpose, code, this.config),
        kind: `auth-${purpose}-code`,
      })
    } catch (error) {
      this.db.deletePending(purpose, email)
      throw new AuthError('AUTH_MAIL_FAILED', `验证码发送失败：${describeError(error)}`)
    }

    return {
      email,
      expiresAt: addMilliseconds(now, this.config.codeTtlMs),
      resendAfterMs: this.config.codeResendCooldownMs,
    }
  }

  /**
   * 核对验证码。失败计数与「超过上限即作废」必须在同一个事务里落库：
   * 否则一次失败的尝试可能既不计数也不作废。
   */
  private async verifyCode(
    purpose: PendingPurpose,
    email: string,
    code: string,
    now: string,
  ): Promise<PendingCode> {
    const outcome = this.db.transaction(() => {
      const pending = this.db.getPending(purpose, email)
      if (pending === undefined) return { kind: 'missing' } as const
      if (isExpired(pending.expiresAt, now)) {
        this.db.deletePending(purpose, email)
        return { kind: 'expired' } as const
      }

      const expected = sha256Hex(`${pending.salt}:${code}`)
      if (!constantTimeEqualHex(expected, pending.codeHash)) {
        const attempts = pending.attempts + 1
        if (attempts >= this.config.codeMaxAttempts) {
          this.db.deletePending(purpose, email)
          return { kind: 'exceeded' } as const
        }
        this.db.setPendingAttempts(purpose, email, attempts)
        return { kind: 'wrong' } as const
      }

      return { kind: 'ok', pending } as const
    })

    if (outcome.kind === 'missing' || outcome.kind === 'expired' || outcome.kind === 'wrong') {
      throw new AuthError('AUTH_CODE_INVALID', '验证码无效或已过期')
    }
    if (outcome.kind === 'exceeded') {
      throw new AuthError('AUTH_CODE_ATTEMPTS_EXCEEDED', '验证码错误次数过多，请重新获取')
    }
    return outcome.pending
  }

  private cooldownRemaining(purpose: PendingPurpose, email: string, now: string): number {
    const pending = this.db.getPending(purpose, email)
    if (pending === undefined) return 0
    const readyAt = Date.parse(pending.createdAt) + this.config.codeResendCooldownMs
    return Math.max(0, readyAt - Date.parse(now))
  }

  private genericTicket(email: string, now: string): Ticket {
    return { email, expiresAt: addMilliseconds(now, this.config.codeTtlMs), resendAfterMs: 0 }
  }

  private dropCredential(userId: UserId): void {
    this.db.transaction(() => {
      this.db.deleteCredentialByUserId(userId)
      this.db.deleteSessionsByUser(userId)
    })
  }

  private newSession(userId: UserId, now: string): { token: string; record: Session } {
    const token = randomToken()
    return {
      token,
      record: {
        id: randomSessionId(),
        userId,
        tokenHash: sha256Hex(token),
        createdAt: now,
        expiresAt: addMilliseconds(now, this.config.sessionTtlMs),
        lastSeenAt: now,
      },
    }
  }

  /** 令牌 → 会话 + 用户；无效、过期、用户没了、被封禁都在这里拦下。 */
  private async requireSession(
    rawToken: string,
    now: string,
  ): Promise<{ record: Session; user: User }> {
    const record = this.db.getSessionByTokenHash(sha256Hex(rawToken))
    if (record === undefined) {
      throw new AuthError('AUTH_SESSION_INVALID', '会话无效，请重新登录')
    }
    if (isExpired(record.expiresAt, now)) {
      this.db.deleteSessionById(record.id)
      throw new AuthError('AUTH_SESSION_EXPIRED', '会话已过期，请重新登录')
    }

    const user = await this.user.get(record.userId)
    if (user === undefined) throw new AuthError('AUTH_USER_MISSING', '账号已不存在，请联系管理员')
    if (user.status === 'banned') throw new AuthError('AUTH_USER_BANNED', '账号已被封禁')
    return { record, user }
  }

  /** 在用户表新增用户。用户没给名字时，用邮箱本地部分派生，撞名就加后缀。 */
  private async createUser(email: string, requested: string | undefined): Promise<User> {
    const candidates = requested !== undefined ? [requested] : nameCandidates(email)
    let lastMessage = ''

    for (const candidate of candidates) {
      try {
        return await this.user.create(this.config.userActor, { name: candidate })
      } catch (error) {
        if (isUserError(error)) {
          if (error.code === 'USER_NAME_TAKEN') {
            lastMessage = error.message
            continue
          }
          if (error.code === 'USER_NAME_INVALID') {
            throw new AuthError('AUTH_NAME_UNAVAILABLE', `用户名不合法：${error.message}`)
          }
          if (error.code === 'USER_ACTOR_FORBIDDEN') {
            throw new AuthError(
              'AUTH_DEPENDENCY_MISSING',
              `用户插件没有授权 ${this.config.userActor} 建用户；请把它加进 user.adminPlugins`,
            )
          }
        }
        throw error
      }
    }

    throw new AuthError(
      'AUTH_NAME_UNAVAILABLE',
      requested !== undefined ? `用户名 ${requested} 已被占用` : `无法为 ${email} 找到可用用户名（${lastMessage}）`,
    )
  }
}

function noop(): void {
  // 只用来把队列里失败的 promise 咽掉，避免污染下一次 task
}

/** 相对路径按 cordis 的 baseUrl 解析；`:memory:` 原样传给存储层。 */
function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === ':memory:' || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function composeMailText(purpose: PendingPurpose, code: string, config: ResolvedAuthConfig): string {
  const minutes = Math.round(config.codeTtlMs / 60_000)
  const lead =
    purpose === 'register'
      ? '你正在注册 DizzyAPI 账号。'
      : '你正在重置 DizzyAPI 账号的密码。'
  return [
    lead,
    '',
    `验证码：${code}`,
    '',
    `这条验证码 ${minutes} 分钟内有效。如果不是你本人操作，忽略本邮件即可。`,
    '为安全起见，请勿把验证码转发给任何人。',
  ].join('\n')
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AuthError('AUTH_EMAIL_INVALID', '邮箱必须是字符串')
  }
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('AUTH_EMAIL_INVALID', `邮箱格式不正确：${value}`)
  }
  return email
}

function normalizeCode(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('AUTH_CODE_INVALID', '验证码不能为空')
  }
  return value.trim()
}

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthError('AUTH_SESSION_INVALID', '会话令牌不能为空')
  }
  return value.trim()
}

/** 名字先按用户插件的规则做一次粗校验；细校验在用户插件那边。 */
function normalizeRequestedName(value: unknown): string {
  if (typeof value !== 'string') throw new AuthError('AUTH_NAME_UNAVAILABLE', '用户名必须是字符串')
  const name = value.trim()
  if (name === '') throw new AuthError('AUTH_NAME_UNAVAILABLE', '用户名不能为空')
  return name
}

function assertPasswordStrength(value: unknown, config: ResolvedAuthConfig): string {
  if (typeof value !== 'string') {
    throw new AuthError('AUTH_PASSWORD_WEAK', '密码必须是字符串')
  }
  if (value.length < config.passwordMinLength) {
    throw new AuthError('AUTH_PASSWORD_WEAK', `密码至少 ${config.passwordMinLength} 位`)
  }
  if (value.length > config.passwordMaxLength) {
    throw new AuthError('AUTH_PASSWORD_WEAK', `密码最多 ${config.passwordMaxLength} 位`)
  }
  if (value.trim() === '') {
    throw new AuthError('AUTH_PASSWORD_WEAK', '密码不能只有空白字符')
  }
  if (/^(.)\1+$/u.test(value)) {
    throw new AuthError('AUTH_PASSWORD_WEAK', '密码不能是同一个字符的重复')
  }
  return value
}

/** 邮箱本地部分派生用户名：alice@x.com → alice，撞名再试 alice-2 … alice-20。 */
function nameCandidates(email: string): string[] {
  const local = email.slice(0, email.lastIndexOf('@'))
  const base = local.replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase().slice(0, 32) || 'user'
  const candidates = [base]
  for (let index = 2; index <= 20; index += 1) candidates.push(`${base}-${index}`)
  return candidates
}
