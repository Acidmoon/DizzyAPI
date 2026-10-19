/**
 * API key 插件的领域模型与跨进程快照形状。
 *
 * owner 2026-10-20 决定：用户自己的列表可以返回完整 key，便于随时复制；
 * 管理面 listAll 仍只给掩码，快照、日志与桥消息只带哈希。
 */

export type ApiKeyAction = 'created' | 'updated' | 'rotated' | 'removed'

/** 用户面看到的 key 记录。secret 可为 null（旧库历史行）。 */
export interface ApiKeyView {
  readonly id: string
  readonly userId: number
  readonly name: string
  readonly trackingId: string
  /** 完整 key；旧库迁移后历史行为 null，轮换后写入。 */
  readonly secret: string | null
  /** 形如 `sk-dz-<trackingId>_…<secret 最后 4 位>`。 */
  readonly maskedKey: string
  readonly enabled: boolean
  readonly appManaged: boolean
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastUsedAt: string | null
  readonly rotatedAt: string | null
}

/** verify 的命中结果。它是 key-auth 在 TS 侧的最小身份视图。 */
export interface ApiKeyVerified {
  readonly keyId: string
  readonly userId: number
  readonly name: string
  readonly profile: string
}

/**
 * 推给 Go 的只读快照。它只含哈希，不含明文、掩码或任何可还原 secret 的字段。
 * 形状与 Go 的 `internal/apikeys.Snapshot` 一一对应。
 */
export interface ApiKeySnapshot {
  readonly version: 1
  readonly generation: number
  readonly keys: readonly ApiKeySnapshotKey[]
}

export interface ApiKeySnapshotKey {
  readonly keyId: string
  readonly userId: number
  readonly keyHash: string
  readonly profile: string
  readonly name: string
}

/** `status()` 的运行期计数，没有任何秘密。 */
export interface ApiKeyStatus {
  readonly keys: number
  readonly users: number
  readonly generation: number
  readonly updatedAt: string | null
}

/** `api-key/changed` 的载荷：不含 secret / hash。 */
export interface ApiKeyChangedEvent {
  readonly userId: number
  readonly keyId: string
  readonly action: ApiKeyAction
}

/**
 * 当前唯一的 profile 标签。key-auth 把它写进 `Ctx.Profile`；
 * 描述符与多 profile 编排仍是目标（AGENTS.md §6）。
 */
export const API_KEY_PROFILE = 'billed'

/** key 前缀：`sk-dz-`。 */
export const API_KEY_PREFIX = 'sk-dz-'

/** trackingId 长度（Crockford base32）。 */
export const API_KEY_TRACKING_LENGTH = 12

/** secret 长度：32 字节随机数的无填充 base64url。 */
export const API_KEY_SECRET_LENGTH = 43

/** 名称长度上限（按字符计，先 trim）。 */
export const API_KEY_NAME_MAX_LENGTH = 64

/** 每用户 key 上限的默认值。 */
export const API_KEY_MAX_KEYS_PER_USER_DEFAULT = 100

/** 每用户 key 上限的允许区间。 */
export const API_KEY_MAX_KEYS_PER_USER_MIN = 1
export const API_KEY_MAX_KEYS_PER_USER_MAX = 10_000
