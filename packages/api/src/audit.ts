/**
 * 审计接线（api 插件侧）。
 *
 * 纪律：
 *
 * - **审计是旁路，不是前置依赖**：写操作成功后写一条记录；审计服务缺席或抛错时只记
 *   警告日志，**业务请求照常成功**（绝不因为审计挂了把「加余额」变成 500）。
 * - 操作者取自会话（`user:<id>:<role>`），发起方是本插件（`actorPlugin`）。
 *   这两个字段只有入口层知道，所以记录点在 HTTP 路由里，而不在业务插件里。
 * - 失败也记：`result: failed` + 稳定错误码。审计不只是成功流水。
 * - 记录内容里**不放秘密**（密码 / 验证码 / API key / 凭据 / 会话 token / 兑换码明文）；
 *   `audit` 侧还有一层脱敏兜底。
 */
import type { ApiRuntime, AuditEntryLike, AuditPort } from './types.ts'

/** 操作者的稳定标识：`user:<id>:<role>`。 */
export function auditActorOf(view: { readonly userId: number; readonly user: { readonly role?: string } }): string {
  const role = view.user.role === 'admin' ? 'admin' : 'user'
  return `user:${view.userId}:${role}`
}

/** 一次写操作的审计描述。`T` 是写操作的返回值（用 `metadataOf` 取事后事实）。 */
export interface AuditSpec<T> {
  /** 稳定英文点分码，例如 `user.balance.adjust`。 */
  readonly action: string
  readonly targetType?: string
  readonly targetId?: string
  /** 一句话人话摘要；不要拼秘密。 */
  readonly summary: string
  readonly metadata?: Readonly<Record<string, unknown>>
  /** 从写操作结果补元数据（例如变动后余额）。 */
  readonly metadataOf?: (result: T) => Readonly<Record<string, unknown>> | undefined
}

export interface AuditIdentity {
  readonly actor: string
  readonly actorPlugin: string
}

/**
 * 写一条审计记录。**永不抛错**：审计失败只记日志。
 *
 * 显式导出是为了给「不是标准写法」的位置用（例如批量操作逐条记多行）。
 */
export function recordAudit(
  runtime: ApiRuntime,
  identity: AuditIdentity,
  entry: Omit<AuditEntryLike, 'actor' | 'actorPlugin'>,
): void {
  const port = auditPort(runtime)
  if (port === undefined) return
  try {
    port.record({ ...entry, actor: identity.actor, actorPlugin: identity.actorPlugin })
  } catch (error) {
    runtime.log('warn', `审计写入失败（业务不受影响）：${messageOf(error)}`)
  }
}

/**
 * 包住一次写操作：成功记 `ok`，抛错记 `failed` + 稳定码后**原样重抛**。
 *
 * 重抛是关键：调用方（路由）的错误映射与状态码不能因为加了审计而改变。
 */
export async function audited<T>(
  runtime: ApiRuntime,
  identity: AuditIdentity,
  spec: AuditSpec<T>,
  task: () => Promise<T>,
): Promise<T> {
  const port = auditPort(runtime)
  try {
    const result = await task()
    recordTo(port, runtime, identity, spec, result, 'ok', null)
    return result
  } catch (error) {
    recordTo(port, runtime, identity, spec, undefined, 'failed', codeOf(error))
    throw error
  }
}

function recordTo<T>(
  port: AuditPort | undefined,
  runtime: ApiRuntime,
  identity: AuditIdentity,
  spec: AuditSpec<T>,
  result: T | undefined,
  outcome: 'ok' | 'failed',
  errorCode: string | null,
): void {
  if (port === undefined) return
  let metadata: Readonly<Record<string, unknown>> | undefined = spec.metadata
  if (spec.metadataOf !== undefined) {
    let extra: Readonly<Record<string, unknown>> | undefined
    try {
      extra = spec.metadataOf(result as T)
    } catch {
      extra = undefined
    }
    if (extra !== undefined) metadata = { ...metadata, ...extra }
  }
  try {
    port.record({
      actor: identity.actor,
      actorPlugin: identity.actorPlugin,
      action: spec.action,
      ...(spec.targetType === undefined ? {} : { targetType: spec.targetType }),
      ...(spec.targetId === undefined ? {} : { targetId: spec.targetId }),
      summary: spec.summary,
      ...(metadata === undefined ? {} : { metadata }),
      result: outcome,
      ...(errorCode === null ? {} : { errorCode }),
    })
  } catch (error) {
    runtime.log('warn', `审计写入失败（业务不受影响）：${messageOf(error)}`)
  }
}

function auditPort(runtime: ApiRuntime): AuditPort | undefined {
  try {
    return runtime.audit()
  } catch {
    // 运行期解析本身抛错也当成「审计不在」：它不是业务依赖。
    return undefined
  }
}

function codeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)) return code
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
