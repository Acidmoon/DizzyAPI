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
const STATUSES = new Set(['active', 'needs_reauth', 'auto_disabled'])
/** 与 Go 侧 `contracts.HealthState` 对齐；未知（空 / 缺失）按 `unknown` 处理。 */
const HEALTHS = new Set(['unknown', 'healthy', 'degraded', 'unhealthy'])
/** 权重上限：与 `service.ts` 的 `normalizeWeight` 和 Go 的 `accounts.MaxWeight` 同口径。 */
const WEIGHT_MAX = 1_000_000

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

function readOptionalNullableBoolean(
  source: Record<string, unknown>,
  key: string,
  where: string,
): boolean | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'boolean') corrupt(`${where}.${key} 必须是布尔值或 null`)
  return value
}

function readOptionalNullableInteger(
  source: Record<string, unknown>,
  key: string,
  where: string,
): number | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isInteger(value)) corrupt(`${where}.${key} 必须是整数或 null`)
  return value
}

/**
 * 缺失按 `null`；权重是**有限正数**（允许小数，与 `service.ts` 的 `normalizeWeight`、
 * Go 侧 `Weight *float64` 同口径）。形状不对明确失败：`weight: "abc"` / `0` / 负数 /
 * 超过上限都不能静默当成「未声明」，否则重启后调度输入会被悄悄改掉。
 */
function readOptionalNullableWeight(
  source: Record<string, unknown>,
  key: string,
  where: string,
): number | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > WEIGHT_MAX
  ) {
    corrupt(`${where}.${key} 必须是 (0, ${WEIGHT_MAX}] 的有限数值或 null`)
  }
  return value
}

/** 缺失按 `null`；形状不对（非数组 / 含非字符串）明确失败，不静默降级。 */
function readOptionalStringArray(source: Record<string, unknown>, key: string, where: string): string[] | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) corrupt(`${where}.${key} 必须是字符串数组或 null`)
  for (const item of value) {
    if (typeof item !== 'string') corrupt(`${where}.${key} 的元素必须是字符串`)
  }
  return value as string[]
}

/** 缺失按 `null`；形状不对（非对象 / 含非字符串值）明确失败，不静默降级。 */
function readOptionalStringMap(
  source: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, string> | null {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) corrupt(`${where}.${key} 必须是字符串映射或 null`)
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue !== 'string') corrupt(`${where}.${key}.${entryKey} 必须是字符串`)
  }
  return value as Record<string, string>
}

/**
 * 标签数组：缺失（旧快照）按空数组处理，形状不对明确失败。
 * 存储层不解释 label 的语义（`key:value` 约定属于 account-priority 的标签映射）。
 */
function readOptionalLabels(source: Record<string, unknown>, where: string): string[] {
  return readOptionalStringArray(source, 'labels', where) ?? []
}

/** 健康状态：缺失（旧快照）按 `unknown`；非法值明确失败，不静默当成健康。 */
function readOptionalHealth(source: Record<string, unknown>, where: string): string {
  const value = source.health
  if (value === undefined || value === null) return 'unknown'
  if (typeof value !== 'string' || !HEALTHS.has(value)) {
    corrupt(`${where}.health 只能是 unknown / healthy / degraded / unhealthy`)
  }
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
    protocol: readOptionalNullableString(source, 'protocol', where) as IdentityAccount['protocol'],
    models: readOptionalStringArray(source, 'models', where),
    modelMap: readOptionalStringMap(source, 'modelMap', where),
    // 旧账号文件没有这个键 → `null`（不伪装）。缺字段不等于坏数据。
    clientProfile: readOptionalNullableString(source, 'clientProfile', where),
    priority: readOptionalInteger(source, 'priority', where),
    labels: readOptionalLabels(source, where),
    weight: readOptionalNullableWeight(source, 'weight', where),
    concurrency: readOptionalNullableInteger(source, 'concurrency', where),
    health: readOptionalHealth(source, where) as IdentityAccount['health'],
    autoDisabledAt: readOptionalNullableString(source, 'autoDisabledAt', where),
    autoDisabledReason: readOptionalNullableString(source, 'autoDisabledReason', where),
    lastUsedAt: readOptionalNullableString(source, 'lastUsedAt', where),
    accessExpiresAt: readNullableString(source, 'accessExpiresAt', where),
    refreshDueAt: readNullableString(source, 'refreshDueAt', where),
    lastRefreshAt: readNullableString(source, 'lastRefreshAt', where),
    lastError: readNullableString(source, 'lastError', where),
    failureCount: source.failureCount,
    backoffUntil: readNullableString(source, 'backoffUntil', where),
    lastTestAt: readOptionalNullableString(source, 'lastTestAt', where),
    lastTestOk: readOptionalNullableBoolean(source, 'lastTestOk', where),
    lastTestError: readOptionalNullableString(source, 'lastTestError', where),
    lastTestLatencyMs: readOptionalNullableInteger(source, 'lastTestLatencyMs', where),
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
