import { jsonFileStore, memoryStore, type JsonCodec, type JsonStore } from '@dizzyapi/plugin-kit'
import { UserError } from './errors.ts'
import type { BalanceEntry, User, UserId } from './model.ts'

/**
 * 旧 JSON 快照的编解码（**迁移专用**）。
 *
 * 运行时存储已经换成 SQLite（见 db.ts）。这个文件保留下来只做两件事：
 * 1. 首次建库时严格解码同目录的旧 `users.json`；
 * 2. 保留 `createUserStore` / `snapshotCodec` 这些导出，避免已有消费者在升级瞬间断掉。
 *
 * UserService 不再读写这里；新数据一律走 SQLite。
 */
export interface UserSnapshot {
  readonly nextId: UserId
  readonly users: readonly User[]
  readonly entries: readonly BalanceEntry[]
}

export const SNAPSHOT_VERSION = 1

export function emptySnapshot(): UserSnapshot {
  return { nextId: 1, users: [], entries: [] }
}

interface WireUser {
  id: number
  name: string
  status: string
  balance: string
  createdAt: string
  updatedAt: string
  /** 旧版快照（version 1 早期）没有这三个字段，解码时按默认值补齐。 */
  role?: string
  balance_enabled?: boolean
  avatar?: string | null
}

interface WireEntry {
  userId: number
  delta: string
  balanceAfter: string
  reason: string
  actor: string
  at: string
}

interface WireSnapshot {
  version: number
  nextId: number
  users: WireUser[]
  entries: WireEntry[]
}

/**
 * 快照编解码：balance 是 bigint，而 JSON 没有这种类型，用 number 会丢精度（D10），
 * 所以按十进制字符串走。
 *
 * 解码是严格的：字段缺失、类型不对、版本不认识都直接抛错，绝不「尽力恢复」——
 * 余额数据错一半比读不出来更危险。
 */
export const snapshotCodec: JsonCodec<UserSnapshot> = {
  encode(value) {
    const wire: WireSnapshot = {
      version: SNAPSHOT_VERSION,
      nextId: value.nextId,
      users: value.users.map((user) => ({
        id: user.id,
        name: user.name,
        status: user.status,
        role: user.role,
        balance: user.balance.toString(),
        balance_enabled: user.balanceEnabled,
        avatar: user.avatar,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      })),
      entries: value.entries.map((entry) => ({
        userId: entry.userId,
        delta: entry.delta.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        reason: entry.reason,
        actor: entry.actor,
        at: entry.at,
      })),
    }
    return wire
  },

  decode(raw) {
    const wire = requireObject(raw, '根对象')
    if (wire.version !== SNAPSHOT_VERSION) {
      throw corrupt(`版本不受支持：${String(wire.version)}（本插件只认 ${SNAPSHOT_VERSION}）`)
    }
    if (!isPositiveInteger(wire.nextId)) throw corrupt('nextId 必须是正整数')

    return {
      nextId: wire.nextId,
      users: requireArray(wire.users, 'users').map(decodeUser),
      entries: requireArray(wire.entries, 'entries').map(decodeEntry),
    }
  },
}

/** 省略路径即纯内存，进程退出即丢。 */
export function createUserStore(dataPath: string | undefined): JsonStore<UserSnapshot> {
  if (dataPath === undefined) return memoryStore(emptySnapshot)

  const inner = jsonFileStore(dataPath, snapshotCodec, emptySnapshot)
  return {
    ...inner,
    /**
     * kit 的 jsonFileStore 先把文件解析成 JSON 再交给 codec，所以「文件根本不是 JSON」
     * 会在到达 codec 之前抛 SyntaxError。那属于文件损坏，不是「读不出来」，
     * 这里折回 USER_STORE_CORRUPT，与其他损坏情形一致。
     */
    async read() {
      try {
        return await inner.read()
      } catch (error) {
        if (error instanceof SyntaxError) throw corrupt(`不是合法 JSON（${error.message}）`)
        throw error
      }
    },
  }
}

function decodeUser(value: unknown, index: number): User {
  const where = `users[${index}]`
  const raw = requireObject(value, where)

  if (!isPositiveInteger(raw.id)) throw corrupt(`${where}.id 必须是正整数`)
  if (typeof raw.name !== 'string') throw corrupt(`${where}.name 必须是字符串`)
  if (raw.status !== 'enabled' && raw.status !== 'banned') {
    throw corrupt(`${where}.status 必须是 enabled 或 banned`)
  }
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    throw corrupt(`${where} 的时间戳必须是字符串`)
  }
  if (raw.role !== undefined && raw.role !== 'admin' && raw.role !== 'user') {
    throw corrupt(`${where}.role 必须是 admin 或 user`)
  }
  if (raw.balance_enabled !== undefined && typeof raw.balance_enabled !== 'boolean') {
    throw corrupt(`${where}.balance_enabled 必须是布尔值`)
  }
  if (raw.avatar !== undefined && raw.avatar !== null && typeof raw.avatar !== 'string') {
    throw corrupt(`${where}.avatar 必须是字符串或 null`)
  }

  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    role: raw.role ?? 'user',
    balance: decodeBalance(raw.balance, `${where}.balance`),
    balanceEnabled: raw.balance_enabled ?? false,
    avatar: raw.avatar ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

function decodeEntry(value: unknown, index: number): BalanceEntry {
  const where = `entries[${index}]`
  const raw = requireObject(value, where)

  if (!isPositiveInteger(raw.userId)) throw corrupt(`${where}.userId 必须是正整数`)
  if (typeof raw.reason !== 'string') throw corrupt(`${where}.reason 必须是字符串`)
  if (typeof raw.actor !== 'string') throw corrupt(`${where}.actor 必须是字符串`)
  if (typeof raw.at !== 'string') throw corrupt(`${where}.at 必须是字符串`)

  return {
    userId: raw.userId,
    delta: decodeBalance(raw.delta, `${where}.delta`),
    balanceAfter: decodeBalance(raw.balanceAfter, `${where}.balanceAfter`),
    reason: raw.reason,
    actor: raw.actor,
    at: raw.at,
  }
}

function decodeBalance(value: unknown, where: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw corrupt(`${where} 必须是以十进制字符串编码的整数`)
  }
  return BigInt(value)
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw corrupt(`${where} 不是对象`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw corrupt(`${where} 必须是数组`)
  return value
}

function corrupt(detail: string): UserError {
  return new UserError('USER_STORE_CORRUPT', `用户数据文件损坏：${detail}`)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
