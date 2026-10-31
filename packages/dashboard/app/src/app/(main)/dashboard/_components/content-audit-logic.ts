/**
 * 内容审核页的**纯逻辑**（不 import React / Next / UI 组件）。
 *
 * 为什么单独一个文件而不是塞进 `admin-logic.ts`：那边已经 400 行上下，
 * 而内容审核这一套（动作标签 / 命中统统计收窄 / 规则草稿与 patch）自成一块职责，
 * 页面只有 `/dashboard/content-audit` 用。按「一个文件一个职责」独立出来。
 *
 * 两条最容易写错的语义，都由这里负责且被单测钉住：
 * 1. **「清空」vs「不改」**：服务端用 `Object.hasOwn` 判「给了没」，
 *    不带键 = 不改，发 `null` = 清空。写错就是「想清空却没清掉」。
 * 2. **命中统计的形状**：接口类型里是 `Record<string, unknown>`，
 *    这里显式收窄——读不出的键当 0，不猜、不崩。
 */

/** 审核动作 → 人话（`block` = 命中拒绝，`log` = 只记日志）。 */
export function contentAuditActionLabel(action: string): string {
  if (action === "block") return "拒绝";
  if (action === "log") return "仅记录";
  return action;
}

/**
 * Go 侧命中统计（服务端 `packages/content-audit/src/types.ts` 的 `ContentAuditHits`）。
 *
 * 前端类型文件里 `hits` 的形状是 `Record<string, unknown>`（**不在本线的写面**，
 * 改它要等 `交互` 线统一处理），所以这里做一次**显式收窄**。
 */
export interface ContentAuditHitsLike {
  readonly blocked: number
  readonly logged: number
  readonly ruleHitTotal: number
  readonly byRule: Readonly<Record<string, number>>
}

/** 把 `hits` 收窄成可用的统计；`null` / `undefined` 返回 `null`。 */
export function contentAuditHitsOf(
  hits: Readonly<Record<string, unknown>> | null | undefined,
): ContentAuditHitsLike | null {
  if (hits === null || hits === undefined) return null
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0
  const byRule: Record<string, number> = {}
  const rawByRule = hits.byRule
  if (rawByRule !== null && typeof rawByRule === "object" && !Array.isArray(rawByRule)) {
    for (const [ruleId, value] of Object.entries(rawByRule as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) byRule[ruleId] = value
    }
  }
  return {
    blocked: count(hits.blocked),
    logged: count(hits.logged),
    ruleHitTotal: count(hits.ruleHitTotal),
    byRule,
  }
}

/** 单条规则的命中次数（读不到就是 0）。 */
export function ruleHitCount(hits: ContentAuditHitsLike | null, ruleId: string): number {
  if (hits === null) return 0
  return hits.byRule[ruleId] ?? 0
}

/** 审核规则的编辑草稿。 */
export interface RuleDraft {
  pattern: string
  action: "block" | "log"
  category: string
  note: string
  enabled: boolean
}

/** 审核规则里服务端认识的那几个字段（只取需要的，不依赖整个 DTO）。 */
export interface RuleBeforeLike {
  readonly pattern: string
  readonly action: "block" | "log"
  readonly category: string | null
  readonly note: string | null
  readonly enabled: boolean
}

/** 由规则（或空）造一份草稿。新建时 `action` 默认 `block`（拦住），`enabled` 默认开。 */
export function draftOf(rule: RuleBeforeLike | null): RuleDraft {
  if (rule === null) {
    return { pattern: "", action: "block", category: "", note: "", enabled: true }
  }
  return {
    pattern: rule.pattern,
    action: rule.action,
    category: rule.category ?? "",
    note: rule.note ?? "",
    enabled: rule.enabled,
  }
}

/**
 * 新建时的入参：空串的 `category` / `note` **不带这个键**。
 *
 * 服务端 `contentAuditOptionalText` 把空串当「没给」，所以这里直接省掉，
 * 别发 `category: ""`——那会让服务端的元数据里多一条「分类被设成空」。
 */
export function createRuleInputOf(draft: RuleDraft): {
  pattern: string
  action: "block" | "log"
  enabled: boolean
  category?: string
  note?: string
} {
  const input: {
    pattern: string
    action: "block" | "log"
    enabled: boolean
    category?: string
    note?: string
  } = { pattern: draft.pattern.trim(), action: draft.action, enabled: draft.enabled }
  if (draft.category.trim() !== "") input.category = draft.category.trim()
  if (draft.note.trim() !== "") input.note = draft.note.trim()
  return input
}

/**
 * 修改时的 patch：**只放改了的字段**，且「清空」要显式发 `null`。
 *
 * 关键词为空 → `"invalid"`（不提交半条 patch）。
 */
export function rulePatchOf(
  draft: RuleDraft,
  before: RuleBeforeLike,
): {
  pattern?: string
  action?: "block" | "log"
  enabled?: boolean
  category?: string | null
  note?: string | null
} | "invalid" {
  const pattern = draft.pattern.trim()
  if (pattern === "") return "invalid"
  const patch: {
    pattern?: string
    action?: "block" | "log"
    enabled?: boolean
    category?: string | null
    note?: string | null
  } = {}
  if (pattern !== before.pattern) patch.pattern = pattern
  if (draft.action !== before.action) patch.action = draft.action
  if (draft.enabled !== before.enabled) patch.enabled = draft.enabled
  const category = draft.category.trim()
  if (category !== (before.category ?? "")) patch.category = category === "" ? null : category
  const note = draft.note.trim()
  if (note !== (before.note ?? "")) patch.note = note === "" ? null : note
  return patch
}
