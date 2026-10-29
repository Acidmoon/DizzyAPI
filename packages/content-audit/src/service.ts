/**
 * 内容审核插件（服务名 `contentAudit`）。
 *
 * 定位：**规则是控制面数据**。本插件是 `dataPath` 指向的 JSON 的唯一写者，
 * 把规则快照**心跳式**推给 Go 的 pre 相位审核闸门（桥命令 `contentaudit.replace`），
 * 命中统计从 `contentaudit.status` 读回来。
 *
 * 三条纪律：
 * - **心跳推送**：每个 `pushIntervalMs` 都推，内容不变也推（revision 相同、generation 递增）。
 *   「内容没变就跳过」会让 Go 侧 TTL 一到判定快照过期——额度闸门 2026-10-29 就是这么失效的。
 *   禁用了也推（`enabled:false` + 空规则），让 Go 侧立刻回到全放行。
 * - **只做大小写不敏感的子串匹配**：这一批不做正则（ReDoS 风险），规则在校验时就按原文存，
 *   Go 侧预编译成小写。
 * - **写要求 actor 在 `adminPlugins` 白名单**（默认拒绝）。
 *   审计**不在这里记**：操作者身份只有入口层（`api` 的 HTTP 路由 / `web` 的页面动作）知道，
 *   它们各自用 `audited(...)` 在调用点留痕；本插件因此对 `audit` 零依赖。
 */
import { createHash, randomBytes } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
// 只为了类型：@cordisjs/plugin-timer 往 Context 上 mixin 了 setInterval。
import type {} from '@cordisjs/plugin-timer'
import { describeError, jsonFileStore, nowIso, type JsonStore } from '@dizzyapi/plugin-kit'
import {
  CONTENT_AUDIT_CONFIG_SCHEMA,
  type ContentAuditConfig,
  type ResolvedContentAuditConfig,
} from './config.ts'
import { ContentAuditError, isContentAuditError } from './errors.ts'
import type {
  ContentAuditRule,
  ContentAuditRuleInput,
  ContentAuditRulePatch,
  ContentAuditSnapshotPayload,
  ContentAuditStatus,
} from './types.ts'

const FILE_VERSION = 1
const MAX_PATTERN_LENGTH = 200
const MAX_CATEGORY_LENGTH = 64
const MAX_NOTE_LENGTH = 200
const MAX_RULES = 500
const MAX_ID_LENGTH = 64
const DEFAULT_WARN_THROTTLE_MS = 30_000

interface StoredRule {
  readonly id: string
  readonly pattern: string
  readonly action: 'block' | 'log'
  readonly category?: string
  readonly enabled: boolean
  readonly note?: string
  readonly createdAt: string
  readonly updatedAt: string
}

interface ContentAuditFile {
  readonly version: number
  readonly rules: readonly StoredRule[]
}

/** 控制桥的持有者（account-priority）暴露给本插件的那一小块。 */
interface BridgeSeam {
  replaceContentAudit(snapshot: ContentAuditSnapshotPayload): Promise<unknown>
  contentAuditStatus(): Promise<unknown>
}

/** Go 侧 contentaudit.status 里本插件用到的字段。 */
interface GoStatus {
  readonly ready?: unknown
  readonly ageMs?: unknown
  readonly ttlMs?: unknown
  readonly stale?: unknown
  readonly gate?: unknown
}

export class ContentAuditService extends Service {
  static Config = CONTENT_AUDIT_CONFIG_SCHEMA

  /** 依赖：桥的持有者（accountPriority）与定时器 mixin（timer）。 */
  static inject = ['accountPriority', 'timer']

  static catalog = {
    capabilities: ['content-audit-rules', 'content-audit-gate-feed'],
    events: [
      {
        name: 'contentaudit/changed',
        description: '规则被新增 / 修改 / 删除 / 启停（不含规则内容）',
        payload: 'ruleId: string, action: create|update|delete',
      },
      {
        name: 'contentaudit/pushed',
        description: 'Go 侧确认缓存了一版规则快照（不含规则内容）',
        payload: 'revision: string, rules: number',
      },
      {
        name: 'contentaudit/error',
        description: '规则快照推送失败（已按节流写日志）',
        payload: 'code: string, message: string',
      },
    ],
    bridge: [
      {
        method: 'contentaudit.replace',
        direction: 'outbound',
        requestShape: 'ContentAuditSnapshotPayload',
        responseShape: 'contentaudit.Result',
      },
      { method: 'contentaudit.status', direction: 'outbound', responseShape: 'contentaudit.State' },
    ],
    storage: [{ key: 'dataPath', kind: 'file', description: '内容审核规则 JSON' }],
    methods: {
      status: { description: '推送状态 + Go 侧健康度与命中统计（不含规则内容）' },
      list: { description: '规则列表（要求 actor 在白名单）' },
      create: { description: '新增规则（要求 actor 在白名单）' },
      update: { description: '修改规则（要求 actor 在白名单）' },
      remove: { description: '删除规则（要求 actor 在白名单）' },
      pushNow: { description: '立刻推一次（运维 / 测试用）' },
    },
  } as const

  readonly config: ResolvedContentAuditConfig
  private logger: Logger
  private store: JsonStore<ContentAuditFile>
  private rules: StoredRule[] = []
  private ready = false
  private disposed = false
  private revision: string | null = null
  private generation = 0
  private lastPushAt: string | null = null
  private lastError: string | null = null
  private pushes = 0
  private heartbeats = 0
  private failures = 0
  private failureStreak = 0
  private inFlight = false
  private lastWarnAt = 0
  private goTtlMs: number | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, config: ContentAuditConfig | ResolvedContentAuditConfig = {}) {
    super(ctx, 'contentAudit')
    this.config = resolveConfig(config)
    const path = resolveDataPath(ctx, this.config.dataPath)
    this.store = path === undefined ? memoryStore() : jsonFileStore<ContentAuditFile>(path, fileCodec, emptyFile)
    this.logger = ctx.logger('contentAudit')
  }

  async *[Service.init](): AsyncGenerator<() => void> {
    try {
      const file = await this.store.read()
      this.rules = decodeRules(file)
    } catch (error) {
      // 装载失败必须明确失败：宁可插件停在初始化错误上，也不能带着半份规则继续拦人。
      if (isContentAuditError(error) && error.code === 'CONTENT_AUDIT_STORE_FAILED') throw error
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', `规则文件装载失败：${describeError(error)}`)
    }
    this.ready = true

    // 注册即副作用：心跳定时器挂 effect，卸载即停（D5）。
    this.ctx.effect(() => {
      const stop = this.ctx.setInterval(() => {
        void this.push('interval')
      }, this.config.pushIntervalMs)
      return () => {
        this.disposed = true
        stop()
      }
    }, 'contentAudit.poll')

    // 启动先推一次：别让 Go 等到第一个轮询周期（也让它知道「审核是否开启」）。
    void this.push('start')
    this.logger.info(
      `内容审核已装载：${String(this.rules.length)} 条规则、心跳 ${String(this.config.pushIntervalMs)}ms、` +
        `审核${this.config.enabled ? '开启' : '关闭'}`,
    )
    yield () => {
      this.disposed = true
      this.ready = false
    }
  }

  // ───────────────────────────────── 读

  /** 规则列表（要求 actor 在白名单）。 */
  list(actor: string): readonly ContentAuditRule[] {
    this.assertAdmin(actor)
    this.assertReady()
    return this.rules.map(copyRule)
  }

  /** 单条规则（要求 actor 在白名单）。 */
  get(actor: string, id: string): ContentAuditRule | null {
    this.assertAdmin(actor)
    this.assertReady()
    const rule = this.rules.find((item) => item.id === id)
    return rule === undefined ? null : copyRule(rule)
  }

  /**
   * 插件状态：本地推送状态 + Go 侧健康度与命中统计。
   *
   * Go 侧读不到（桥断 / 旧二进制）时对应字段为 null，**不编造 0**。
   */
  async status(): Promise<ContentAuditStatus> {
    const go = await this.readGoStatus()
    const ageMs = numberOrNull(go?.ageMs)
    const ttlMs = numberOrNull(go?.ttlMs)
    return {
      enabled: this.config.enabled,
      pushIntervalMs: this.config.pushIntervalMs,
      ruleCount: this.rules.length,
      revision: this.revision,
      generation: this.generation,
      ageMs,
      ttlMs,
      stale: go === null ? null : go.stale === true || (ageMs !== null && ttlMs !== null && ageMs > ttlMs),
      goReady: go === null ? null : go.ready === true,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
      pushes: this.pushes,
      heartbeats: this.heartbeats,
      failureStreak: this.failureStreak,
      goTtlMs: ttlMs ?? this.goTtlMs,
      heartbeatTooSlow: heartbeatTooSlow(ttlMs ?? this.goTtlMs, this.config.pushIntervalMs),
      hits: hitsOf(go),
    }
  }

  /** 命中统计（要求 actor 在白名单；数据来自 Go 的 contentaudit.status）。 */
  async hits(actor: string): Promise<ContentAuditStatus['hits']> {
    this.assertAdmin(actor)
    return hitsOf(await this.readGoStatus())
  }

  // ───────────────────────────────── 写

  async create(actor: string, input: ContentAuditRuleInput): Promise<ContentAuditRule> {
    this.assertAdmin(actor)
    this.assertReady()
    const pattern = normalizePattern(input.pattern)
    const action = normalizeAction(input.action)
    this.assertPatternUnique(pattern, null)
    if (this.rules.length >= MAX_RULES) {
      throw new ContentAuditError('CONTENT_AUDIT_INPUT_INVALID', `规则数量已达上限 ${String(MAX_RULES)}`)
    }
    const now = nowIso()
    const rule: StoredRule = Object.freeze({
      id: newRuleId(),
      pattern,
      action,
      category: optionalText(input.category, MAX_CATEGORY_LENGTH, 'category'),
      enabled: input.enabled ?? true,
      note: optionalText(input.note, MAX_NOTE_LENGTH, 'note'),
      createdAt: now,
      updatedAt: now,
    })
    await this.exclusive(async () => {
      const next = [...this.rules, rule]
      await this.persist(next)
      this.rules = next
    })
    this.ctx.emit('contentaudit/changed', rule.id, 'create')
    await this.push('changed')
    return copyRule(rule)
  }

  async update(actor: string, id: string, patch: ContentAuditRulePatch): Promise<ContentAuditRule> {
    this.assertAdmin(actor)
    this.assertReady()
    const index = this.rules.findIndex((item) => item.id === id)
    if (index < 0) throw new ContentAuditError('CONTENT_AUDIT_RULE_NOT_FOUND', `规则不存在：${id}`)
    const current = this.rules[index] as StoredRule
    const pattern = patch.pattern === undefined ? current.pattern : normalizePattern(patch.pattern)
    if (pattern !== current.pattern) this.assertPatternUnique(pattern, id)
    const next: StoredRule = Object.freeze({
      ...current,
      pattern,
      action: patch.action === undefined ? current.action : normalizeAction(patch.action),
      category:
        patch.category === undefined
          ? current.category
          : optionalText(patch.category, MAX_CATEGORY_LENGTH, 'category'),
      enabled: patch.enabled === undefined ? current.enabled : patch.enabled,
      note: patch.note === undefined ? current.note : optionalText(patch.note, MAX_NOTE_LENGTH, 'note'),
      updatedAt: nowIso(),
    })
    await this.exclusive(async () => {
      const rules = [...this.rules]
      rules[index] = next
      await this.persist(rules)
      this.rules = rules
    })
    this.ctx.emit('contentaudit/changed', next.id, 'update')
    await this.push('changed')
    return copyRule(next)
  }

  async remove(actor: string, id: string): Promise<boolean> {
    this.assertAdmin(actor)
    this.assertReady()
    let removed = false
    await this.exclusive(async () => {
      const rules = this.rules.filter((item) => item.id !== id)
      removed = rules.length !== this.rules.length
      if (!removed) return
      await this.persist(rules)
      this.rules = rules
    })
    if (!removed) return false
    this.ctx.emit('contentaudit/changed', id, 'delete')
    await this.push('changed')
    return true
  }

  /** 立刻推一次（测试与运维用）；返回这一轮的 revision（失败返回 null）。 */
  async pushNow(): Promise<string | null> {
    await this.push('manual')
    return this.revision
  }

  // ───────────────────────────────── 推送

  /** 单飞：同一时刻最多一次推送，其余排队（队列吞掉失败，避免污染下一轮）。 */
  private push(reason: string): Promise<void> {
    const task = this.queue.then(
      () => this.doPush(reason),
      () => this.doPush(reason),
    )
    this.queue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async doPush(reason: string): Promise<void> {
    if (this.disposed) return
    this.inFlight = true
    try {
      const rules = this.config.enabled
        ? this.rules
            .filter((rule) => rule.enabled)
            .map((rule) => ({
              id: rule.id,
              pattern: rule.pattern,
              action: rule.action,
              ...(rule.category === undefined ? {} : { category: rule.category }),
            }))
        : []
      const revision = hashRules(this.config.enabled, rules)
      const unchanged = revision === this.revision
      // 心跳推送：内容没变也推（revision 相同、generation 递增），Go 侧借此刷新 updatedAt。
      const payload: ContentAuditSnapshotPayload = {
        version: 1,
        generation: this.nextGeneration(),
        revision,
        enabled: this.config.enabled,
        rules,
      }
      await this.bridgeSeam().replaceContentAudit(payload)
      this.revision = revision
      this.lastPushAt = new Date().toISOString()
      this.lastError = null
      this.failureStreak = 0
      this.pushes += 1
      if (unchanged) this.heartbeats += 1
      this.logger.debug(
        `内容审核规则已推送（${reason}${unchanged ? '，内容未变=心跳' : ''}）：` +
          `revision=${revision} rules=${String(rules.length)} enabled=${String(this.config.enabled)}`,
      )
      this.ctx.emit('contentaudit/pushed', revision, rules.length)
    } catch (error) {
      this.failures += 1
      this.failureStreak += 1
      this.lastError = describeError(error)
      this.warnThrottled(
        `推送内容审核规则失败（${reason}，连续第 ${String(this.failureStreak)} 次）：${this.lastError}`,
      )
      this.ctx.emit('contentaudit/error', 'CONTENT_AUDIT_PUSH_FAILED', this.lastError)
    } finally {
      this.inFlight = false
    }
  }

  private nextGeneration(): number {
    const now = Date.now()
    this.generation = now > this.generation ? now : this.generation + 1
    return this.generation
  }

  /** 失败告警：第 1 次立即报，之后每 10 次连续失败再报一次（带连续次数）。 */
  private warnThrottled(message: string): void {
    const first = this.failureStreak === 1
    const sustained = this.failureStreak > 1 && this.failureStreak % 10 === 0
    if (!first && !sustained) return
    const now = Date.now()
    if (now - this.lastWarnAt < DEFAULT_WARN_THROTTLE_MS) return
    this.lastWarnAt = now
    this.logger.warn(message)
  }

  private async readGoStatus(): Promise<GoStatus | null> {
    try {
      const status = (await this.bridgeSeam().contentAuditStatus()) as GoStatus | null
      if (status === null || typeof status !== 'object') return null
      const ttl = numberOrNull(status.ttlMs)
      if (ttl !== null) this.goTtlMs = ttl
      return status
    } catch {
      return null
    }
  }

  // ───────────────────────────────── 内部

  private async persist(rules: readonly StoredRule[]): Promise<void> {
    try {
      await this.store.write({ version: FILE_VERSION, rules })
    } catch (error) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', `规则写入失败：${describeError(error)}`)
    }
  }

  private assertAdmin(actor: string): void {
    const allowed = this.config.adminPlugins
    if (!allowed.includes(actor)) {
      throw new ContentAuditError('CONTENT_AUDIT_FORBIDDEN', `插件 ${actor || '(空)'} 不在内容审核白名单里`)
    }
  }

  private assertReady(): void {
    if (!this.ready) {
      throw new ContentAuditError('CONTENT_AUDIT_NOT_READY', '内容审核规则尚未装载完成')
    }
  }

  private assertPatternUnique(pattern: string, exceptId: string | null): void {
    const lowered = pattern.toLowerCase()
    const duplicate = this.rules.find(
      (rule) => rule.id !== exceptId && rule.pattern.toLowerCase() === lowered,
    )
    if (duplicate !== undefined) {
      throw new ContentAuditError('CONTENT_AUDIT_RULE_DUPLICATE', `规则已存在（忽略大小写）：${pattern}`)
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private bridgeSeam(): BridgeSeam {
    return this.ctx.get('accountPriority') as unknown as BridgeSeam
  }
}

/**
 * 判断 Go 侧 TTL 是否跟不上推送节奏（配置耦合护栏，与 quota 同口径）。
 *
 * 心跳能刷新快照的前提是「两次推送之间的间隔明显小于 TTL」；经验值是 TTL ≥ 3 × 间隔，
 * 这里按 2 × 间隔做最低告警线（留一次网络抖动 / 事件循环延迟的余量）。
 */
export function heartbeatTooSlow(ttlMs: number | null, pushIntervalMs: number): boolean {
  if (ttlMs === null || ttlMs <= 0 || pushIntervalMs <= 0) return false
  return ttlMs < pushIntervalMs * 2
}

function hitsOf(status: GoStatus | null): ContentAuditStatus['hits'] {
  if (status === null) return null
  const gate = status.gate
  if (gate === null || typeof gate !== 'object') return null
  const record = gate as Record<string, unknown>
  const byRule: Record<string, number> = {}
  const rawHits = record.ruleHits
  if (rawHits !== null && typeof rawHits === 'object') {
    for (const [id, value] of Object.entries(rawHits as Record<string, unknown>)) {
      const count = numberOrNull(value)
      if (count !== null) byRule[id] = count
    }
  }
  return {
    blocked: numberOrNull(record.blocked) ?? 0,
    logged: numberOrNull(record.logged) ?? 0,
    allowedStale: numberOrNull(record.allowedStale) ?? 0,
    strictFailed: numberOrNull(record.strictFailed) ?? 0,
    parseFailed: numberOrNull(record.parseFailed) ?? 0,
    noText: numberOrNull(record.noText) ?? 0,
    truncated: numberOrNull(record.truncated) ?? 0,
    ruleHitTotal: numberOrNull(record.ruleHitTotal) ?? 0,
    byRule,
    staleStreak: numberOrNull(record.staleStreak) ?? 0,
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function resolveConfig(config: ContentAuditConfig | ResolvedContentAuditConfig): ResolvedContentAuditConfig {
  return {
    dataPath: config.dataPath ?? './data/content-audit.json',
    enabled: config.enabled ?? false,
    pushIntervalMs: config.pushIntervalMs ?? 5_000,
    adminPlugins: config.adminPlugins ?? [],
  }
}

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  if (path === undefined || path === '' || isAbsolute(path)) return path === '' ? undefined : path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function newRuleId(): string {
  return `car_${randomBytes(8).toString('hex')}`
}

function normalizePattern(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ContentAuditError('CONTENT_AUDIT_INPUT_INVALID', 'pattern 必须是字符串')
  }
  const pattern = value.trim()
  if (pattern === '' || pattern.length > MAX_PATTERN_LENGTH) {
    throw new ContentAuditError(
      'CONTENT_AUDIT_INPUT_INVALID',
      `pattern 长度必须在 1..${String(MAX_PATTERN_LENGTH)} 之间`,
    )
  }
  // 控制字符会污染日志与 JSON；匹配本身是子串，不需要别的限制。
  if (/[\u0000-\u001f\u007f]/.test(pattern)) {
    throw new ContentAuditError('CONTENT_AUDIT_INPUT_INVALID', 'pattern 不能包含控制字符')
  }
  return pattern
}

function normalizeAction(value: unknown): 'block' | 'log' {
  if (value === undefined) return 'block'
  if (value === 'block' || value === 'log') return value
  throw new ContentAuditError('CONTENT_AUDIT_INPUT_INVALID', 'action 只能是 block / log')
}

function optionalText(value: unknown, max: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new ContentAuditError('CONTENT_AUDIT_INPUT_INVALID', `${field} 必须是字符串`)
  }
  const text = value.trim()
  if (text === '') return undefined
  if (text.length > max) {
    throw new ContentAuditError('CONTENT_AUDIT_INPUT_INVALID', `${field} 不能超过 ${String(max)} 个字符`)
  }
  return text
}

function copyRule(rule: StoredRule): ContentAuditRule {
  return { ...rule }
}

function hashRules(enabled: boolean, rules: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify({ enabled, rules })).digest('hex').slice(0, 32)
}

function emptyFile(): ContentAuditFile {
  return { version: FILE_VERSION, rules: [] }
}

const fileCodec = {
  encode(file: ContentAuditFile): unknown {
    return { version: file.version, rules: file.rules }
  },
  decode(raw: unknown): ContentAuditFile {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', '规则文件必须是 JSON 对象')
    }
    const record = raw as Record<string, unknown>
    const version = record.version ?? FILE_VERSION
    if (version !== FILE_VERSION) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', `规则文件版本不支持：${String(version)}`)
    }
    const rules = record.rules
    if (rules === undefined) return emptyFile()
    if (!Array.isArray(rules)) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', 'rules 必须是数组')
    }
    return { version: FILE_VERSION, rules: rules as StoredRule[] }
  },
}

function memoryStore(): JsonStore<ContentAuditFile> {
  let current = emptyFile()
  return {
    describe: 'memory（进程退出即丢）',
    path: undefined,
    async read() {
      return current
    },
    async write(value) {
      current = value
    },
    async close() {
      // 无待落盘状态
    },
  }
}

/** 把文件里的规则解码成领域对象；非法值明确失败（不静默丢规则）。 */
function decodeRules(file: ContentAuditFile): StoredRule[] {
  const seenPatterns = new Set<string>()
  const seenIds = new Set<string>()
  const rules: StoredRule[] = []
  for (const stored of file.rules ?? []) {
    if (typeof stored !== 'object' || stored === null) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', '规则条目不是对象')
    }
    const entry = stored as Partial<StoredRule>
    if (typeof entry.id !== 'string' || entry.id === '' || entry.id.length > MAX_ID_LENGTH) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', '规则 id 不合法')
    }
    if (seenIds.has(entry.id)) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', `规则 id 重复：${entry.id}`)
    }
    seenIds.add(entry.id)
    const pattern = normalizePattern(entry.pattern)
    const lowered = pattern.toLowerCase()
    if (seenPatterns.has(lowered)) {
      throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', `规则 pattern 重复：${pattern}`)
    }
    seenPatterns.add(lowered)
    const action = normalizeAction(entry.action)
    const createdAt = typeof entry.createdAt === 'string' ? entry.createdAt : nowIso()
    const category = optionalText(entry.category, MAX_CATEGORY_LENGTH, 'category')
    const note = optionalText(entry.note, MAX_NOTE_LENGTH, 'note')
    rules.push({
      id: entry.id,
      pattern,
      action,
      ...(category === undefined ? {} : { category }),
      enabled: entry.enabled !== false,
      ...(note === undefined ? {} : { note }),
      createdAt,
      updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : createdAt,
    })
  }
  if (rules.length > MAX_RULES) {
    throw new ContentAuditError('CONTENT_AUDIT_STORE_FAILED', `规则数量超过上限 ${String(MAX_RULES)}`)
  }
  return rules
}
