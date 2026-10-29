/**
 * 审计记录的对外形状。
 *
 * 几条不变式（见 AGENTS.md §5.1 / §5.2）：
 * - `action` 是**稳定英文码**（`user.balance.adjust` 这种点分形式），页面负责中文标签；
 * - `actor` 是操作者（人类管理员 / 系统），`actorPlugin` 是发起写操作的插件；
 * - `metadata` 只能是**已脱敏**的 JSON 对象，**绝不放秘密**；
 * - 金额一律整数微元（十进制字符串，避免 JSON number 丢精度）。
 */

/** 一次操作的结果。失败也记：审计不只是「成功流水」。 */
export type AuditResult = 'ok' | 'failed'

/** 写一条审计记录时的输入。 */
export interface AuditEntry {
  /** 操作者：`user:<id>:<role>`（管理员）、`system:<plugin>`（系统自动动作）。 */
  readonly actor: string
  /** 发起写操作的插件名，例如 `@dizzyapi/plugin-api`。 */
  readonly actorPlugin: string
  /** 稳定英文码，例如 `user.balance.adjust` / `topup.order.confirm`。 */
  readonly action: string
  /** 目标类型，例如 `user` / `account` / `redeem-batch` / `topup-order` / `pricing` / `settings`。 */
  readonly targetType?: string
  /** 目标标识（用户 id、账号 id、批次 id、订单号、模型名、设置命名空间…）。 */
  readonly targetId?: string
  /** 一句话人话摘要（**调用方负责别把秘密写进来**；本插件还会再脱敏一次）。 */
  readonly summary: string
  /** 结构化细节（余额变化量、字段名…）；落库前统一脱敏。 */
  readonly metadata?: Readonly<Record<string, unknown>>
  /** 默认 `ok`。 */
  readonly result?: AuditResult
  /** 失败时的稳定错误码（成功时为 null / 省略）。 */
  readonly errorCode?: string | null
  /** 记录时间；省略用当前时间（测试注入用）。 */
  readonly atMs?: number
}

/** 落库后的一条审计记录。 */
export interface AuditRecord {
  readonly id: number
  /** ISO 时间（UTC）。 */
  readonly at: string
  readonly atMs: number
  readonly actor: string
  readonly actorPlugin: string
  readonly action: string
  readonly targetType: string
  readonly targetId: string
  readonly summary: string
  /** 已脱敏的元数据；没有时是 null。 */
  readonly metadata: Readonly<Record<string, unknown>> | null
  readonly result: AuditResult
  readonly errorCode: string | null
}

/** 查询条件：全部可选，按 `id` 倒序（= 时间倒序）。 */
export interface AuditQuery {
  readonly actor?: string
  readonly actorPlugin?: string
  readonly action?: string
  readonly targetType?: string
  readonly targetId?: string
  /** 时间范围（含 from、不含 to），毫秒。 */
  readonly fromMs?: number
  readonly toMs?: number
  readonly limit?: number
  readonly offset?: number
}

/** 一页审计记录。 */
export interface AuditPage {
  readonly items: readonly AuditRecord[]
  readonly total: number
  readonly offset: number
  readonly limit: number
}

/** 汇总卡片。 */
export interface AuditStats {
  readonly total: number
  /** 今天（UTC 日）写入条数。 */
  readonly today: number
  /** 最近 24 小时写入条数。 */
  readonly last24h: number
  readonly failed: number
  readonly lastAt: string | null
  readonly byAction: readonly { readonly action: string; readonly count: number }[]
  readonly byActor: readonly { readonly actor: string; readonly count: number }[]
}

/** 读接口的端口形状（api / web 只依赖这些方法）。 */
export interface AuditServiceLike {
  record(entry: AuditEntry): AuditRecord
  list(actor: string, query?: AuditQuery): AuditPage
  stats(actor: string): AuditStats
}
