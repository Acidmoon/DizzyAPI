/**
 * 用户插件的领域模型。
 *
 * 本插件是「用户表单」的唯一写者：用户名、用户 ID、状态、余额只经由
 * UserService 改动，其他插件一律通过接口读取（见 AGENTS.md D8）。
 */

/** 用户 ID 由注册顺序确定：从 1 开始，单调递增，删除后也不复用。 */
export type UserId = number

/** 用户状态只有两种：启用与封禁。删除用户是独立的操作，不表达为状态。 */
export type UserStatus = 'enabled' | 'banned'

/**
 * 余额是整数最小单位（AGENTS.md D10：禁止用浮点存余额）。
 * 1 元 = `BALANCE_MINOR_UNITS_PER_YUAN` 个最小单位。
 */
export type Balance = bigint

export const BALANCE_MINOR_UNITS_PER_YUAN = 1_000_000n

export const USER_STATUSES: readonly UserStatus[] = ['enabled', 'banned']

/** 用户名长度上限（按字符计，先 trim）。 */
export const USER_NAME_MAX_LENGTH = 64

export interface User {
  readonly id: UserId
  readonly name: string
  readonly status: UserStatus
  readonly balance: Balance
  /** 首次注册时间，ISO 8601。 */
  readonly createdAt: string
  /** 最近一次改动时间，ISO 8601。 */
  readonly updatedAt: string
}

/**
 * 余额变更流水。只增不改：每一笔余额变化都在这里留下一条记录，
 * 记录改了多少、改后是多少、谁改的、为什么改。
 *
 * 注意：这只是**进程内的审计附本**。真正的账本（流水 / 额度）在 Go 侧
 * （AGENTS.md D8），本插件接管账本之前，这里就是唯一留下痕迹的地方。
 */
export interface BalanceEntry {
  readonly userId: UserId
  /** 本次变更的增量，可为负（后付费扣费允许把余额扣成负数，见 D11）。 */
  readonly delta: Balance
  /** 变更后的余额。 */
  readonly balanceAfter: Balance
  /** 变更原因，必填且不得为空。 */
  readonly reason: string
  /** 发起变更的插件名。 */
  readonly actor: string
  readonly at: string
}

export interface UserQuery {
  readonly status?: UserStatus
  readonly offset?: number
  readonly limit?: number
}
