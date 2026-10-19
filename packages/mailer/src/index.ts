import { Service, type Context, type Logger } from 'cordis'
import {
  checkConfigObject,
  isIssueList,
  issue,
  knownKeysOf,
  readBoolean,
  readPositiveInteger,
  readString,
  standardSchema,
  type FieldSpec,
  type StandardIssue,
} from '@dizzyapi/plugin-kit'
import { sendSmtp, smtpMessageId, type SmtpConfig } from './smtp.ts'

/**
 * 外部通讯模块：把消息发出去。
 *
 * 现在只做邮件（注册验证码、找回密码）。它是**能力型**插件（AGENTS.md D16）：
 * 不进 LLM 请求链路，只被别的插件依赖。谁要用它就 `inject` 它——
 * 发不出去的场合必须立刻失败，不能静默放过（D7 的取向）。
 */
export interface MailMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
  /** 供日志与排障：这条消息是什么（如 'register-code'）。 */
  readonly kind?: string
}

export interface SendReceipt {
  readonly id: string
  readonly to: string
  readonly transport: string
  readonly acceptedAt: string
}

export type MailerTransportKind = 'log' | 'smtp'

export interface MailerConfig {
  /** 默认 log：只写日志，开发用。生产用 smtp。 */
  readonly transport?: MailerTransportKind
  readonly from?: string
  readonly replyTo?: string
  readonly heloDomain?: string
  readonly timeoutMs?: number
  readonly rejectUnauthorized?: boolean
  /** 允许明文投递（跳过 STARTTLS）。默认 false。 */
  readonly allowPlaintext?: boolean
  readonly smtp?: {
    readonly host?: string
    readonly port?: number
    /** true = 直接 TLS（465）；false = 明文连上后 STARTTLS（587）。 */
    readonly secure?: boolean
    readonly user?: string
    /** 直接写在这里的密码。 */
    readonly pass?: string
    /** 或者给出环境变量名，运行期读取；避免把密码写进 app.yml。 */
    readonly passEnv?: string
    /**
     * 或者给出凭据插件里的引用名（推荐）。密码本体落在 credentials 插件，
     * 本文件与设置插件都只见到这个名字——它们不该成为第二个秘密仓库。
     */
    readonly passRef?: string
  }
}

export interface ResolvedMailerConfig {
  readonly transport: MailerTransportKind
  readonly from: string
  readonly replyTo: string | undefined
  readonly heloDomain: string
  readonly timeoutMs: number
  readonly rejectUnauthorized: boolean
  readonly allowPlaintext: boolean
  readonly smtp: ResolvedSmtpConfig | undefined
}

export interface ResolvedSmtpConfig {
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user: string | undefined
  /** 已经解析好的密码：来自内联 pass，或 passEnv 指向的环境变量。 */
  readonly pass: string | undefined
  /** 密码的来源之一：环境变量名（已在 pass 里解析）。 */
  readonly passEnv: string | undefined
  /** 密码的来源之一：凭据插件里的引用名，投递时才解析。 */
  readonly passRef: string | undefined
}

/**
 * 凭据插件的**结构性**接口：只声明 mailer 用到的两个方法，不 import 它的类
 * （AGENTS.md D16：能力型插件之间靠接口，不靠实现）。谁实现了它都能接上，
 * 测试里用个内存对象即可。
 */
export interface CredentialsSeam {
  resolve(ref: string): string | undefined
  describe(ref: string): { readonly configured: boolean }
}

/** 密码的来源与可用性。见 MailerService.credentialStatus。**不含值**。 */
export interface CredentialStatus {
  readonly kind: 'none' | 'inline' | 'env' | 'ref'
  /** 来源的名字：env 情形是环境变量名，ref 情形是凭据引用名。 */
  readonly ref?: string
  /** 本次投递能不能拿到密码。ref 情形下由凭据插件回报。 */
  readonly configured: boolean
}

export type MailerErrorCode =
  | 'MAILER_MESSAGE_INVALID'
  | 'MAILER_SEND_FAILED'
  | 'MAILER_SMTP_NOT_CONFIGURED'
  | 'MAILER_CREDENTIAL_MISSING'
  | 'MAILER_CREDENTIAL_UNAVAILABLE'

export class MailerError extends Error {
  readonly code: MailerErrorCode

  constructor(code: MailerErrorCode, message: string) {
    super(message)
    this.name = 'MailerError'
    this.code = code
  }
}

/** SMTP 子对象的字段元数据；`SMTP_KEYS` 从它派生，两份列表不会漂移。 */
const SMTP_FIELDS: readonly FieldSpec[] = [
  { key: 'host', label: '服务器', kind: 'string', writable: true },
  { key: 'port', label: '端口', kind: 'integer', writable: true, min: 1, max: 65_535 },
  { key: 'secure', label: '直连 TLS（465）', kind: 'boolean', writable: true },
  { key: 'user', label: '用户名', kind: 'string', writable: true },
  { key: 'pass', label: '密码（内联）', kind: 'string', writable: false, secret: true },
  { key: 'passEnv', label: '密码环境变量', kind: 'string', writable: false },
  { key: 'passRef', label: '凭据引用', kind: 'string', writable: true, credentialRef: true },
]

const MAILER_FIELDS: readonly FieldSpec[] = [
  { key: 'transport', label: '投递方式', kind: 'enum', values: ['log', 'smtp'], writable: true },
  { key: 'from', label: '发件人', kind: 'string', writable: true },
  { key: 'replyTo', label: '回复地址', kind: 'string', writable: true },
  { key: 'heloDomain', label: 'EHLO 域名', kind: 'string', writable: true },
  { key: 'timeoutMs', label: '超时', kind: 'integer', writable: true, min: 1000, max: 120_000, unit: '毫秒' },
  { key: 'rejectUnauthorized', label: '校验服务器证书', kind: 'boolean', writable: true },
  { key: 'allowPlaintext', label: '允许明文投递', kind: 'boolean', writable: true },
  { key: 'smtp', label: 'SMTP', kind: 'object', writable: true, fields: SMTP_FIELDS },
]

const KNOWN_KEYS = knownKeysOf(MAILER_FIELDS)
const SMTP_KEYS = knownKeysOf(SMTP_FIELDS)

export function validateMailerConfig(value: unknown): ResolvedMailerConfig | readonly StandardIssue[] {
  const { raw, issues } = checkConfigObject(value, KNOWN_KEYS)

  const transportRaw = readString(raw, 'transport', issues)
  if (transportRaw !== undefined && transportRaw !== 'log' && transportRaw !== 'smtp') {
    issues.push(issue('transport 只认 log 或 smtp'))
  }
  const transport: MailerTransportKind = transportRaw === 'smtp' ? 'smtp' : 'log'

  const from = readString(raw, 'from', issues)
  const replyTo = readString(raw, 'replyTo', issues)
  const heloDomain = readString(raw, 'heloDomain', issues)
  const timeoutMs = readPositiveInteger(raw, 'timeoutMs', issues, { min: 1000, max: 120_000 })
  const rejectUnauthorized = readBoolean(raw, 'rejectUnauthorized', issues)
  const allowPlaintext = readBoolean(raw, 'allowPlaintext', issues)

  let smtp: ResolvedSmtpConfig | undefined
  if (raw.smtp !== undefined) {
    if (typeof raw.smtp !== 'object' || raw.smtp === null || Array.isArray(raw.smtp)) {
      issues.push(issue('smtp 必须是一个对象'))
    } else {
      const smtpRaw = raw.smtp as Record<string, unknown>
      const smtpIssues = checkConfigObject(smtpRaw, SMTP_KEYS).issues
      issues.push(...smtpIssues)
      const host = readString(smtpRaw, 'host', issues)
      const port = readPositiveInteger(smtpRaw, 'port', issues, { min: 1, max: 65_535 })
      const secure = readBoolean(smtpRaw, 'secure', issues)
      const user = readString(smtpRaw, 'user', issues)
      const pass = readString(smtpRaw, 'pass', issues, { allowEmpty: true })
      const passEnv = readString(smtpRaw, 'passEnv', issues)
      const passRef = readString(smtpRaw, 'passRef', issues)
      // 三选一互斥：同时给多个一定是写错了，静默挑一个赢会让 passRef 变得不可预测
      if ([pass, passEnv, passRef].filter((value) => value !== undefined).length > 1) {
        issues.push(issue('smtp.pass / smtp.passEnv / smtp.passRef 只能给一个'))
      }
      const resolvedPass = pass ?? (passEnv !== undefined ? process.env[passEnv] : undefined)
      if (passEnv !== undefined && resolvedPass === undefined) {
        issues.push(issue(`smtp.passEnv 指向的环境变量 ${passEnv} 当前为空`))
      }
      // passRef 不在这里解析：校验必须同步，而凭据服务此刻未必已装载。留给 send。
      smtp = {
        host: host ?? '',
        port: port ?? 0,
        secure: secure ?? false,
        user,
        pass: resolvedPass,
        passEnv,
        passRef,
      }
    }
  }

  if (transport === 'smtp') {
    if (from === undefined) issues.push(issue('transport 为 smtp 时必须配置 from'))
    if (smtp === undefined) {
      issues.push(issue('transport 为 smtp 时必须配置 smtp'))
    } else {
      if (smtp.host === '') issues.push(issue('smtp.host 不能为空'))
      if (smtp.port === 0) issues.push(issue('smtp.port 必须在 1..65535'))
    }
  }

  if (issues.length > 0) return issues

  return {
    transport,
    from: from ?? 'no-reply@localhost',
    replyTo,
    heloDomain: heloDomain ?? 'localhost',
    timeoutMs: timeoutMs ?? 15_000,
    rejectUnauthorized: rejectUnauthorized ?? true,
    allowPlaintext: allowPlaintext ?? false,
    smtp,
  }
}

export const MAILER_CONFIG_SCHEMA = standardSchema<ResolvedMailerConfig>(
  'dizzyapi',
  validateMailerConfig,
  MAILER_FIELDS,
)

export class MailerService extends Service {
  static Config = MAILER_CONFIG_SCHEMA

  /** 能力清单：只发消息，不落盘、不发事件、不暴露桥命令。 */
  static catalog = {
    capabilities: ['email'],
    events: [],
    bridge: [],
    storage: [],
    shapes: {
      MailMessage: {
        description: 'send() 的入参',
        fields: {
          to: { type: 'string' },
          subject: { type: 'string' },
          text: { type: 'string' },
          kind: { type: 'string', optional: true, description: '用途标签，如 register-code' },
        },
      },
      SendReceipt: {
        description: 'send() 的回执',
        fields: {
          id: { type: 'string' },
          to: { type: 'string' },
          transport: { type: 'string' },
          acceptedAt: { type: 'string' },
        },
      },
    },
  } as const

  readonly config: ResolvedMailerConfig
  private logger: Logger

  constructor(ctx: Context, config: MailerConfig | ResolvedMailerConfig = {}) {
    super(ctx, 'mailer')
    const resolved = validateMailerConfig(config)
    if (isIssueList(resolved)) {
      throw new MailerError('MAILER_SEND_FAILED', `邮件配置不合法：${resolved.map((item) => item.message).join('；')}`)
    }
    this.config = resolved
    this.logger = ctx.logger('mailer')

    this.logger.info(`外部通讯模块已装载：投递方式 ${this.describe}`)
    if (this.config.transport === 'log') {
      this.logger.warn('投递方式是 log：消息正文（含验证码）会写进日志，仅限开发环境')
    }
    if (this.config.allowPlaintext && this.config.smtp?.user !== undefined) {
      this.logger.warn('allowPlaintext 开着且配了用户名：SMTP 凭据会以明文传输')
    }
    if (this.config.smtp?.passRef !== undefined && this.credentials() === undefined) {
      // 不在这里抛：装载顺序上凭据插件可能排在本插件之后。真正发不出去时在 send 里明确失败。
      this.logger.warn(
        `配置了 smtp.passRef=${this.config.smtp.passRef}，但当前没有可用的 credentials 服务；投递会失败`,
      )
    }
  }

  get describe(): string {
    if (this.config.transport === 'log') return 'log（只写日志）'
    const smtp = this.config.smtp
    return `smtp（${smtp?.host}:${smtp?.port}${smtp?.secure ? ' TLS' : ' STARTTLS'}）`
  }

  /**
   * 密码从哪来、配没配。**只回报状态，不回值**——排障与将来的界面靠它，
   * 不需要（也不该）看到密码本体。`configured` 指「本次投递能不能拿到密码」，
   * 没有密码（服务器不需要认证）时为 false。
   */
  get credentialStatus(): CredentialStatus {
    const smtp = this.config.smtp
    if (smtp === undefined) return { kind: 'none', configured: false }
    if (smtp.passEnv !== undefined) return { kind: 'env', ref: smtp.passEnv, configured: smtp.pass !== undefined }
    if (smtp.pass !== undefined) return { kind: 'inline', configured: true }
    if (smtp.passRef !== undefined) {
      const credentials = this.credentials()
      return {
        kind: 'ref',
        ref: smtp.passRef,
        configured: credentials?.describe(smtp.passRef).configured ?? false,
      }
    }
    return { kind: 'none', configured: false }
  }

  /**
   * 每次都现取凭据：**轮换密码不需要重启，下一次投递就用新值**。
   * strict=false 是「这个服务在不在」的正确问法——未装载时不抛，只回 undefined。
   */
  private credentials(): CredentialsSeam | undefined {
    return this.ctx.get('credentials', false) as CredentialsSeam | undefined
  }

  /** 解析出本次投递要用的密码；解析不出来就带着明确的原因失败（D7）。 */
  private resolvePass(smtp: ResolvedSmtpConfig): string | undefined {
    if (smtp.pass !== undefined) return smtp.pass
    if (smtp.passRef === undefined) return undefined

    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new MailerError(
        'MAILER_CREDENTIAL_UNAVAILABLE',
        `配置了 smtp.passRef=${smtp.passRef}，但当前没有可用的 credentials 服务`,
      )
    }
    const value = credentials.resolve(smtp.passRef)
    if (value === undefined) {
      throw new MailerError(
        'MAILER_CREDENTIAL_MISSING',
        `凭据 ${smtp.passRef} 尚未配置（用 credentials.set 写入后再投递）`,
      )
    }
    return value
  }

  async send(message: MailMessage): Promise<SendReceipt> {
    const problem = validateMessage(message)
    if (problem !== undefined) throw new MailerError('MAILER_MESSAGE_INVALID', problem)

    const id = smtpMessageId(this.config.heloDomain)
    const acceptedAt = new Date().toISOString()

    if (this.config.transport === 'log') {
      this.logger.info(
        `[log 投递] to=${message.to} subject=${message.subject} kind=${message.kind ?? '-'}\n${message.text}`,
      )
      return { id, to: message.to, transport: 'log', acceptedAt }
    }

    const smtp = this.config.smtp
    if (smtp === undefined) {
      throw new MailerError('MAILER_SMTP_NOT_CONFIGURED', '没有配置 smtp，无法投递')
    }

    // 在 try 之前解析：凭据缺失要给自己的错误码，不能被包成 MAILER_SEND_FAILED
    const pass = this.resolvePass(smtp)

    const smtpConfig: SmtpConfig = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass,
      from: this.config.from,
      replyTo: this.config.replyTo,
      heloDomain: this.config.heloDomain,
      timeoutMs: this.config.timeoutMs,
      rejectUnauthorized: this.config.rejectUnauthorized,
      allowPlaintext: this.config.allowPlaintext,
    }

    try {
      await sendSmtp(smtpConfig, {
        to: message.to,
        subject: message.subject,
        text: message.text,
        messageId: smtpMessageId(this.config.heloDomain),
        date: new Date().toUTCString(),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.logger.warn(`投递失败：to=${message.to} ${detail}`)
      throw new MailerError('MAILER_SEND_FAILED', `邮件投递失败：${detail}`)
    }

    return { id, to: message.to, transport: 'smtp', acceptedAt }
  }
}

function validateMessage(message: MailMessage): string | undefined {
  if (typeof message.to !== 'string' || !isEmailLike(message.to)) return '收件人必须是合法的邮箱地址'
  if (typeof message.subject !== 'string' || message.subject.trim() === '') return '邮件主题不能为空'
  if (typeof message.text !== 'string' || message.text.trim() === '') return '邮件正文不能为空'
  return undefined
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

/**
 * 默认导出是插件本体：cordis 的 loader 取模块的 `default`（没有才退回整个导出对象），
 * 拿到类之后才去找 `apply` / 构造函数。少了这一行，按包名加载会报
 * 「invalid plugin, expect function or object with an "apply" method, received object」。
 */
export default MailerService
