import type { User, UserId } from '@dizzyapi/plugin-user'

/**
 * 凭证与会话的领域模型。
 *
 * 这里存的是「谁能证明自己是某个用户」：邮箱、密码哈希、会话。
 * 用户的业务属性（用户名 / 状态 / 余额）不在这里，在用户插件（D19）。
 */
export interface Credential {
  readonly userId: UserId
  /** 归一化后的邮箱：trim + 小写；登录标识就是它。 */
  readonly email: string
  /** scrypt$N$r$p$salt$hash；算法参数随哈希一起存，便于将来升级。 */
  readonly passwordHash: string
  readonly createdAt: string
  readonly updatedAt: string
}

export type PendingPurpose = 'register' | 'reset'

/** 待验证的验证码。码本身不落盘，只留哈希。 */
export interface PendingCode {
  readonly purpose: PendingPurpose
  readonly email: string
  readonly codeHash: string
  readonly salt: string
  readonly attempts: number
  readonly createdAt: string
  readonly expiresAt: string
  /** 注册时用户填的用户名；验证码通过后再据此建用户。 */
  readonly name?: string
  /** 注册时就已经算好的密码哈希：待验证期间也只存哈希，绝不存明文。 */
  readonly passwordHash?: string
}

/** 会话。令牌本身不落盘，只留哈希。 */
export interface Session {
  readonly id: string
  readonly userId: UserId
  readonly tokenHash: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
}

/** 限流计数窗口：key 见 service 里的拼法（如 `login:foo@bar`）。 */
export interface RateCounter {
  readonly key: string
  readonly count: number
  readonly windowStart: string
  readonly windowMs: number
}

export interface AuthSnapshot {
  readonly credentials: readonly Credential[]
  readonly pendings: readonly PendingCode[]
  readonly sessions: readonly Session[]
  readonly counters: readonly RateCounter[]
}

/** 注册 / 找回的受理回执：**不透露该邮箱是否已注册**。 */
export interface Ticket {
  readonly email: string
  readonly expiresAt: string
  /** 距离可以再次请求验证码还有多久；0 表示现在就能重发。 */
  readonly resendAfterMs: number
}

export interface LoginResult {
  readonly token: string
  readonly sessionId: string
  readonly expiresAt: string
  readonly user: User
}

/** 会话校验的结果：界面请求据此把「请求」关联到「用户」。 */
export interface SessionView {
  readonly sessionId: string
  readonly userId: UserId
  readonly user: User
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
}

export interface SessionSummary {
  readonly sessionId: string
  readonly createdAt: string
  readonly expiresAt: string
  readonly lastSeenAt: string
  readonly current: boolean
}

export interface DeviceMeta {
  /** 预留给将来记进会话的客户端信息（UA / IP）；v1 只透传不落盘。 */
  readonly userAgent?: string
  readonly ip?: string
}
