/**
 * 审计库的建表与打开。
 *
 * 一个数据一个写者：**只有本插件写 `audit.db`**，别的插件只经 `audit` 服务读
 * （AGENTS.md §2.4）。审计记录不是业务数据：业务写失败**不因为审计写失败而回滚**
 * （审计是旁路，不是前置依赖）。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describeError } from '@dizzyapi/plugin-kit'
import { AuditError } from './errors.ts'

export const AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  actor        TEXT    NOT NULL,
  actor_plugin TEXT    NOT NULL,
  action       TEXT    NOT NULL,
  target_type  TEXT    NOT NULL DEFAULT '',
  target_id    TEXT    NOT NULL DEFAULT '',
  summary      TEXT    NOT NULL,
  metadata     TEXT    NOT NULL DEFAULT '{}',
  result       TEXT    NOT NULL DEFAULT 'ok',
  error_code   TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_time   ON audit_log (at_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor  ON audit_log (actor, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log (action, id DESC);
CREATE INDEX IF NOT EXISTS audit_log_target ON audit_log (target_type, target_id, id DESC);
`

/** 打开审计库。`:memory:` / 空路径用于测试。 */
export function openAuditDatabase(path: string | undefined): DatabaseSync {
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
    db.exec(AUDIT_SCHEMA)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 打开失败的连接不需要再报错。
    }
    if (error instanceof AuditError) throw error
    throw new AuditError('AUDIT_STORE_CORRUPT', `审计数据库无法打开：${describeError(error)}`)
  }
}
