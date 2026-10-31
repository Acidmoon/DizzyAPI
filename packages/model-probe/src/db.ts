/**
 * 探测库的建表与打开。
 *
 * 一个数据一个写者：**只有本插件写 `model-probe.db`**。`modelhub` 与 API 层只经
 * `modelProbe` 服务读，不直连这个文件（AGENTS.md §2.4 第 2 条）。
 *
 * 三张表，职责互不重叠：
 * - `model_probe_samples`：每次探测一条**明细**（小柱状图与「现在怎么样」都读它）；
 * - `model_probe_daily`：按 (model, day) 的**日汇总**，明细超期被删后仍能算长期可用率；
 * - `model_probe_meta`：本插件自己的小状态（探测 key 的 id / 名字），不存任何秘密。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describeError } from '@dizzyapi/plugin-kit'
import { ModelProbeError } from './errors.ts'

export const MODEL_PROBE_SCHEMA = `
CREATE TABLE IF NOT EXISTS model_probe_samples (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  model         TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  http_status   INTEGER,
  -- 稳定原因码（INSUFFICIENT_BALANCE / timeout …）。**绝不存上游响应正文。**
  error_code    TEXT,
  tested_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS model_probe_samples_model ON model_probe_samples (model, tested_at_ms DESC);
CREATE INDEX IF NOT EXISTS model_probe_samples_time  ON model_probe_samples (tested_at_ms DESC);

CREATE TABLE IF NOT EXISTS model_probe_daily (
  model             TEXT    NOT NULL,
  day               TEXT    NOT NULL,
  total_checks      INTEGER NOT NULL DEFAULT 0,
  ok_count          INTEGER NOT NULL DEFAULT 0,
  degraded_count    INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  probe_error_count INTEGER NOT NULL DEFAULT 0,
  sum_latency_ms    INTEGER NOT NULL DEFAULT 0,
  count_latency     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, day)
);
CREATE INDEX IF NOT EXISTS model_probe_daily_day ON model_probe_daily (day);

CREATE TABLE IF NOT EXISTS model_probe_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

/** 探测库。`:memory:` / 空路径用于测试。 */
export function openModelProbeDatabase(path: string | undefined): DatabaseSync {
  const location = path === undefined || path.trim() === '' ? ':memory:' : path
  if (location !== ':memory:') mkdirSync(dirname(location), { recursive: true })
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(location, { timeout: 5_000 })
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(MODEL_PROBE_SCHEMA)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // 打开失败的连接不需要再报错。
    }
    if (error instanceof ModelProbeError) throw error
    throw new ModelProbeError(
      'MODEL_PROBE_STORE_CORRUPT',
      `探测数据库无法打开：${describeError(error)}`,
    )
  }
}

/** UTC 的 `YYYY-MM-DD`：日汇总的桶键。用 UTC 是为了不受本机时区漂移影响。 */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}
