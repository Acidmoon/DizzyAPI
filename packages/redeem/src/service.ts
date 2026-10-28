/**
 * 兑换码插件（服务名 `redeem`）。
 *
 * 它是**兑换码表与批次表的唯一写者**：生成、启停、删除、兑换状态流转都只经由这里。
 * 存储是 SQLite（`node:sqlite`），只落 sha256 哈希与掩码；明文只在 `createBatch`
 * 的返回值里出现一次。加余额**只经** `user.adjustBalance(...)`——`user` 是余额唯一写者，
 * 本插件不碰 `users.db`。
 *
 * ## 幂等为什么用 CAS 而不是锁
 *
 * `users.db` 与 `redeem.db` 不在同一个事务里，进程内又没有分布式锁。所以兑换分成三步，
 * 第一步用条件更新抢占：
 *
 * 1. `UPDATE ... SET status='redeeming' WHERE id=? AND status='enabled'`；
 *    `changes === 0` 就是并发输家，直接报冲突，绝不加钱。
 * 2. `user.adjustBalance(...)`——失败就把状态回退成 `enabled` 并把错误抛出去（钱没到账，
 *    码必须还能再用）。
 * 3. 标记 `used`。
 *
 * ## 为什么 `redeeming` 不自动回收
 *
 * `adjustBalance` 既没有幂等键、也不返回流水 id，进程若在第 2 步与第 3 步之间崩掉，
 * 自动把 `redeeming` 改回 `enabled` 可能让同一个码**重复到账**。所以宁可留成显式状态：
 * 管理页把它单列成「兑换中（需人工核查）」，由管理员显式选「标记为已用」或「退回可用」。
 *
 * 注意：成员不能用 `#` 私有字段。cordis 以 Proxy 作为 receiver 调用服务方法，
 * `#` 字段的 brand check 会抛「Receiver must be an instance of class」。
 */
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Logger } from 'cordis'
import { constantTimeHexEqual, isIssueList } from '@dizzyapi/plugin-kit'
import { codeDigest, codeMask, formatCodeForDisplay, generateCode, normalizeCode } from './code.ts'
import {
  REDEEM_CONFIG_SCHEMA,
  validateRedeemConfig,
  type RedeemConfig,
  type ResolvedRedeemConfig,
} from './config.ts'
import {
  asRow,
  batchSelect,
  codeSelect,
  immediateTransaction,
  openRedeemDatabase,
  prepareRead,
  readChanges,
  readCount,
  toBatchView,
  toCodeView,
  type RedeemBatchRow,
  type RedeemCodeRow,
} from './db.ts'
import { RedeemError } from './errors.ts'
import {
  REDEEM_ACTOR,
  REDEEM_AMOUNT_MAX_MICROS,
  REDEEM_BATCH_COUNT_MAX,
  REDEEM_BATCH_COUNT_MIN,
  REDEEM_BATCH_NAME_MAX_LENGTH,
  REDEEM_BATCH_NOTES_MAX_LENGTH,
  REDEEM_DELETE_MAX_BATCH,
  REDEEM_HASH_ATTEMPTS,
  REDEEM_LIST_DEFAULT_LIMIT,
  REDEEM_LIST_MAX_LIMIT,
  REDEEM_MY_LIST_DEFAULT_LIMIT,
  REDEEM_MY_LIST_MAX_LIMIT,
  type RedeemBatchQuery,
  type RedeemBatchView,
  type RedeemChangedEvent,
  type RedeemCodeFilter,
  type RedeemCodePage,
  type RedeemCodeQuery,
  type RedeemCodeStatus,
  type RedeemCodeView,
  type RedeemDeletionRejection,
  type RedeemDeletionResult,
  type RedeemResolveOutcome,
  type RedeemResult,
  type RedeemStats,
  type RedemptionView,
} from './types.ts'

export interface CreateBatchInput {
  readonly name: string
  /** 单码额度（微元）。接受 bigint、十进制字符串或安全整数。 */
  readonly amountMicro: bigint | string | number
  readonly count: number
  /** ISO 8601；省略 = 永不过期。必须晚于当前时间。 */
  readonly expiresAt?: string | null
  readonly notes?: string | null
}

export interface CreateBatchResult {
  readonly batch: RedeemBatchView
  /** 明文码（已分组）；**只在这一刻出现一次**，调用方负责展示与保存。 */
  readonly codes: readonly string[]
}

export interface RedeemInput {
  readonly userId: number
  readonly code: string
}

const ZERO_HASH = '0'.repeat(64)
const MAX_ID_LENGTH = 128
const MAX_ACTOR_LENGTH = 200

export class RedeemService extends Service {
  static Config = REDEEM_CONFIG_SCHEMA
  /** 兑换要把额度加到用户余额上；user 不在时不需要构造本插件。 */
  static inject = ['user']

  /** 能力清单：目录可见的部分；不含任何码、哈希或明文。 */
  static catalog = {
    capabilities: ['redeem', 'redeem-codes', 'redemption-batches'],
    events: [
      {
        name: 'redeem/changed',
        description: '批次 / 兑换码状态变化或兑换成功（不含明文与哈希）',
        payload: '{ action: "batch-created" | "code-redeemed" | "code-updated", batchId: string | null, count: number }',
      },
    ],
    bridge: [],
    storage: [
      { key: 'dataPath', kind: 'file', description: '兑换码与批次 SQLite（只含 sha256 哈希与掩码）' },
    ],
    shapes: {
      RedeemBatchView:
        'id,name,kind,amountMicro,total,notes,createdBy,createdAt,expiresAt,codeCount,usedCount',
      RedeemCodeView:
        'id,batchId,batchName,codeMask,kind,amountMicro,status,createdAt,expiresAt,reservedAt,reservedBy,redeemedAt,redeemedBy,disabledBy,disabledAt',
      RedeemResult: 'amount,balance,batchName',
    },
  } as const

  readonly config: ResolvedRedeemConfig
  private readonly db: ReturnType<typeof openRedeemDatabase>
  private readonly adminPlugins: readonly string[]
  private readonly logger: Logger
  private closed = false

  constructor(ctx: Context, config: RedeemConfig | ResolvedRedeemConfig = {}) {
    super(ctx, 'redeem')
    const resolved = validateRedeemConfig(config)
    if (isIssueList(resolved)) {
      throw new RedeemError(
        'REDEEM_INVALID_INPUT',
        `兑换码配置不合法：${resolved.map((item) => item.message).join('；')}`,
      )
    }
    this.config = resolved
    this.adminPlugins = resolved.adminPlugins
    this.logger = ctx.logger('redeem')
    this.db = openRedeemDatabase(resolveDataPath(ctx, resolved.dataPath))

    this.logger.info(
      `兑换码插件已装载：存储 ${resolved.dataPath === undefined ? ':memory:' : resolved.dataPath}；` +
        `管理面写者 ${this.adminPlugins.join(' / ') || '（无）'}`,
    )
    if (this.adminPlugins.length === 0) {
      this.logger.warn('adminPlugins 为空：当前没有任何插件可以生成 / 启停 / 删除兑换码')
    }

    // 注册即副作用：插件卸载时数据库连接跟着关闭（AGENTS.md D5）。
    // 本插件没有定时器、没有后台任务，禁用即全部回收。
    ctx.effect(() => () => this.close(), 'redeem.store')
  }

  // ───────────────────────────────── 用户面 ─────────────────────────────────

  /**
   * 兑换。同一码在并发下只能成功一次：靠 `enabled → redeeming` 的条件更新抢占，
   * `changes === 0` 直接判输，绝不加钱。
   */
  async redeemCode(input: RedeemInput): Promise<RedeemResult> {
    const userId = normalizeUserId(input?.userId)
    const code = normalizeCode(input?.code)
    const digest = codeDigest(code)
    const now = new Date().toISOString()

    const candidate = this.findByHash(digest)
    // 不存在的码也走一次常量时间比较，让「存在与否」在耗时上看不出差别。
    const stored = candidate?.code_hash ?? ZERO_HASH
    if (!constantTimeHexEqual(stored, digest) || candidate === undefined) {
      throw new RedeemError('REDEEM_CODE_NOT_FOUND', '兑换码不存在或已失效')
    }
    if (candidate.kind !== 'balance') {
      throw new RedeemError('REDEEM_CODE_INVALID', '这个兑换码的额度类型暂不支持')
    }

    await this.assertRedeemableUser(userId)
    const batchName = this.batchNameOf(candidate.batch_id)
    const amount = candidate.amount_micro

    if (!this.reserve(candidate.id, userId, now)) throw this.unavailable(candidate.id, now)

    let balance: bigint
    try {
      balance = await this.ctx.user.adjustBalance(
        REDEEM_ACTOR,
        userId,
        amount,
        `兑换码 ${candidate.code_mask}`,
      )
    } catch (error) {
      // 钱没到账：把码放回去，并把失败抛给调用方。回退失败时状态仍是 redeeming，
      // 那就是「需人工核查」，不会静默变成可用。
      this.release(candidate.id)
      this.logger.warn(
        `兑换码 ${candidate.code_mask} 加余额失败，已退回可用：${describeError(error)}`,
      )
      throw new RedeemError('REDEEM_CODE_BALANCE_FAILED', '兑换失败，额度未到账；兑换码仍可再次使用')
    }

    if (!this.markUsed(candidate.id, userId, now)) {
      // 理论上不可能：同一进程内只有一个写者，且两步都是同步语句。
      this.logger.error(
        `兑换码 ${candidate.code_mask} 已加余额但未能标记为已用，请人工核查（状态留在 redeeming）`,
      )
      throw new RedeemError('REDEEM_STORE_CORRUPT', '兑换状态写入失败，请联系管理员核查')
    }

    this.emit({ action: 'code-redeemed', batchId: candidate.batch_id, count: 1 })
    return { amount, balance, batchName }
  }

  /** 我的兑换记录（只含已成功的；掩码、时间、金额、批次名）。 */
  async listMyRedemptions(userId: number, limit?: number): Promise<RedemptionView[]> {
    const uid = normalizeUserId(userId)
    const take = normalizeLimit(limit, REDEEM_MY_LIST_DEFAULT_LIMIT, REDEEM_MY_LIST_MAX_LIMIT)
    const rows = prepareRead(
      this.db,
      `SELECT c.id AS id,
              c.code_mask AS code_mask,
              c.amount_micro AS amount_micro,
              c.redeemed_at AS redeemed_at,
              b.name AS batch_name
         FROM redeem_codes c
         LEFT JOIN redeem_batches b ON b.id = c.batch_id
        WHERE c.redeemed_by = ? AND c.status = 'used'
        ORDER BY c.redeemed_at DESC, c.rowid DESC
        LIMIT ?`,
    ).all(String(uid), take) as Record<string, unknown>[]

    return rows.map((row) => ({
      codeId: String(row.id),
      codeMask: String(row.code_mask),
      amountMicro: readAmount(row.amount_micro, 'redeem_codes.amount_micro'),
      batchName: typeof row.batch_name === 'string' ? row.batch_name : null,
      redeemedAt: typeof row.redeemed_at === 'string' ? row.redeemed_at : null,
    }))
  }

  // ───────────────────────────────── 管理面：批次 ─────────────────────────────────

  /**
   * 生成一批兑换码。**整批在一个事务里成功或整批失败**，绝不半成功。
   * 返回值里的明文是它唯一一次出现的地方。
   */
  async createBatch(actor: string, input: CreateBatchInput): Promise<CreateBatchResult> {
    const admin = this.assertAdmin(actor)
    const name = normalizeName(input?.name)
    const amountMicro = normalizeAmount(input?.amountMicro)
    const count = normalizeCount(input?.count)
    const notes = normalizeNotes(input?.notes)
    const createdAt = new Date().toISOString()
    const expiresAt = normalizeExpiresAt(input?.expiresAt, createdAt)
    const batchId = randomUUID()

    const codes: string[] = []
    const batch = immediateTransaction(this.db, () => {
      this.db
        .prepare(
          'INSERT INTO redeem_batches (id, name, kind, amount_micro, total, notes, created_by, created_at, expires_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(batchId, name, 'balance', amountMicro, count, notes, admin, createdAt, expiresAt)

      const insert = this.db.prepare(
        'INSERT INTO redeem_codes (' +
          'id, batch_id, code_hash, code_mask, kind, amount_micro, status, created_at, expires_at, ' +
          'reserved_at, reserved_by, redeemed_at, redeemed_by, disabled_by, disabled_at' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)',
      )
      const exists = this.db.prepare('SELECT id FROM redeem_codes WHERE code_hash = ?')

      for (let index = 0; index < count; index += 1) {
        let code: string | undefined
        let digest: string | undefined
        for (let attempt = 0; attempt < REDEEM_HASH_ATTEMPTS; attempt += 1) {
          const candidate = generateCode()
          const candidateDigest = codeDigest(candidate)
          if (exists.get(candidateDigest) !== undefined) continue
          code = candidate
          digest = candidateDigest
          break
        }
        if (code === undefined || digest === undefined) {
          throw new RedeemError('REDEEM_INVALID_INPUT', '生成唯一兑换码失败，请重试')
        }
        insert.run(
          randomUUID(),
          batchId,
          digest,
          codeMask(code),
          'balance',
          amountMicro,
          'enabled',
          createdAt,
          expiresAt,
        )
        codes.push(formatCodeForDisplay(code))
      }

      return this.requireBatchRow(batchId)
    })

    this.emit({ action: 'batch-created', batchId, count: codes.length })
    return { batch: toBatchView(batch), codes }
  }

  async listBatches(actor: string, query: RedeemBatchQuery = {}): Promise<RedeemBatchView[]> {
    this.assertAdmin(actor)
    const limit = normalizeLimit(query.limit, REDEEM_LIST_DEFAULT_LIMIT, REDEEM_LIST_MAX_LIMIT)
    const offset = normalizeOffset(query.offset)
    const rows = prepareRead(
      this.db,
      `${batchSelect()} ORDER BY b.created_at DESC, b.rowid DESC LIMIT ? OFFSET ?`,
    ).all(limit, offset) as unknown as RedeemBatchRow[]
    return rows.map((row) => toBatchView(row))
  }

  async getBatch(actor: string, batchId: string): Promise<RedeemBatchView> {
    this.assertAdmin(actor)
    const id = normalizeId(batchId, '批次 id')
    return toBatchView(this.requireBatchRow(id))
  }

  // ───────────────────────────────── 管理面：码 ─────────────────────────────────

  /** 列表：只有掩码，永远不含明文或哈希。 */
  async listCodes(actor: string, query: RedeemCodeQuery = {}): Promise<RedeemCodePage> {
    this.assertAdmin(actor)
    const limit = normalizeLimit(query.limit, REDEEM_LIST_DEFAULT_LIMIT, REDEEM_LIST_MAX_LIMIT)
    const offset = normalizeOffset(query.offset)

    const clauses: string[] = []
    const params: (string | number)[] = []
    if (query.batchId !== undefined && query.batchId !== '') {
      clauses.push('c.batch_id = ?')
      params.push(normalizeId(query.batchId, '批次 id'))
    }
    const status = normalizeFilter(query.status)
    if (status === 'expired') {
      clauses.push("c.status = 'enabled' AND c.expires_at IS NOT NULL AND c.expires_at <= ?")
      params.push(new Date().toISOString())
    } else if (status !== undefined) {
      clauses.push('c.status = ?')
      params.push(status)
    }
    const keyword = normalizeKeyword(query.keyword)
    if (keyword !== undefined) {
      // 用 instr 而不是 LIKE：掩码里用不到通配符，也就没有转义问题。
      clauses.push('instr(c.code_mask, ?) > 0')
      params.push(keyword)
    }

    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`
    const totalRow = prepareRead(this.db, `SELECT COUNT(*) AS n FROM redeem_codes c${where}`).get(
      ...params,
    )
    const total = readCount(totalRow?.n, 'redeem_codes 计数')

    const rows = prepareRead(
      this.db,
      `${codeSelect()}${where} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as unknown as RedeemCodeRow[]

    return { items: rows.map((row) => toCodeView(row)), total }
  }

  /**
   * 单码启停：只允许 `enabled ↔ disabled`。
   * 已用 / 兑换中的码不能用它改状态（后者要走人工核查结论）。
   */
  async setCodeStatus(actor: string, codeId: string, status: 'enabled' | 'disabled'): Promise<RedeemCodeView> {
    const admin = this.assertAdmin(actor)
    const id = normalizeId(codeId, '兑换码 id')
    if (status !== 'enabled' && status !== 'disabled') {
      throw new RedeemError('REDEEM_INVALID_INPUT', 'status 只能是 enabled / disabled')
    }
    const now = new Date().toISOString()
    const result =
      status === 'disabled'
        ? this.db
            .prepare(
              "UPDATE redeem_codes SET status = 'disabled', disabled_by = ?, disabled_at = ? " +
                "WHERE id = ? AND status IN ('enabled', 'disabled')",
            )
            .run(admin, now, id)
        : this.db
            .prepare(
              "UPDATE redeem_codes SET status = 'enabled', disabled_by = NULL, disabled_at = NULL " +
                "WHERE id = ? AND status IN ('enabled', 'disabled')",
            )
            .run(id)

    if (readChanges(result.changes) === 0) this.throwUnchangeableStatus(id)
    this.emit({ action: 'code-updated', batchId: null, count: 1 })
    return this.requireCodeView(id)
  }

  /** 批量删除：`used` 与 `redeeming` 一律拒删，逐条给出原因。 */
  async deleteCodes(actor: string, ids: readonly string[]): Promise<RedeemDeletionResult> {
    this.assertAdmin(actor)
    const target = normalizeIds(ids)
    const rejected: RedeemDeletionRejection[] = []
    let deleted = 0

    immediateTransaction(this.db, () => {
      const statusOf = this.db.prepare('SELECT status FROM redeem_codes WHERE id = ?')
      const remove = this.db.prepare(
        "DELETE FROM redeem_codes WHERE id = ? AND status IN ('enabled', 'disabled')",
      )
      for (const id of target) {
        const row = statusOf.get(id)
        if (row === undefined) {
          rejected.push({ id, reason: 'REDEEM_CODE_NOT_FOUND' })
          continue
        }
        const status = String(row.status)
        if (status === 'used') {
          rejected.push({ id, reason: 'REDEEM_CODE_USED' })
          continue
        }
        if (status === 'redeeming') {
          rejected.push({ id, reason: 'REDEEM_CODE_REDEEMING' })
          continue
        }
        deleted += readChanges(remove.run(id).changes)
      }
    })

    if (deleted > 0) this.emit({ action: 'code-updated', batchId: null, count: deleted })
    return { deleted, rejected }
  }

  /**
   * 人工核查「兑换中」的结论。
   *
   * - `used`：确认额度已到账（`redeeming` 是加完余额后没来得及标记的状态），
   *   把它收成 `used`，`redeemed_by` 取占位时记下的 `reserved_by`；
   * - `enabled`：确认没到账，退回可用。
   *
   * 不做自动回收的理由见文件头：`adjustBalance` 没有幂等键，自动回收可能重复到账。
   */
  async resolveRedeeming(
    actor: string,
    codeId: string,
    outcome: RedeemResolveOutcome,
  ): Promise<RedeemCodeView> {
    this.assertAdmin(actor)
    const id = normalizeId(codeId, '兑换码 id')
    if (outcome !== 'used' && outcome !== 'enabled') {
      throw new RedeemError('REDEEM_INVALID_INPUT', 'outcome 只能是 used / enabled')
    }
    const now = new Date().toISOString()
    const result =
      outcome === 'used'
        ? this.db
            .prepare(
              "UPDATE redeem_codes SET status = 'used', redeemed_at = ?, redeemed_by = reserved_by, reserved_at = NULL " +
                "WHERE id = ? AND status = 'redeeming'",
            )
            .run(now, id)
        : this.db
            .prepare(
              "UPDATE redeem_codes SET status = 'enabled', reserved_at = NULL, reserved_by = NULL " +
                "WHERE id = ? AND status = 'redeeming'",
            )
            .run(id)

    if (readChanges(result.changes) === 0) this.throwUnchangeableStatus(id)
    this.emit({ action: 'code-updated', batchId: null, count: 1 })
    return this.requireCodeView(id)
  }

  /** 真统计：各状态计数与已兑总额（微元）。没有 mock 0。 */
  async stats(actor: string): Promise<RedeemStats> {
    this.assertAdmin(actor)
    const now = new Date().toISOString()
    const count = (sql: string, ...params: (string | number | bigint)[]): number =>
      readCount(prepareRead(this.db, sql).get(...params)?.n, '兑换码统计')
    const sum = prepareRead(
      this.db,
      "SELECT COALESCE(SUM(amount_micro), 0) AS n FROM redeem_codes WHERE status = 'used'",
    ).get()

    return {
      batches: count('SELECT COUNT(*) AS n FROM redeem_batches'),
      codes: count('SELECT COUNT(*) AS n FROM redeem_codes'),
      enabled: count("SELECT COUNT(*) AS n FROM redeem_codes WHERE status = 'enabled'"),
      disabled: count("SELECT COUNT(*) AS n FROM redeem_codes WHERE status = 'disabled'"),
      redeeming: count("SELECT COUNT(*) AS n FROM redeem_codes WHERE status = 'redeeming'"),
      used: count("SELECT COUNT(*) AS n FROM redeem_codes WHERE status = 'used'"),
      expired: count(
        "SELECT COUNT(*) AS n FROM redeem_codes WHERE status = 'enabled' AND expires_at IS NOT NULL AND expires_at <= ?",
        now,
      ),
      redeemedAmountMicro: readAmount(sum?.n ?? 0n, 'redeemedAmountMicro'),
    }
  }

  // ───────────────────────────────── 内部：状态流转 ─────────────────────────────────

  /**
   * 抢占：`enabled → redeeming`。过期判断也写进 WHERE，避免「先检查再抢占」之间
   * 跨过有效期边界。返回 false = 没抢到（并发输家、已停用、已用、已过期）。
   */
  private reserve(id: string, userId: number, now: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE redeem_codes SET status = 'redeeming', reserved_at = ?, reserved_by = ? " +
          "WHERE id = ? AND status = 'enabled' AND (expires_at IS NULL OR expires_at > ?)",
      )
      .run(now, String(userId), id, now)
    return readChanges(result.changes) === 1
  }

  /** 加余额失败的回退：`redeeming → enabled`。 */
  private release(id: string): void {
    this.db
      .prepare(
        "UPDATE redeem_codes SET status = 'enabled', reserved_at = NULL, reserved_by = NULL " +
          "WHERE id = ? AND status = 'redeeming'",
      )
      .run(id)
  }

  /** 收尾：`redeeming → used`。 */
  private markUsed(id: string, userId: number, now: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE redeem_codes SET status = 'used', reserved_at = NULL, redeemed_at = ?, redeemed_by = ? " +
          "WHERE id = ? AND status = 'redeeming'",
      )
      .run(now, String(userId), id)
    return readChanges(result.changes) === 1
  }

  /** 抢占失败后给出**具体**原因（重新读一次库）。 */
  private unavailable(id: string, now: string): RedeemError {
    const row = asRow<{ status: string; expires_at: string | null }>(
      this.db.prepare('SELECT status, expires_at FROM redeem_codes WHERE id = ?').get(id),
    )
    if (row === undefined) return new RedeemError('REDEEM_CODE_NOT_FOUND', '兑换码不存在或已失效')
    if (row.status === 'used') return new RedeemError('REDEEM_CODE_USED', '这个兑换码已经被使用过了')
    if (row.status === 'redeeming') {
      return new RedeemError('REDEEM_CODE_REDEEMING', '这个兑换码正在兑换中，请稍后再试或联系管理员')
    }
    if (row.status === 'disabled') {
      return new RedeemError('REDEEM_CODE_DISABLED', '这个兑换码已被停用')
    }
    if (row.expires_at !== null && row.expires_at <= now) {
      return new RedeemError('REDEEM_CODE_EXPIRED', '这个兑换码已过期')
    }
    return new RedeemError('REDEEM_CODE_CONFLICT', '兑换冲突，请稍后重试')
  }

  private throwUnchangeableStatus(id: string): never {
    const row = asRow<{ status: string }>(
      this.db.prepare('SELECT status FROM redeem_codes WHERE id = ?').get(id),
    )
    if (row === undefined) throw new RedeemError('REDEEM_NOT_FOUND', '兑换码不存在')
    if (row.status === 'used') {
      throw new RedeemError('REDEEM_CODE_USED', '这个兑换码已经使用过，不能改状态')
    }
    if (row.status === 'redeeming') {
      throw new RedeemError(
        'REDEEM_CODE_REDEEMING',
        '这个兑换码正在兑换中：请先用「标记为已用 / 退回可用」给出核查结论',
      )
    }
    throw new RedeemError('REDEEM_CODE_CONFLICT', '这个兑换码当前不处于可改状态')
  }

  // ───────────────────────────────── 内部：读 ─────────────────────────────────

  private findByHash(digest: string): RedeemCodeRow | undefined {
    const row = prepareRead(this.db, 'SELECT * FROM redeem_codes WHERE code_hash = ?').get(digest)
    return asRow<RedeemCodeRow>(row)
  }

  private requireBatchRow(id: string): RedeemBatchRow {
    const rows = prepareRead(this.db, `${batchSelect()} WHERE b.id = ?`).all(id) as unknown as RedeemBatchRow[]
    const row = rows[0]
    if (row === undefined) throw new RedeemError('REDEEM_NOT_FOUND', `批次不存在：${id}`)
    return row
  }

  private requireCodeView(id: string): RedeemCodeView {
    const rows = prepareRead(this.db, `${codeSelect()} WHERE c.id = ?`).all(id) as unknown as RedeemCodeRow[]
    const row = rows[0]
    if (row === undefined) throw new RedeemError('REDEEM_NOT_FOUND', '兑换码不存在')
    return toCodeView(row)
  }

  private batchNameOf(batchId: string): string {
    const row = this.db.prepare('SELECT name FROM redeem_batches WHERE id = ?').get(batchId)
    const name = row?.name
    if (typeof name !== 'string' || name === '') {
      throw new RedeemError('REDEEM_STORE_CORRUPT', '兑换码的批次记录缺失，请联系管理员')
    }
    return name
  }

  private async assertRedeemableUser(userId: number): Promise<void> {
    const user = await this.ctx.user.get(userId)
    if (user === undefined || user.status !== 'enabled') {
      throw new RedeemError('REDEEM_USER_FORBIDDEN', '当前账号不可用，无法兑换')
    }
  }

  private assertAdmin(actor: string): string {
    const name = normalizeActor(actor)
    if (!this.adminPlugins.includes(name)) {
      throw new RedeemError(
        'REDEEM_ACTOR_FORBIDDEN',
        `插件 ${name} 未被授权管理兑换码（当前授权：${this.adminPlugins.join(' / ') || '无'}）`,
      )
    }
    return name
  }

  private emit(event: RedeemChangedEvent): void {
    this.ctx.emit('redeem/changed', event)
  }

  private close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
  }
}

// ───────────────────────────────── 归一化 ─────────────────────────────────

function resolveDataPath(ctx: Context, path: string | undefined): string | undefined {
  // `:memory:` 是 SQLite 的特殊文件名，不能被当成相对路径解析（Windows 上还会因为冒号失败）。
  if (path === undefined || path === ':memory:' || isAbsolute(path)) return path
  const base = ctx.baseUrl ? fileURLToPath(ctx.baseUrl) : process.cwd()
  return resolve(base, path)
}

function normalizeUserId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RedeemError('REDEEM_INVALID_INPUT', '非法用户 ID')
  }
  return value
}

function normalizeActor(value: unknown): string {
  if (typeof value !== 'string') throw new RedeemError('REDEEM_INVALID_INPUT', 'actor 必须是字符串')
  const actor = value.trim()
  if (actor === '' || actor.length > MAX_ACTOR_LENGTH) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'actor 不合法')
  }
  return actor
}

function normalizeId(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new RedeemError('REDEEM_INVALID_INPUT', `${label} 必须是字符串`)
  const id = value.trim()
  if (id === '' || id.length > MAX_ID_LENGTH) {
    throw new RedeemError('REDEEM_INVALID_INPUT', `${label} 不合法`)
  }
  return id
}

function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RedeemError('REDEEM_INVALID_INPUT', 'ids 必须是数组')
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of value) {
    const id = normalizeId(item, '兑换码 id')
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  if (ids.length === 0) throw new RedeemError('REDEEM_INVALID_INPUT', '至少选择一个兑换码')
  if (ids.length > REDEEM_DELETE_MAX_BATCH) {
    throw new RedeemError('REDEEM_INVALID_INPUT', `一次最多删除 ${REDEEM_DELETE_MAX_BATCH} 个兑换码`)
  }
  return ids
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') throw new RedeemError('REDEEM_INVALID_INPUT', '批次名称必须是字符串')
  const name = value.trim()
  if (name === '') throw new RedeemError('REDEEM_INVALID_INPUT', '批次名称不能为空')
  if (name.length > REDEEM_BATCH_NAME_MAX_LENGTH) {
    throw new RedeemError(
      'REDEEM_INVALID_INPUT',
      `批次名称最长 ${REDEEM_BATCH_NAME_MAX_LENGTH} 个字符`,
    )
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new RedeemError('REDEEM_INVALID_INPUT', '批次名称不得包含控制字符')
  }
  return name
}

function normalizeNotes(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new RedeemError('REDEEM_INVALID_INPUT', '备注必须是字符串')
  const notes = value.trim()
  if (notes === '') return null
  if (notes.length > REDEEM_BATCH_NOTES_MAX_LENGTH) {
    throw new RedeemError(
      'REDEEM_INVALID_INPUT',
      `备注最长 ${REDEEM_BATCH_NOTES_MAX_LENGTH} 个字符`,
    )
  }
  if (notes.includes('\u0000')) throw new RedeemError('REDEEM_INVALID_INPUT', '备注不得包含空字符')
  return notes
}

/** 金额：只接受整数微元（bigint / 十进制字符串 / 安全整数），绝不经过浮点解析。 */
function normalizeAmount(value: unknown): bigint {
  let text: string
  if (typeof value === 'bigint') {
    text = value.toString()
  } else if (typeof value === 'number' && Number.isSafeInteger(value)) {
    text = String(value)
  } else if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    text = value.trim()
  } else {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'amountMicro 必须是正整数微元（1 元 = 1000000）')
  }
  const amount = BigInt(text)
  if (amount <= 0n) throw new RedeemError('REDEEM_INVALID_INPUT', 'amountMicro 必须大于 0')
  if (amount > REDEEM_AMOUNT_MAX_MICROS) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'amountMicro 超出可存储范围')
  }
  return amount
}

function normalizeCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'count 必须是整数')
  }
  if (value < REDEEM_BATCH_COUNT_MIN || value > REDEEM_BATCH_COUNT_MAX) {
    throw new RedeemError(
      'REDEEM_INVALID_INPUT',
      `count 必须在 ${REDEEM_BATCH_COUNT_MIN}..${REDEEM_BATCH_COUNT_MAX} 之间`,
    )
  }
  return value
}

function normalizeExpiresAt(value: unknown, nowIso: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'expiresAt 必须是 ISO 8601 时间字符串')
  }
  const parsed = Date.parse(value.trim())
  if (!Number.isFinite(parsed)) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'expiresAt 不是合法时间')
  }
  if (parsed <= Date.parse(nowIso)) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'expiresAt 必须晚于当前时间')
  }
  return new Date(parsed).toISOString()
}

function normalizeFilter(value: unknown): RedeemCodeFilter | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new RedeemError('REDEEM_INVALID_INPUT', 'status 必须是字符串')
  const status = value.trim()
  if (status === 'enabled' || status === 'redeeming' || status === 'used' || status === 'disabled' || status === 'expired') {
    return status
  }
  throw new RedeemError(
    'REDEEM_INVALID_INPUT',
    'status 只能是 enabled / redeeming / used / disabled / expired',
  )
}

function normalizeKeyword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new RedeemError('REDEEM_INVALID_INPUT', 'keyword 必须是字符串')
  const keyword = value.replace(/[\s-]+/g, '').toUpperCase()
  if (keyword === '') return undefined
  if (keyword.length > 32) throw new RedeemError('REDEEM_INVALID_INPUT', 'keyword 过长')
  return keyword
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'limit 必须是正整数')
  }
  return Math.min(value, max)
}

function normalizeOffset(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RedeemError('REDEEM_INVALID_INPUT', 'offset 必须是非负整数')
  }
  return value
}

function readAmount(value: unknown, where: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw new RedeemError('REDEEM_STORE_CORRUPT', `兑换码数据库损坏：${where} 不是整数`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
