/**
 * 审计接线（web 插件侧）。
 *
 * 与 api 侧同一套纪律：
 *
 * - **旁路**：动作成功记 `ok`，抛错记 `failed` + 稳定码后原样重抛（303 的 `err` 提示不变）；
 *   审计服务缺席或抛错时只忽略——**业务动作照常成功**。
 * - 操作者来自会话（`user:<id>:<role>`），发起方是本插件（`actorPlugin` = `WEB_ACTOR`）。
 * - 摘要 / 元数据里**不放秘密**：凭据 payload、兑换码明文、设置值都不进审计。
 */
import type { PageContext } from './layout.ts'
import type { AuditEntryView, AuditLike, SessionView } from './runtime.ts'
import { WEB_ACTOR } from './runtime.ts'

/** 操作者的稳定标识：`user:<id>:<role>`。 */
export function auditActorOf(session: SessionView): string {
  const role = session.user.role === 'admin' ? 'admin' : 'user'
  return `user:${session.userId}:${role}`
}

/** 一次写动作的审计描述。`T` 是动作的返回值（`metadataOf` 取事后事实）。 */
export interface AuditSpec<T> {
  /** 稳定英文点分码，例如 `user.balance.adjust`。 */
  readonly action: string
  readonly targetType?: string
  readonly targetId?: string
  /** 一句话人话摘要；不要拼秘密。 */
  readonly summary: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly metadataOf?: (result: T) => Readonly<Record<string, unknown>> | undefined
}

/**
 * 包住一次页面写动作：成功记 `ok`，抛错记 `failed` 后**原样重抛**。
 *
 * 动作本身可以是同步的（`topup.cancel` 就是同步返回），所以这里统一 `await`。
 */
export async function auditedAction<T>(
  ctx: PageContext,
  spec: AuditSpec<T>,
  task: () => T | Promise<T>,
): Promise<T> {
  const audit = auditPort(ctx)
  try {
    const result = await task()
    writeAudit(audit, ctx, spec, result, 'ok', null)
    return result
  } catch (error) {
    writeAudit(audit, ctx, spec, undefined, 'failed', codeOf(error))
    throw error
  }
}

/** 直接记一条（不需要包住动作时用，例如批量动作逐条记）。永不抛错。 */
export function recordAudit(
  ctx: PageContext,
  entry: Omit<AuditEntryView, 'actor' | 'actorPlugin'>,
): void {
  const audit = auditPort(ctx)
  if (audit === undefined) return
  try {
    audit.record({ ...entry, actor: auditActorOf(ctx.user), actorPlugin: WEB_ACTOR })
  } catch {
    // 审计是旁路：写不进去也不能让页面动作失败。审计插件自己会记错误日志。
  }
}

function writeAudit<T>(
  audit: AuditLike | undefined,
  ctx: PageContext,
  spec: AuditSpec<T>,
  result: T | undefined,
  outcome: 'ok' | 'failed',
  errorCode: string | null,
): void {
  if (audit === undefined) return
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
    audit.record({
      actor: auditActorOf(ctx.user),
      actorPlugin: WEB_ACTOR,
      action: spec.action,
      ...(spec.targetType === undefined ? {} : { targetType: spec.targetType }),
      ...(spec.targetId === undefined ? {} : { targetId: spec.targetId }),
      summary: spec.summary,
      ...(metadata === undefined ? {} : { metadata }),
      result: outcome,
      ...(errorCode === null ? {} : { errorCode }),
    })
  } catch {
    // 同上：审计写失败不影响业务动作。
  }
}

function auditPort(ctx: PageContext): AuditLike | undefined {
  try {
    return ctx.services.audit
  } catch {
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
