import { jsonFileStore, memoryStore, type JsonCodec, type JsonStore } from '@dizzyapi/plugin-kit'
import { AuthError } from './errors.ts'
import type { AuthSnapshot, Credential, PendingCode, PendingPurpose, RateCounter, Session } from './model.ts'

export const SNAPSHOT_VERSION = 1

interface WireSnapshot {
  version: number
  credentials: unknown[]
  pendings: unknown[]
  sessions: unknown[]
  counters: unknown[]
}

export function emptySnapshot(): AuthSnapshot {
  return { credentials: [], pendings: [], sessions: [], counters: [] }
}

/**
 * 快照编解码。
 *
 * 解码是严格的：字段缺失、类型不对、枚举不认识都直接抛错，
 * 绝不「尽力恢复」——凭证数据错一半比读不出来更危险。
 */
export const snapshotCodec: JsonCodec<AuthSnapshot> = {
  encode(value) {
    const wire: WireSnapshot = {
      version: SNAPSHOT_VERSION,
      credentials: value.credentials.map((item) => ({ ...item })),
      pendings: value.pendings.map((item) => ({ ...item })),
      sessions: value.sessions.map((item) => ({ ...item })),
      counters: value.counters.map((item) => ({ ...item })),
    }
    return wire
  },

  decode(raw) {
    const wire = requireObject(raw, '根对象')
    if (wire.version !== SNAPSHOT_VERSION) {
      throw corrupt(`版本不受支持：${String(wire.version)}（本插件只认 ${SNAPSHOT_VERSION}）`)
    }

    return {
      credentials: requireArray(wire.credentials, 'credentials').map(decodeCredential),
      pendings: requireArray(wire.pendings, 'pendings').map(decodePending),
      sessions: requireArray(wire.sessions, 'sessions').map(decodeSession),
      counters: requireArray(wire.counters, 'counters').map(decodeCounter),
    }
  },
}

export function createAuthStore(dataPath: string | undefined): JsonStore<AuthSnapshot> {
  if (dataPath === undefined) return memoryStore(emptySnapshot)
  return jsonFileStore(dataPath, snapshotCodec, emptySnapshot)
}

function decodeCredential(value: unknown, index: number): Credential {
  const where = `credentials[${index}]`
  const raw = requireObject(value, where)
  return {
    userId: requirePositiveInt(raw, 'userId', where),
    email: requireNonEmptyString(raw, 'email', where),
    passwordHash: requireNonEmptyString(raw, 'passwordHash', where),
    createdAt: requireNonEmptyString(raw, 'createdAt', where),
    updatedAt: requireNonEmptyString(raw, 'updatedAt', where),
  }
}

function decodePending(value: unknown, index: number): PendingCode {
  const where = `pendings[${index}]`
  const raw = requireObject(value, where)
  const purpose = requireNonEmptyString(raw, 'purpose', where)
  if (purpose !== 'register' && purpose !== 'reset') {
    throw corrupt(`${where}.purpose 只认 register / reset，收到 ${purpose}`)
  }
  const name = raw.name === undefined ? undefined : requireNonEmptyString(raw, 'name', where)
  const passwordHash =
    raw.passwordHash === undefined ? undefined : requireNonEmptyString(raw, 'passwordHash', where)
  return {
    purpose: purpose as PendingPurpose,
    email: requireNonEmptyString(raw, 'email', where),
    codeHash: requireNonEmptyString(raw, 'codeHash', where),
    salt: requireNonEmptyString(raw, 'salt', where),
    attempts: requireNonNegativeInt(raw, 'attempts', where),
    createdAt: requireNonEmptyString(raw, 'createdAt', where),
    expiresAt: requireNonEmptyString(raw, 'expiresAt', where),
    name,
    passwordHash,
  }
}

function decodeSession(value: unknown, index: number): Session {
  const where = `sessions[${index}]`
  const raw = requireObject(value, where)
  return {
    id: requireNonEmptyString(raw, 'id', where),
    userId: requirePositiveInt(raw, 'userId', where),
    tokenHash: requireNonEmptyString(raw, 'tokenHash', where),
    createdAt: requireNonEmptyString(raw, 'createdAt', where),
    expiresAt: requireNonEmptyString(raw, 'expiresAt', where),
    lastSeenAt: requireNonEmptyString(raw, 'lastSeenAt', where),
  }
}

function decodeCounter(value: unknown, index: number): RateCounter {
  const where = `counters[${index}]`
  const raw = requireObject(value, where)
  return {
    key: requireNonEmptyString(raw, 'key', where),
    count: requireNonNegativeInt(raw, 'count', where),
    windowStart: requireNonEmptyString(raw, 'windowStart', where),
    windowMs: requirePositiveInt(raw, 'windowMs', where),
  }
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw corrupt(`${where} 不是对象`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw corrupt(`${where} 不是数组`)
  return value
}

function requireNonEmptyString(raw: Record<string, unknown>, key: string, where: string): string {
  const value = raw[key]
  if (typeof value !== 'string' || value === '') throw corrupt(`${where}.${key} 必须是非空字符串`)
  return value
}

function requirePositiveInt(raw: Record<string, unknown>, key: string, where: string): number {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw corrupt(`${where}.${key} 必须是正整数`)
  }
  return value
}

function requireNonNegativeInt(raw: Record<string, unknown>, key: string, where: string): number {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw corrupt(`${where}.${key} 必须是非负整数`)
  }
  return value
}

function corrupt(detail: string): AuthError {
  return new AuthError('AUTH_STORE_CORRUPT', `鉴权数据文件损坏：${detail}`)
}
