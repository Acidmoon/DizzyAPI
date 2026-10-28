/**
 * 兑换码的领域形状与常量。
 *
 * 设计前提（owner 已拍板）：
 * 1. 兑换码是**独立业务实体**（批次 / 额度 / 有效期 / 状态 / 使用记录），
 *    不是 credentials 的引用名，也不是 API key 那种「随时可复制明文」的东西；
 * 2. 码本身是秘密但很长：只落 sha256 哈希 + 掩码，明文只在生成响应里出现一次；
 * 3. 额度只有 `balance` 一维；`kind` 字段为将来的多维额度留位，当前只认 'balance'；
 * 4. 金额一律整数微元（bigint，1 元 = 1_000_000 微元），禁止浮点。
 */

/** 对外：兑换成功的结果。 */
export interface RedeemResult {
  /** 本次到账额度（微元）。 */
  readonly amount: bigint
  /** 加完之后该用户的余额（微元），来自 user 服务的返回值。 */
  readonly balance: bigint
  readonly batchName: string
}

/** 兑换码状态机：enabled →（CAS）→ redeeming → used，或 enabled ↔ disabled。 */
export type RedeemCodeStatus = 'enabled' | 'redeeming' | 'used' | 'disabled'

/** 列表筛选用的状态：多一个派生状态 `expired`（enabled 且已过期）。 */
export type RedeemCodeFilter = RedeemCodeStatus | 'expired'

/** 额度维度。当前只有余额一维，schema 预留字段默认 'balance'。 */
export type RedeemKind = 'balance'

export interface RedeemBatchView {
  readonly id: string
  readonly name: string
  readonly kind: RedeemKind
  /** 单码额度（微元）。 */
  readonly amountMicro: bigint
  /** 本批计划生成数量。 */
  readonly total: number
  readonly notes: string | null
  readonly createdBy: string
  readonly createdAt: string
  /** NULL = 永不过期。 */
  readonly expiresAt: string | null
  /** 本批实际码数量（应与 total 一致；查库统计，不是推断）。 */
  readonly codeCount: number
  readonly usedCount: number
}

/** 列表里的码视图：**没有明文，也没有哈希**，只有掩码。 */
export interface RedeemCodeView {
  readonly id: string
  readonly batchId: string
  readonly batchName: string | null
  /** 例如 `****A3F7`。 */
  readonly codeMask: string
  readonly kind: RedeemKind
  readonly amountMicro: bigint
  readonly status: RedeemCodeStatus
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly reservedAt: string | null
  readonly reservedBy: string | null
  readonly redeemedAt: string | null
  readonly redeemedBy: string | null
  readonly disabledBy: string | null
  readonly disabledAt: string | null
}

/** 用户面「我的兑换记录」。 */
export interface RedemptionView {
  readonly codeId: string
  readonly codeMask: string
  readonly amountMicro: bigint
  readonly batchName: string | null
  readonly redeemedAt: string | null
}

export interface RedeemBatchQuery {
  readonly limit?: number
  readonly offset?: number
}

export interface RedeemCodeQuery {
  readonly batchId?: string
  readonly status?: RedeemCodeFilter
  /** 匹配掩码（掩码后 4 位即可）；大小写不敏感。 */
  readonly keyword?: string
  readonly limit?: number
  readonly offset?: number
}

export interface RedeemCodePage {
  readonly items: readonly RedeemCodeView[]
  readonly total: number
}

export interface RedeemStats {
  readonly batches: number
  readonly codes: number
  readonly enabled: number
  readonly disabled: number
  readonly redeeming: number
  readonly used: number
  /** 派生统计：enabled 且已过期。 */
  readonly expired: number
  /** 已兑总额（微元），只统计 status = used。 */
  readonly redeemedAmountMicro: bigint
}

/** 批量删除里被拒的条目：id + 稳定错误码。 */
export interface RedeemDeletionRejection {
  readonly id: string
  readonly reason: 'REDEEM_CODE_USED' | 'REDEEM_CODE_REDEEMING' | 'REDEEM_CODE_NOT_FOUND'
}

export interface RedeemDeletionResult {
  readonly deleted: number
  readonly rejected: readonly RedeemDeletionRejection[]
}

/** 人工核查「兑换中」的两种结论。 */
export type RedeemResolveOutcome = 'used' | 'enabled'

export interface RedeemChangedEvent {
  readonly action: 'batch-created' | 'code-redeemed' | 'code-updated'
  readonly batchId: string | null
  readonly count: number
}

/** 兑换码字符集：Crockford base32 去掉 I / L / O / U，避免 0/O、1/I 的书写歧义。 */
export const REDEEM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 24 个字符 × 5 bit = 120 位熵，展示时每 4 位一组。 */
export const REDEEM_CODE_LENGTH = 24
export const REDEEM_CODE_GROUP = 4

export const REDEEM_BATCH_NAME_MAX_LENGTH = 20
export const REDEEM_BATCH_NOTES_MAX_LENGTH = 200
export const REDEEM_BATCH_COUNT_MIN = 1
export const REDEEM_BATCH_COUNT_MAX = 100
export const REDEEM_DELETE_MAX_BATCH = 200
export const REDEEM_LIST_DEFAULT_LIMIT = 50
export const REDEEM_LIST_MAX_LIMIT = 200
export const REDEEM_MY_LIST_DEFAULT_LIMIT = 20
export const REDEEM_MY_LIST_MAX_LIMIT = 100

/** SQLite INTEGER 是 64 位有符号整数：单码额度不能超出它。 */
export const REDEEM_AMOUNT_MAX_MICROS = 9_223_372_036_854_775_807n

/** 生成码时对哈希碰撞的重试上限（120 位熵下几乎不可能用满）。 */
export const REDEEM_HASH_ATTEMPTS = 8

/** 写余额时自报的插件名；必须出现在 user 的 balanceWriters 白名单里。 */
export const REDEEM_ACTOR = '@dizzyapi/plugin-redeem'
