/**
 * 用量库的建表与打开。
 *
 * 一个数据一个写者：**只有本插件写 `usage.db`**，别的插件/进程只读（或者干脆只经
 * usage 服务读）。Go 不碰这个文件——它把记录经控制桥送上来（AGENTS.md §2.1 / §4.2）。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describeError } from '@dizzyapi/plugin-kit'
import { UsageError } from './errors.ts'

export const USAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_records (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id              TEXT    NOT NULL,
  epoch               TEXT    NOT NULL DEFAULT '',
  seq                 INTEGER NOT NULL DEFAULT 0,
  started_at_ms       INTEGER NOT NULL,
  day                 TEXT    NOT NULL,
  user_id             INTEGER NOT NULL DEFAULT 0,
  api_key_id          TEXT    NOT NULL DEFAULT '',
  api_key_name        TEXT    NOT NULL DEFAULT '',
  profile             TEXT    NOT NULL DEFAULT '',
  account_id          TEXT    NOT NULL DEFAULT '',
  model               TEXT    NOT NULL,
  upstream_model      TEXT,
  protocol            TEXT    NOT NULL DEFAULT '',
  upstream_protocol   TEXT,
  stream              INTEGER NOT NULL DEFAULT 0,
  status              INTEGER NOT NULL DEFAULT 0,
  error_code          TEXT,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  total_tokens        INTEGER NOT NULL DEFAULT 0,
  usage_present       INTEGER NOT NULL DEFAULT 0,
  usage_complete      INTEGER NOT NULL DEFAULT 1,
  duration_ms         INTEGER NOT NULL DEFAULT 0,
  -- 首字延迟（毫秒）。**可空**：只有流式请求才有值；非流式请求与升级前的历史记录
  -- 都是 NULL，页面必须显示「—」而不是 0。绝不能拿默认值 0 冒充「0 毫秒」。
  ttft_ms             INTEGER DEFAULT NULL,
  client_ip           TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  ingested_at_ms      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS usage_records_req  ON usage_records (req_id);
CREATE INDEX        IF NOT EXISTS usage_records_user ON usage_records (user_id, id DESC);
CREATE INDEX        IF NOT EXISTS usage_records_key  ON usage_records (api_key_id, id DESC);
CREATE INDEX        IF NOT EXISTS usage_records_time ON usage_records (started_at_ms DESC);
CREATE INDEX        IF NOT EXISTS usage_records_day  ON usage_records (day);

CREATE TABLE IF NOT EXISTS usage_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 落库失败的坏记录隔离区（有界出口，防止一条坏记录永久卡住游标与结算）。
-- 仍然只有本插件写这张表；状态是稳定英文字符串：pending / ignored / replayed。
CREATE TABLE IF NOT EXISTS usage_rejected (
  req_id             TEXT PRIMARY KEY,
  epoch              TEXT    NOT NULL DEFAULT '',
  seq                INTEGER NOT NULL DEFAULT 0,
  payload            TEXT    NOT NULL,
  error              TEXT    NOT NULL,
  failures           INTEGER NOT NULL DEFAULT 0,
  status             TEXT    NOT NULL DEFAULT 'pending',
  first_failed_at_ms INTEGER NOT NULL,
  updated_at_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_rejected_status ON usage_rejected (status, updated_at_ms DESC);
`

/** 打开用量库。`:memory:` / 空路径用于测试。 */
export function openUsageDatabase(path: string | undefined): DatabaseSync {
  const location = path === undefined || path.trim() === '' ? ':memory:' : path
  if (location !== ':memory:') {
    mkdirSync(dirname(location), { recursive: true })
  }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(location, { timeout: 5_000 })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(USAGE_SCHEMA)
    migrate(db)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 打开失败的连接不需要再报错。
    }
    if (error instanceof UsageError) throw error
    throw new UsageError('USAGE_STORE_CORRUPT', `用量数据库无法打开：${describeError(error)}`)
  }
}

/**
 * 幂等补列（旧库升级不能因为缺列就拒绝启动，AGENTS.md §5.2）。
 *
 * `CREATE TABLE IF NOT EXISTS` 只对新库生效：老库已经存在同名表时它一个字段都不加，
 * 所以 v1 之后新增的列必须在这里逐列 ALTER。`ttft_ms` 是**可空列**，补列后历史行
 * 天然是 NULL —— 这正是我们要的「历史记录没有首字延迟」。
 */
function migrate(db: DatabaseSync): void {
  ensureColumn(db, 'usage_records', 'ttft_ms', 'INTEGER DEFAULT NULL')
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all()
  for (const row of rows) {
    if (row.name === column) return
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
}
