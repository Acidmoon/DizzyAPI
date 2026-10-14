import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { UserError } from './errors.ts'
import type { BalanceEntry, User, UserId } from './model.ts'

/**
 * 存储适配器的边界：一个快照进，一个快照出。
 *
 * 之所以把存储做成可替换的适配器，而不是直接在服务里写文件：
 * 按 AGENTS.md D8，账户与额度的唯一写者最终是 Go。本插件现在自己落盘，
 * 只是「Go 与桥尚未存在」这一段时期的临时安排；等桥就绪，换一个
 * bridgeStore 即可，UserService 的对外接口一字不改。
 */
export interface UserSnapshot {
  readonly nextId: UserId
  readonly users: readonly User[]
  readonly entries: readonly BalanceEntry[]
}

export interface UserStore {
  /** 供日志与排障：人类可读的存储描述。 */
  readonly describe: string
  load(): Promise<UserSnapshot>
  save(snapshot: UserSnapshot): Promise<void>
  close(): Promise<void>
}

export function emptySnapshot(): UserSnapshot {
  return { nextId: 1, users: [], entries: [] }
}

/** 内存存储：进程退出即丢，用于测试与「不需要持久化」的场合。 */
export function memoryStore(): UserStore {
  let current: UserSnapshot = emptySnapshot()
  return {
    describe: 'memory（进程退出即丢）',
    async load() {
      return { nextId: current.nextId, users: [...current.users], entries: [...current.entries] }
    },
    async save(next) {
      current = { nextId: next.nextId, users: [...next.users], entries: [...next.entries] }
    },
    async close() {
      // 内存存储没有待落盘的东西
    },
  }
}

interface WireUser {
  id: number
  name: string
  status: string
  balance: string
  createdAt: string
  updatedAt: string
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

const WIRE_VERSION = 1

/**
 * JSON 文件存储。
 *
 * 写是原子的：先写同目录的 `<path>.tmp`，再 rename 覆盖目标。
 * 同一个目录内的 rename 是原子的，所以进程被杀不会留下半截文件。
 *
 * balance 以十进制字符串编码：JSON 没有 bigint，用 number 会丢精度（D10）。
 */
export function jsonFileStore(path: string): UserStore {
  return {
    describe: `json（${path}）`,

    async load() {
      let text: string
      try {
        text = await readFile(path, 'utf8')
      } catch (error) {
        if (isNotFound(error)) return emptySnapshot()
        throw new UserError(
          'USER_STORE_UNREADABLE',
          `读取用户数据文件失败：${path}（${describeError(error)}）`,
        )
      }
      return decodeSnapshot(text, path)
    },

    async save(snapshot) {
      const payload = `${JSON.stringify(encodeSnapshot(snapshot), null, 2)}\n`
      const temp = `${path}.tmp`
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temp, payload, 'utf8')
      await rename(temp, path)
    },

    async close() {
      // 每次改动都已落盘，这里没有需要 flush 的状态
    },
  }
}

function encodeSnapshot(snapshot: UserSnapshot): WireSnapshot {
  return {
    version: WIRE_VERSION,
    nextId: snapshot.nextId,
    users: snapshot.users.map((user) => ({
      id: user.id,
      name: user.name,
      status: user.status,
      balance: user.balance.toString(),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })),
    entries: snapshot.entries.map((entry) => ({
      userId: entry.userId,
      delta: entry.delta.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      reason: entry.reason,
      actor: entry.actor,
      at: entry.at,
    })),
  }
}

function decodeSnapshot(text: string, path: string): UserSnapshot {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw corrupt(path, `不是合法 JSON（${describeError(error)}）`)
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corrupt(path, '顶层不是一个对象')
  }

  const wire = parsed as Record<string, unknown>
  if (wire.version !== WIRE_VERSION) {
    throw corrupt(path, `版本不受支持：${String(wire.version)}（本插件只认 ${WIRE_VERSION}）`)
  }
  if (!isPositiveInteger(wire.nextId)) throw corrupt(path, 'nextId 必须是正整数')
  if (!Array.isArray(wire.users)) throw corrupt(path, 'users 必须是数组')
  if (!Array.isArray(wire.entries)) throw corrupt(path, 'entries 必须是数组')

  const users = wire.users.map((item, index) => decodeUser(item, path, index))
  const entries = wire.entries.map((item, index) => decodeEntry(item, path, index))

  return { nextId: wire.nextId, users, entries }
}

function decodeUser(value: unknown, path: string, index: number): User {
  const where = `users[${index}]`
  if (value === null || typeof value !== 'object') throw corrupt(path, `${where} 不是对象`)
  const raw = value as Record<string, unknown>

  if (!isPositiveInteger(raw.id)) throw corrupt(path, `${where}.id 必须是正整数`)
  if (typeof raw.name !== 'string') throw corrupt(path, `${where}.name 必须是字符串`)
  if (raw.status !== 'enabled' && raw.status !== 'banned') {
    throw corrupt(path, `${where}.status 必须是 enabled 或 banned`)
  }
  if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
    throw corrupt(path, `${where} 的时间戳必须是字符串`)
  }

  return {
    id: raw.id,
    name: raw.name,
    status: raw.status,
    balance: decodeBalance(raw.balance, path, `${where}.balance`),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  }
}

function decodeEntry(value: unknown, path: string, index: number): BalanceEntry {
  const where = `entries[${index}]`
  if (value === null || typeof value !== 'object') throw corrupt(path, `${where} 不是对象`)
  const raw = value as Record<string, unknown>

  if (!isPositiveInteger(raw.userId)) throw corrupt(path, `${where}.userId 必须是正整数`)
  if (typeof raw.reason !== 'string') throw corrupt(path, `${where}.reason 必须是字符串`)
  if (typeof raw.actor !== 'string') throw corrupt(path, `${where}.actor 必须是字符串`)
  if (typeof raw.at !== 'string') throw corrupt(path, `${where}.at 必须是字符串`)

  return {
    userId: raw.userId,
    delta: decodeBalance(raw.delta, path, `${where}.delta`),
    balanceAfter: decodeBalance(raw.balanceAfter, path, `${where}.balanceAfter`),
    reason: raw.reason,
    actor: raw.actor,
    at: raw.at,
  }
}

function decodeBalance(value: unknown, path: string, where: string): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) {
    throw corrupt(path, `${where} 必须是以十进制字符串编码的整数`)
  }
  return BigInt(value)
}

function corrupt(path: string, detail: string): UserError {
  return new UserError('USER_STORE_CORRUPT', `用户数据文件损坏：${path}——${detail}`)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
