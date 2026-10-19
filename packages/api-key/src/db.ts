/**
 * API key 的 SQLite 存储层（Node 24 内置 `node:sqlite`，零第三方依赖）。
 *
 * owner 2026-10-20 决定：完整 key 落库，用户可以在控制台随时复制。
 * 这是**有意放宽**了早先「只存哈希」的约束；Go 的 key-auth 仍然只接收哈希快照，
 * 列表 / 创建 / 轮换之外的路径（事件、日志、桥消息）都不带明文。
 *
 * 写入用 `BEGIN IMMEDIATE`：多进程（或将来多个插件实例）写同一个文件时，
 * 「检查配额 → 检查重名 → 插入」必须在同一个写事务里完成。
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApiKeyError } from './errors.ts'
import {
  API_KEY_PREFIX,
  API_KEY_SECRET_LENGTH,
  API_KEY_TRACKING_LENGTH,
  type ApiKeyView,
} from './types.ts'

/** Crockford base32：没有 I / L / O / U，避免 0/O、1/I 的书写歧义。 */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** 完整 key 的形状：`sk-dz-<12 位 Crockford>_<43 位 base64url>`。 */
const KEY_PATTERN = new RegExp(
  `^${escapeRegExp(API_KEY_PREFIX)}[0-9A-HJKMNP-TV-Z]{${API_KEY_TRACKING_LENGTH}}_[A-Za-z0-9_-]{${API_KEY_SECRET_LENGTH}}$`,
)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  tracking_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE,
  /** 完整 key；旧库迁移后历史行为 NULL，轮换后写入。 */
  secret TEXT,
  masked_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  app_managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  rotated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_name ON api_keys(user_id, name);
CREATE TABLE IF NOT EXISTS api_key_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO api_key_meta(key, value) VALUES ('generation', '0');
`

const REQUIRED_COLUMNS = [
  'id',
  'user_id',
  'name',
  'tracking_id',
  'secret_hash',
  'secret',
  'masked_key',
  'enabled',
  'app_managed',
  'created_at',
  'updated_at',
  'last_used_at',
  'rotated_at',
] as const

/** SQLite 原始行。列名与表定义一致。 */
export interface ApiKeyRow {
  readonly id: string
  readonly user_id: number
  readonly name: string
  readonly tracking_id: string
  readonly secret_hash: string
  readonly secret: string | null
  readonly masked_key: string
  readonly enabled: number
  readonly app_managed: number
  readonly created_at: string
  readonly updated_at: string
  readonly last_used_at: string | null
  readonly rotated_at: string | null
}

/** 打开数据库并做一次严格的完整性与表结构检查。 */
export function openApiKeyDatabase(path: string | undefined): DatabaseSync {
  const location = path === undefined || path.trim() === '' ? ':memory:' : path
  if (location !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true })
  }

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(location, { enableForeignKeyConstraints: true, timeout: 5_000 })
    // WAL 让读写并发更好；`:memory:` 会返回 memory，SQLite 自己会忽略。
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    ensureSecretColumn(db)
    verifySchema(db)
    verifyIntegrity(db)
    readGeneration(db)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 打开失败的连接不需要再报错。
    }
    if (error instanceof ApiKeyError) throw error
    throw new ApiKeyError(
      'API_KEY_STORE_CORRUPT',
      `API key 数据库损坏或无法打开：${describeError(error)}`,
    )
  }
}

/** 在一个立即写事务里执行同步函数。任何异常都回滚。 */
export function immediateTransaction<T>(db: DatabaseSync, task: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = task()
    db.exec('COMMIT')
    return value
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误。
    }
    throw error
  }
}

/** 读取快照 generation。损坏的值必须报错，不能静默当成 0。 */
export function readGeneration(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM api_key_meta WHERE key = 'generation'").get()
  const raw = row?.value
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw corrupt('generation 元数据缺失或不合法')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw corrupt('generation 元数据超出安全整数范围')
  }
  return value
}

/** 每次写操作在同一事务里递增 generation，Go 据此知道快照变新了。 */
export function bumpGeneration(db: DatabaseSync): number {
  const next = readGeneration(db) + 1
  if (!Number.isSafeInteger(next)) {
    throw corrupt('generation 已超出安全整数范围')
  }
  db.prepare("UPDATE api_key_meta SET value = ? WHERE key = 'generation'").run(String(next))
  return next
}

/** 生成 12 位 Crockford base32 trackingId。 */
export function generateTrackingId(): string {
  const bytes = randomBytes(API_KEY_TRACKING_LENGTH)
  let out = ''
  for (let index = 0; index < API_KEY_TRACKING_LENGTH; index += 1) {
    // 256 % 32 === 0，取模不会引入偏差。
    out += CROCKFORD_ALPHABET[bytes[index]! % CROCKFORD_ALPHABET.length]
  }
  return out
}

/** 生成 32 字节随机数的无填充 base64url（43 字符）。 */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function formatFullKey(trackingId: string, secret: string): string {
  return `${API_KEY_PREFIX}${trackingId}_${secret}`
}

export function maskKey(trackingId: string, secret: string): string {
  return `${API_KEY_PREFIX}${trackingId}_…${secret.slice(-4)}`
}

export function hashApiKey(fullKey: string): string {
  return createHash('sha256').update(fullKey, 'utf8').digest('hex')
}

/** 只接受完整 key 的形状；解析失败与校验失败对外不区分。 */
export function parseApiKey(
  value: unknown,
): { readonly trackingId: string; readonly secret: string } | undefined {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) return undefined
  const body = value.slice(API_KEY_PREFIX.length)
  const separator = body.indexOf('_')
  if (separator !== API_KEY_TRACKING_LENGTH) return undefined
  return { trackingId: body.slice(0, separator), secret: body.slice(separator + 1) }
}

/**
 * 两个 sha256 hex 的常量时间比较。
 *
 * 不存在的 trackingId 会与一串 0 比较，避免「是否存在」在比较耗时上出现明显差异。
 */
export function constantTimeHexEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function newKeyId(): string {
  return randomUUID()
}

export function toView(row: ApiKeyRow): ApiKeyView {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    trackingId: row.tracking_id,
    secret: row.secret,
    maskedKey: row.masked_key,
    enabled: row.enabled === 1,
    appManaged: row.app_managed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
    rotatedAt: row.rotated_at,
  }
}

export function asRow(value: Record<string, unknown> | undefined): ApiKeyRow | undefined {
  return value as ApiKeyRow | undefined
}

/** 旧库升级：只加列，不改历史行。历史 key 的 secret 保持 NULL。 */
function ensureSecretColumn(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(api_keys)').all()
  const names = new Set(
    columns
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string'),
  )
  if (!names.has('secret')) {
    db.exec('ALTER TABLE api_keys ADD COLUMN secret TEXT')
  }
}

function verifySchema(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(api_keys)').all()
  const names = new Set(
    columns
      .map((column) => column.name)
      .filter((name): name is string => typeof name === 'string'),
  )
  const missing = REQUIRED_COLUMNS.filter((column) => !names.has(column))
  if (missing.length > 0) {
    throw corrupt(`api_keys 表缺少列：${missing.join(', ')}`)
  }
}

function verifyIntegrity(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA integrity_check').all()
  if (rows.length !== 1) throw corrupt('integrity_check 返回值数量异常')
  const value = Object.values(rows[0] ?? {})[0]
  if (value !== 'ok') {
    throw corrupt(`integrity_check 未通过：${String(value)}`)
  }
}

function corrupt(detail: string): ApiKeyError {
  return new ApiKeyError('API_KEY_STORE_CORRUPT', `API key 数据库损坏：${detail}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
