/**
 * 审计插件（服务名 `audit`）：管理员操作审计日志的**唯一写者**。
 *
 * 定位与边界：
 *
 * - 它是**旁路**，不是前置依赖：业务写操作在自己的位置完成后调 `audit.record(...)`；
 *   审计失败只记错误日志，**绝不把业务写操作卡住或回滚**（AGENTS.md §5.3 的取向，
 *   与 usage 拿 billing 的方式一致：运行期解析、不 inject）。
 * - 它不挂 HTTP：路由在 `api` 插件（`GET /api/admin/audit`），页面在 `web`
 *   （`/admin/audit`）；两者都以自己的 actor 身份调 `list` / `stats`。
 * - 读受 `adminPlugins` 白名单限制（默认拒绝）：审计记录里有「谁、什么时候、对谁
 *   做了什么」，能读它就能看全部管理员动作，不能靠「没人试过」来保证安全。
 * - **秘密不进审计表**：落库前统一走 `redact.ts` 的两道闸（键名 + 值形状）；
 *   摘要文本也走值形状那一闸。
 * - 保留期默认 180 天，分批删除（学 usage 的 `PRUNE_BATCH`），定时器挂 `ctx.effect`。
 */
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite'
import { Service, type Context, type Logger } from 'cordis'
import { describeError } from '@dizzyapi/plugin-kit'
import { AUDIT_CONFIG_SCHEMA, AUDIT_DEFAULTS, type AuditConfig, type ResolvedAuditConfig } from './config.ts'
import { openAuditDatabase } from './db.ts'
import { AuditError } from './errors.ts'
import { metadataJsonOf, redactText } from './redact.ts'
import type { AuditEntry, AuditPage, AuditQuery, AuditRecord, AuditResult, AuditStats } from './types.ts'

const DAY_MS = 86_400_000
/** 分批删除的批大小：与 usage 同一个取值，避免一次 DELETE 长时间持锁。 */
const PRUNE_BATCH = 1_000
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const MAX_OFFSET = 1_000_000
const MAX_ACTOR_LENGTH = 120
const MAX_ACTION_LENGTH = 80
const MAX_TARGET_LENGTH = 200
const MAX_SUMMARY_LENGTH = 500
const TOP_GROUPS = 10

/** 稳定英文动作码：点分小写，例如 `user.balance.adjust`。 */
const ACTION_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_-]*)+$/
/** 稳定错误码：大写蛇形。 */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/

const ROW_COLUMNS = `
  id, at_ms, actor, actor_plugin, action, target_type, target_id, summary, metadata, result, error_code
`

export class AuditService extends Service {
  static Config = AUDIT_CONFIG_SCHEMA

  /**
   * 不 inject 任何服务：审计不依赖业务插件，业务插件也不 inject 审计。
   * 插件之间只经服务接口通信（AGENTS.md §2.2）——调用方在运行期解析本服务。
   */
  static inject: readonly string[] = []

  static catalog = {
    capabilities: ['audit-log'],
    events: [],
    bridge: [],
    storage: [
      {
        key: 'dataPath',
        kind: 'file',
        description: 'SQLite 审计库：audit_log（操作者 / 动作 / 目标 / 摘要 / 已脱敏元数据）',
      },
    ],
    shapes: {
      AuditRecord: {
        description: '一条审计记录；metadata 已脱敏，绝不含秘密',
        fields: {
          id: { type: 'integer' },
          at: { type: 'string' },
          actor: { type: 'string' },
          actorPlugin: { type: 'string' },
          action: { type: 'string' },
          targetType: { type: 'string' },
          targetId: { type: 'string' },
          summary: { type: 'string' },
          metadata: { type: 'object', optional: true },
          result: { type: 'string' },
          errorCode: { type: 'string', optional: true },
        },
      },
    },
  } as const

  readonly config: ResolvedAuditConfig
  private readonly logger: Logger
  private db: DatabaseSync | undefined
  private ready = false
  private pruneTimer: NodeJS.Timeout | undefined

  constructor(ctx: Context, config: AuditConfig | ResolvedAuditConfig = {}) {
    super(ctx, 'audit')
    this.config = {
      dataPath: config.dataPath ?? AUDIT_DEFAULTS.dataPath,
      retentionDays: config.retentionDays ?? AUDIT_DEFAULTS.retentionDays,
      adminPlugins: config.adminPlugins ?? [],
    }
    this.logger = ctx.logger('audit')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    this.db = openAuditDatabase(resolveDataPath(this.ctx, this.config.dataPath))
    this.ready = true
    this.logger.info(
      `审计插件已装载：存储 ${this.config.dataPath ?? ':memory:'}；保留 ${this.config.retentionDays} 天；` +
        `可读插件 ${this.config.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (this.config.adminPlugins.length === 0) {
      this.logger.warn('adminPlugins 为空：当前没有任何插件能读审计记录（默认拒绝，这是刻意的）')
    }

    this.pruneTimer = setInterval(() => {
      try {
        this.pruneExpired()
      } catch (error) {
        this.logger.warn(`清理过期审计记录失败：${describeError(error)}`)
      }
    }, DAY_MS)
    this.pruneTimer.unref()

    // 启动时也清一次；失败不影响装载（下次定时器还会再试）。
    try {
      this.pruneExpired()
    } catch (error) {
      this.logger.warn(`启动时清理过期审计记录失败：${describeError(error)}`)
    }

    // 注册即副作用：卸载 / 禁用时数据库连接与定时器跟着回收（AGENTS.md D5）。
    this.ctx.effect(() => () => this.close(), 'audit.db')

    yield () => {
      this.ready = false
    }
  }

  // ───────────────────────────────── 写

  /**
   * 写一条审计记录。**同步**落库：调用方在业务写成功之后调用，不需要 await。
   *
   * 抛错语义：本方法会抛 `AUDIT_ENTRY_INVALID` / `AUDIT_STORE_FAILED`。调用方应当
   * **捕获并只记日志**——审计失败不能影响业务（这条写进调用方注释与用例里）。
   */
  record(entry: AuditEntry): AuditRecord {
    this.assertReady()
    const db = this.requireDb()
    const atMs = normalizeAtMs(entry.atMs)
    const actor = normalizeText(entry.actor, 'actor', MAX_ACTOR_LENGTH)
    const actorPlugin = normalizeText(entry.actorPlugin, 'actorPlugin', MAX_ACTOR_LENGTH)
    const action = normalizeAction(entry.action)
    const targetType = optionalText(entry.targetType, MAX_TARGET_LENGTH)
    const targetId = optionalText(entry.targetId, MAX_TARGET_LENGTH)
    const result: AuditResult = entry.result === 'failed' ? 'failed' : 'ok'
    const errorCode = normalizeErrorCode(entry.errorCode, result)
    const summary = redactText(normalizeText(entry.summary, 'summary', MAX_SUMMARY_LENGTH))
    const metadata = metadataJsonOf(entry.metadata)

    try {
      const statement = db.prepare(`
        INSERT INTO audit_log (
          at_ms, actor, actor_plugin, action, target_type, target_id, summary, metadata, result, error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const inserted = statement.run(
        atMs,
        actor,
        actorPlugin,
        action,
        targetType,
        targetId,
        summary,
        metadata,
        result,
        errorCode,
      )
      return {
        id: Number(inserted.lastInsertRowid),
        at: new Date(atMs).toISOString(),
        atMs,
        actor,
        actorPlugin,
        action,
        targetType,
        targetId,
        summary,
        metadata: parseMetadata(metadata),
        result,
        errorCode,
      }
    } catch (error) {
      // 落库失败先记日志再抛：调用方（api / web / 面板）按「审计是旁路」只忽略错误，
      // 所以**这里不记就真的没人知道了**。
      this.logger.error(`审计写入失败：${describeError(error)}`)
      throw error instanceof AuditError
        ? error
        : new AuditError('AUDIT_STORE_FAILED', `审计写入失败：${describeError(error)}`)
    }
  }

  // ───────────────────────────────── 读

  /** 按时间倒序分页查询。`actor` 必须在本插件 `adminPlugins` 白名单里。 */
  list(actor: string, query: AuditQuery = {}): AuditPage {
    this.assertAdmin(actor)
    this.assertReady()
    const db = this.requireDb()
    const limit = normalizeLimit(query.limit)
    const offset = normalizeOffset(query.offset)
    const where = queryWhere(query)
    const rows = db
      .prepare(`SELECT ${ROW_COLUMNS} FROM audit_log${where.sql} ORDER BY at_ms DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...where.params, limit, offset) as Record<string, SQLOutputValue>[]
    const counted = db.prepare(`SELECT COUNT(*) AS n FROM audit_log${where.sql}`).get(...where.params) as
      | Record<string, SQLOutputValue>
      | undefined
    return {
      items: rows.map(rowOf),
      total: counted === undefined ? 0 : integerOf(counted.n),
      offset,
      limit,
    }
  }

  /** 汇总：总量、今天 / 最近 24 小时、失败数、Top 动作与 Top 操作者。 */
  stats(actor: string, nowMs: number = Date.now()): AuditStats {
    this.assertAdmin(actor)
    this.assertReady()
    const db = this.requireDb()
    const now = new Date(nowMs)
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const count = (sql: string, ...params: SQLInputValue[]): number => {
      const row = db.prepare(sql).get(...params) as Record<string, SQLOutputValue> | undefined
      return row === undefined ? 0 : integerOf(row.n)
    }
    const group = (column: 'action' | 'actor'): readonly { action: string; count: number }[] | readonly { actor: string; count: number }[] => {
      const rows = db
        .prepare(`SELECT ${column} AS k, COUNT(*) AS n FROM audit_log GROUP BY ${column} ORDER BY n DESC, k ASC LIMIT ?`)
        .all(TOP_GROUPS) as Record<string, SQLOutputValue>[]
      return rows.map((row) => ({ [column]: String(row.k ?? ''), count: integerOf(row.n) }) as never)
    }
    const lastRow = db.prepare('SELECT MAX(at_ms) AS k FROM audit_log').get() as
      | Record<string, SQLOutputValue>
      | undefined
    const lastAtMs = lastRow === undefined || lastRow.k === null ? null : integerOf(lastRow.k)
    return {
      total: count('SELECT COUNT(*) AS n FROM audit_log'),
      today: count('SELECT COUNT(*) AS n FROM audit_log WHERE at_ms >= ?', todayStart),
      last24h: count('SELECT COUNT(*) AS n FROM audit_log WHERE at_ms >= ?', nowMs - DAY_MS),
      failed: count("SELECT COUNT(*) AS n FROM audit_log WHERE result = 'failed'"),
      lastAt: lastAtMs === null ? null : new Date(lastAtMs).toISOString(),
      byAction: group('action') as readonly { action: string; count: number }[],
      byActor: group('actor') as readonly { actor: string; count: number }[],
    }
  }

  /** 当前记录条数（装载完成前后都可调用；给页面 / 健康检查用）。 */
  count(): number {
    const db = this.db
    if (db === undefined) return 0
    const row = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as
      | Record<string, SQLOutputValue>
      | undefined
    return row === undefined ? 0 : integerOf(row.n)
  }

  // ───────────────────────────────── 保留期清理

  /**
   * 删除超过保留期的记录，分批删到删空。
   *
   * 公开给单测；定时器每天调用一次。返回删除条数。
   */
  pruneExpired(nowMs: number = Date.now()): number {
    const db = this.db
    if (db === undefined) return 0
    const cutoff = nowMs - this.config.retentionDays * DAY_MS
    // 不用 `DELETE ... LIMIT`（需要 SQLite 编译选项）；用子查询选一批 id，通用且可循环。
    const statement = db.prepare(
      'DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at_ms < ? LIMIT ' + PRUNE_BATCH + ')',
    )
    let removed = 0
    for (;;) {
      const changes = Number(statement.run(cutoff).changes)
      removed += changes
      if (changes < PRUNE_BATCH) break
    }
    if (removed > 0) {
      this.logger.info(`已清理 ${removed} 条过期审计记录（保留 ${this.config.retentionDays} 天）`)
    }
    return removed
  }

  // ───────────────────────────────── 内部

  private assertAdmin(actor: string): void {
    const name = typeof actor === 'string' ? actor.trim() : ''
    if (name === '') {
      throw new AuditError('AUDIT_ACTOR_REQUIRED', '读审计记录必须声明调用方插件名')
    }
    if (!this.config.adminPlugins.includes(name)) {
      throw new AuditError(
        'AUDIT_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权读审计记录（当前授权：${this.config.adminPlugins.join(' / ') || '无'}）`,
      )
    }
  }

  private requireDb(): DatabaseSync {
    if (this.db === undefined) throw new AuditError('AUDIT_NOT_READY', '审计插件尚未装载完成')
    return this.db
  }

  private assertReady(): void {
    if (!this.ready) throw new AuditError('AUDIT_NOT_READY', '审计插件尚未装载完成')
  }

  private close(): void {
    this.ready = false
    if (this.pruneTimer !== undefined) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = undefined
    }
    const db = this.db
    this.db = undefined
    if (db !== undefined) {
      try {
        db.close()
      } catch {
        // 连接可能已经关闭；卸载路径不抛错。
      }
    }
  }
}

// ───────────────────────────────── 纯函数

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === '' || path === ':memory:' || isAbsolute(path)) {
    return path === '' ? undefined : path
  }
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function integerOf(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0
  }
  return 0
}

function normalizeAtMs(value: number | undefined): number {
  if (value === undefined) return Date.now()
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuditError('AUDIT_ENTRY_INVALID', 'atMs 必须是正整数毫秒时间戳')
  }
  return value
}

function normalizeText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AuditError('AUDIT_ENTRY_INVALID', `${field} 必须是字符串`)
  }
  const text = value.trim()
  if (text === '') throw new AuditError('AUDIT_ENTRY_INVALID', `${field} 不能为空`)
  if (text.length > maxLength) {
    throw new AuditError('AUDIT_ENTRY_INVALID', `${field} 最长 ${maxLength} 个字符`)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new AuditError('AUDIT_ENTRY_INVALID', `${field} 不得包含控制字符`)
  }
  return text
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new AuditError('AUDIT_ENTRY_INVALID', 'targetType / targetId 必须是字符串')
  }
  const text = value.trim()
  if (text.length > maxLength) {
    throw new AuditError('AUDIT_ENTRY_INVALID', `target 最长 ${maxLength} 个字符`)
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new AuditError('AUDIT_ENTRY_INVALID', 'target 不得包含控制字符')
  }
  return text
}

function normalizeAction(value: unknown): string {
  if (typeof value !== 'string' || !ACTION_PATTERN.test(value)) {
    throw new AuditError(
      'AUDIT_ENTRY_INVALID',
      'action 必须是稳定英文点分码（例如 user.balance.adjust），不能是自然语言或带变量',
    )
  }
  if (value.length > MAX_ACTION_LENGTH) {
    throw new AuditError('AUDIT_ENTRY_INVALID', `action 最长 ${MAX_ACTION_LENGTH} 个字符`)
  }
  return value
}

function normalizeErrorCode(value: string | null | undefined, result: AuditResult): string | null {
  if (value === undefined || value === null || value === '') {
    // 失败但没给码：允许（调用方可能只有一句人话），但不伪造一个假码。
    return null
  }
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) {
    throw new AuditError('AUDIT_ENTRY_INVALID', 'errorCode 必须是稳定大写码（AUDIT_XXX）')
  }
  if (result !== 'failed') {
    // 成功却带错误码是记录方的 bug：明确拒绝，别让统计出现「成功但失败码」的怪行。
    throw new AuditError('AUDIT_ENTRY_INVALID', 'result=ok 时不能带 errorCode')
  }
  return value
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new AuditError('AUDIT_QUERY_INVALID', `limit 必须是 1..${MAX_LIST_LIMIT} 的整数`)
  }
  return value
}

function normalizeOffset(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_OFFSET) {
    throw new AuditError('AUDIT_QUERY_INVALID', `offset 必须是 0..${MAX_OFFSET} 的整数`)
  }
  return value
}

function queryWhere(query: AuditQuery): { sql: string; params: SQLInputValue[] } {
  const clauses: string[] = []
  const params: SQLInputValue[] = []
  const equals: readonly (readonly [keyof AuditQuery, string])[] = [
    ['actor', 'actor'],
    ['actorPlugin', 'actor_plugin'],
    ['action', 'action'],
    ['targetType', 'target_type'],
    ['targetId', 'target_id'],
  ]
  for (const [key, column] of equals) {
    const value = query[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length > MAX_TARGET_LENGTH) {
      throw new AuditError('AUDIT_QUERY_INVALID', `${String(key)} 必须是不超过 ${MAX_TARGET_LENGTH} 字符的字符串`)
    }
    clauses.push(`${column} = ?`)
    params.push(value)
  }
  for (const [key, operator] of [['fromMs', '>='], ['toMs', '<']] as const) {
    const value = query[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AuditError('AUDIT_QUERY_INVALID', `${key} 必须是非负整数毫秒`)
    }
    clauses.push(`at_ms ${operator} ?`)
    params.push(value)
  }
  if (
    query.fromMs !== undefined &&
    query.toMs !== undefined &&
    query.fromMs >= query.toMs
  ) {
    throw new AuditError('AUDIT_QUERY_INVALID', 'fromMs 必须小于 toMs')
  }
  return { sql: clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`, params }
}

function parseMetadata(text: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function rowOf(row: Record<string, SQLOutputValue>): AuditRecord {
  const result: AuditResult = String(row.result ?? '') === 'failed' ? 'failed' : 'ok'
  return {
    id: integerOf(row.id),
    at: new Date(integerOf(row.at_ms)).toISOString(),
    atMs: integerOf(row.at_ms),
    actor: String(row.actor ?? ''),
    actorPlugin: String(row.actor_plugin ?? ''),
    action: String(row.action ?? ''),
    targetType: String(row.target_type ?? ''),
    targetId: String(row.target_id ?? ''),
    summary: String(row.summary ?? ''),
    metadata: parseMetadata(String(row.metadata ?? '{}')),
    result,
    errorCode: row.error_code === null || row.error_code === undefined ? null : String(row.error_code),
  }
}
