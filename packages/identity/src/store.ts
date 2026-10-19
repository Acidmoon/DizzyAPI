import {
  jsonFileStore,
  memoryStore,
  type JsonCodec,
  type JsonStore,
} from '@dizzyapi/plugin-kit'
import { IdentityError } from './errors.ts'
import type { IdentityAccount } from './types.ts'

export const SNAPSHOT_VERSION = 1

export interface IdentitySnapshot {
  readonly version: number
  readonly accounts: Readonly<Record<string, IdentityAccount>>
}

export function emptySnapshot(): IdentitySnapshot {
  return { version: SNAPSHOT_VERSION, accounts: {} }
}

const PROVIDERS = new Set(['claude', 'openai', 'custom'])
const KINDS = new Set(['oauth', 'api_key'])
const STATUSES = new Set(['active', 'needs_reauth'])

function corrupt(detail: string): never {
  throw new IdentityError('IDENTITY_STORE_CORRUPT', `账号存储损坏：${detail}`)
}

function asObject(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${where} 必须是对象`)
  return value as Record<string, unknown>
}

function readStringField(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string' || value === '') corrupt(`${where}.${key} 必须是非空字符串`)
  return value
}

function readNullableString(source: Record<string, unknown>, key: string, where: string): string | null {
  const value = source[key]
  if (value === null) return null
  if (typeof value !== 'string') corrupt(`${where}.${key} 必须是字符串或 null`)
  return value
}

/** 新字段必须兼容旧快照：缺失按 `null` / `0` 处理，不因为一次升级就拒绝整份文件。 */
function readOptionalNullableString(source: Record<string, unknown>, key: string, where: string): string | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') corrupt(`${where}.${key} 必须是字符串或 null`)
  return value
}

function readOptionalInteger(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (value === undefined || value === null) return 0
  if (typeof value !== 'number' || !Number.isInteger(value)) corrupt(`${where}.${key} 必须是整数`)
  return value
}

function decodeAccount(raw: unknown, key: string): IdentityAccount {
  const where = `accounts.${key}`
  const source = asObject(raw, where)

  if (source.id !== key) corrupt(`${where}.id 与键名不一致`)
  if (typeof source.provider !== 'string' || !PROVIDERS.has(source.provider)) corrupt(`${where}.provider 不合法`)
  if (typeof source.kind !== 'string' || !KINDS.has(source.kind)) corrupt(`${where}.kind 不合法`)
  if (typeof source.status !== 'string' || !STATUSES.has(source.status)) corrupt(`${where}.status 不合法`)
  if (typeof source.enabled !== 'boolean') corrupt(`${where}.enabled 必须是布尔值`)
  if (typeof source.failureCount !== 'number' || !Number.isInteger(source.failureCount) || source.failureCount < 0) {
    corrupt(`${where}.failureCount 必须是非负整数`)
  }

  return {
    id: key,
    provider: source.provider as IdentityAccount['provider'],
    kind: source.kind as IdentityAccount['kind'],
    label: readStringField(source, 'label', where),
    enabled: source.enabled,
    status: source.status as IdentityAccount['status'],
    credentialRef: readStringField(source, 'credentialRef', where),
    email: readNullableString(source, 'email', where),
    subject: readNullableString(source, 'subject', where),
    baseUrl: readOptionalNullableString(source, 'baseUrl', where),
    priority: readOptionalInteger(source, 'priority', where),
    accessExpiresAt: readNullableString(source, 'accessExpiresAt', where),
    refreshDueAt: readNullableString(source, 'refreshDueAt', where),
    lastRefreshAt: readNullableString(source, 'lastRefreshAt', where),
    lastError: readNullableString(source, 'lastError', where),
    failureCount: source.failureCount,
    backoffUntil: readNullableString(source, 'backoffUntil', where),
    createdAt: readStringField(source, 'createdAt', where),
    updatedAt: readStringField(source, 'updatedAt', where),
  }
}

export const identityCodec: JsonCodec<IdentitySnapshot> = {
  encode(value) {
    return { version: SNAPSHOT_VERSION, accounts: value.accounts }
  },

  decode(raw) {
    const source = asObject(raw, '快照')
    if (source.version !== SNAPSHOT_VERSION) {
      corrupt(`版本不受支持：${String(source.version)}（本插件只认 ${SNAPSHOT_VERSION}）`)
    }
    const accounts = asObject(source.accounts, 'accounts')
    const result: Record<string, IdentityAccount> = {}
    for (const [key, value] of Object.entries(accounts)) {
      result[key] = decodeAccount(value, key)
    }
    return { version: SNAPSHOT_VERSION, accounts: result }
  },
}

export function createIdentityStore(path: string | undefined): JsonStore<IdentitySnapshot> {
  return path === undefined
    ? memoryStore(emptySnapshot)
    : jsonFileStore(path, identityCodec, emptySnapshot)
}
