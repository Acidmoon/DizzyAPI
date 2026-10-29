/**
 * views/audit.ts：从 http.ts 尾部搬出来的纯函数（行为逐字未改）。
 *
 * 拆出来的原因见 AGENTS.md §5.6（单文件上限）。搬动方式：整块文本原样移动，只补 import。
 */
import { requiredString } from '../params.ts'
import { badRequest } from '../errors.ts'
import type { ContentAuditRuleInputLike, ContentAuditRuleLike, ContentAuditRulePatchLike, ContentAuditStatusLike } from '../types.ts'


// ───────────────────────────────── 内容审核 ─────────────────────────────────

export function contentAuditRuleOf(rule: ContentAuditRuleLike): Record<string, unknown> {
  return {
    id: rule.id,
    pattern: rule.pattern,
    action: rule.action,
    category: rule.category ?? null,
    enabled: rule.enabled,
    note: rule.note ?? null,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  }
}


/**
 * 审计元数据：只放「哪条规则、什么动作、是否启用」。
 *
 * **不放 `pattern`**：关键词是管理面的审核数据，审计表没必要复制一份（也少一处扩散面）。
 */
export function contentAuditRuleMetadata(rule: ContentAuditRuleLike): Record<string, unknown> {
  return {
    ruleId: rule.id,
    action: rule.action,
    category: rule.category ?? null,
    enabled: rule.enabled,
  }
}


/** 状态：显式列白名单键，避免插件以后加字段时悄悄漏到 HTTP 面上。 */
export function contentAuditStatusOf(status: ContentAuditStatusLike): Record<string, unknown> {
  return {
    enabled: status.enabled,
    pushIntervalMs: status.pushIntervalMs,
    ruleCount: status.ruleCount,
    revision: status.revision,
    generation: status.generation,
    ageMs: status.ageMs,
    ttlMs: status.ttlMs,
    stale: status.stale,
    goReady: status.goReady,
    lastPushAt: status.lastPushAt,
    lastError: status.lastError,
    pushes: status.pushes,
    heartbeats: status.heartbeats,
    failureStreak: status.failureStreak,
    goTtlMs: status.goTtlMs,
    heartbeatTooSlow: status.heartbeatTooSlow,
    hits: status.hits === null ? null : { ...status.hits, byRule: { ...status.hits.byRule } },
  }
}


export function contentAuditActionOf(value: unknown): 'block' | 'log' {
  if (value === 'block' || value === 'log') return value
  throw badRequest('action 只能是 block / log')
}


export function contentAuditEnabledOf(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  throw badRequest('enabled 必须是布尔值')
}


/** 新建时的可选文本：`undefined` / `null` / 空串都当作「没给」。 */
export function contentAuditOptionalText(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw badRequest(`${key} 必须是字符串`)
  const text = value.trim()
  return text === '' ? undefined : text
}


/** 修改时的可清空文本：`null` 或空串表示清空。 */
export function contentAuditClearableText(value: unknown, key: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw badRequest(`${key} 必须是字符串或 null`)
  const text = value.trim()
  return text === '' ? null : text
}


/** 新建规则：只做形状校验，长度 / 去重 / 上限交给插件（它的码才是稳定的）。 */
export function contentAuditInputOf(body: Record<string, unknown>): ContentAuditRuleInputLike {
  const pattern = requiredString(body, 'pattern')
  const action = body.action === undefined ? undefined : contentAuditActionOf(body.action)
  const category = contentAuditOptionalText(body.category, 'category')
  const note = contentAuditOptionalText(body.note, 'note')
  const enabled = body.enabled === undefined ? undefined : contentAuditEnabledOf(body.enabled)
  return {
    pattern,
    ...(action === undefined ? {} : { action }),
    ...(category === undefined ? {} : { category }),
    ...(note === undefined ? {} : { note }),
    ...(enabled === undefined ? {} : { enabled }),
  }
}


/** 修改规则：`Object.hasOwn` 区分「没给」与「给了 null」。 */
export function contentAuditPatchOf(body: Record<string, unknown>): ContentAuditRulePatchLike {
  const patch: {
    pattern?: string
    action?: 'block' | 'log'
    category?: string | null
    enabled?: boolean
    note?: string | null
  } = {}
  if (Object.hasOwn(body, 'pattern')) patch.pattern = requiredString(body, 'pattern')
  if (Object.hasOwn(body, 'action')) patch.action = contentAuditActionOf(body.action)
  if (Object.hasOwn(body, 'category')) patch.category = contentAuditClearableText(body.category, 'category')
  if (Object.hasOwn(body, 'note')) patch.note = contentAuditClearableText(body.note, 'note')
  if (Object.hasOwn(body, 'enabled')) patch.enabled = contentAuditEnabledOf(body.enabled)
  if (Object.keys(patch).length === 0) throw badRequest('没有可修改的字段')
  return patch
}
