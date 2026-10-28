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
 * 用户角色。首个完成注册的用户自动是 admin，之后由 admin 授予 / 撤销。
 * 角色是**用户属性**，与插件级的 `adminPlugins` 白名单是两回事：
 * 后者决定「哪个插件能调用管理面」，前者决定「哪个用户能用管理台」。
 */
export type UserRole = 'admin' | 'user'

export const USER_ROLES: readonly UserRole[] = ['admin', 'user']

/**
 * 余额是整数最小单位（AGENTS.md D10：禁止用浮点存余额）。
 * 1 元 = `BALANCE_MINOR_UNITS_PER_YUAN` 个最小单位。
 */
export type Balance = bigint

/**
 * 余额只读快照的一条：余额用十进制最小单位字符串。
 *
 * 桥帧是 JSON，承载不了 bigint；用十进制字符串既保精度，也天然不经过浮点
 * （AGENTS.md §2.4.3：金额一律整数最小单位）。
 */
export interface BalanceSnapshotEntry {
  readonly userId: string
  readonly balanceMicros: string
}

/** 全量余额只读快照。推送 / 撤销策略由消费方（额度闸门）决定。 */
export interface BalanceSnapshot {
  readonly entries: readonly BalanceSnapshotEntry[]
}

export const BALANCE_MINOR_UNITS_PER_YUAN = 1_000_000n

export const USER_STATUSES: readonly UserStatus[] = ['enabled', 'banned']

/** 用户名长度上限（按字符计，先 trim）。 */
export const USER_NAME_MAX_LENGTH = 64

export interface User {
  readonly id: UserId
  readonly name: string
  readonly status: UserStatus
  /** 管理角色；首个用户自动为 admin。 */
  readonly role: UserRole
  readonly balance: Balance
  /**
   * 是否对用户显示余额。默认关闭，由管理员按用户打开；
   * 余额数值本身仍只经由 adjustBalance 改动（D8 / D10）。
   */
  readonly balanceEnabled: boolean
  /** 头像：http(s) URL 或受限的 data:image/* base64；null 表示未设置。 */
  readonly avatar: string | null
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
  /** 可选角色过滤；不传表示不过滤。 */
  readonly role?: UserRole
  readonly offset?: number
  readonly limit?: number
}

/** `user/changed` 的动作。 */
export type UserChangedAction = 'created' | 'updated' | 'removed'

/** `user/changed` 里可出现的字段名（只表达「哪个属性变了」，不带值）。 */
export type UserChangedField =
  | 'name'
  | 'status'
  | 'role'
  | 'balanceEnabled'
  | 'avatar'
  | 'balance'

/**
 * 用户写入成功后的通知载荷。
 *
 * **只是通知，不承载正确性**：丢了最多让下游晚一次刷新，不能让任何流程依赖它。
 * 不含密码、邮箱、令牌或任何秘密；`fields` 只说改了哪几个属性。
 */
export interface UserChangedEvent {
  readonly userId: UserId
  readonly action: UserChangedAction
  readonly fields?: readonly UserChangedField[]
}

/** 自助资料更新：只有这两个字段允许用户自己改。 */
export interface UserProfilePatch {
  readonly name?: string
  /** null 表示清除头像；undefined 表示不改。 */
  readonly avatar?: string | null
}

/** 头像校验边界。 */
export const USER_AVATAR_URL_MAX_LENGTH = 2048
export const USER_AVATAR_DATA_MAX_BYTES = 256 * 1024
