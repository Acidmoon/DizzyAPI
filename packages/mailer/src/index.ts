import { Service, type Context, type Logger } from 'cordis'
import {
  checkConfigObject,
  isIssueList,
  issue,
  readBoolean,
  readPositiveInteger,
  readString,
  standardSchema,
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
  readonly pass: string | undefined
}

export type MailerErrorCode =
  | 'MAILER_MESSAGE_INVALID'
  | 'MAILER_SEND_FAILED'
  | 'MAILER_SMTP_NOT_CONFIGURED'

export class MailerError extends Error {
  readonly code: MailerErrorCode

  constructor(code: MailerErrorCode, message: string) {
    super(message)
    this.name = 'MailerError'
    this.code = code
  }
}

const KNOWN_KEYS: readonly string[] = [
  'transport',
  'from',
  'replyTo',
  'heloDomain',
  'timeoutMs',
  'rejectUnauthorized',
  'allowPlaintext',
  'smtp',
]

const SMTP_KEYS: readonly string[] = ['host', 'port', 'secure', 'user', 'pass', 'passEnv']

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
      if (pass !== undefined && passEnv !== undefined) {
        issues.push(issue('smtp.pass 与 smtp.passEnv 只能给一个'))
      }
      const resolvedPass = pass ?? (passEnv !== undefined ? process.env[passEnv] : undefined)
      if (passEnv !== undefined && resolvedPass === undefined) {
        issues.push(issue(`smtp.passEnv 指向的环境变量 ${passEnv} 当前为空`))
      }
      smtp = {
        host: host ?? '',
        port: port ?? 0,
        secure: secure ?? false,
        user,
        pass: resolvedPass,
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

export const MAILER_CONFIG_SCHEMA = standardSchema<ResolvedMailerConfig>('dizzyapi', validateMailerConfig)

export class MailerService extends Service {
  static Config = MAILER_CONFIG_SCHEMA

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
  }

  get describe(): string {
    if (this.config.transport === 'log') return 'log（只写日志）'
    const smtp = this.config.smtp
    return `smtp（${smtp?.host}:${smtp?.port}${smtp?.secure ? ' TLS' : ' STARTTLS'}）`
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

    const smtpConfig: SmtpConfig = {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass: smtp.pass,
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
