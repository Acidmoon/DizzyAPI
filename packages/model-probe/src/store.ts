/**
 * 探测库的读写。**只有本文件碰 SQL**；`service.ts` 只编排、不算 SQL。
 *
 * 全同步（`node:sqlite` 的 `DatabaseSync`）：写入是一条 INSERT + 一条 UPSERT，
 * 读是小柱状图的几十行，都在微秒级；没必要为它引入异步队列。
 */
import type { DatabaseSync } from 'node:sqlite'
import { dayOf } from './db.ts'
import { ModelProbeError } from './errors.ts'
import type {
  ModelProbeDailyRollup,
  ModelProbeSample,
  ModelProbeSampleRow,
  ModelProbeStatus,
} from './types.ts'

/** 状态枚举的合法值集合：读库时用它挡脏数据（旧库 / 手改过的行）。 */
const STATUSES = new Set<string>(['ok', 'degraded', 'failed', 'probe-error'])

export class ModelProbeStore {
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
  }

  /** 写一条明细，并在**同一个事务**里累加当天的日汇总。 */
  record(sample: ModelProbeSample): ModelProbeSampleRow {
    if (!STATUSES.has(sample.status)) {
      throw new ModelProbeError(
        'MODEL_PROBE_QUERY_INVALID',
        `未知的探测状态：${sample.status}`,
      )
    }
    const day = dayOf(sample.testedAtMs)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const inserted = this.db
        .prepare(
          'INSERT INTO model_probe_samples (model, status, latency_ms, http_status, error_code, tested_at_ms) ' +
            'VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          sample.model,
          sample.status,
          sample.latencyMs,
          sample.httpStatus,
          sample.errorCode,
          sample.testedAtMs,
        )
      this.db
        .prepare(
          'INSERT INTO model_probe_daily (' +
            'model, day, total_checks, ok_count, degraded_count, failed_count, probe_error_count, ' +
            'sum_latency_ms, count_latency' +
            ') VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?) ' +
            'ON CONFLICT(model, day) DO UPDATE SET ' +
            'total_checks = total_checks + 1, ' +
            'ok_count = ok_count + excluded.ok_count, ' +
            'degraded_count = degraded_count + excluded.degraded_count, ' +
            'failed_count = failed_count + excluded.failed_count, ' +
            'probe_error_count = probe_error_count + excluded.probe_error_count, ' +
            'sum_latency_ms = sum_latency_ms + excluded.sum_latency_ms, ' +
            'count_latency = count_latency + excluded.count_latency',
        )
        .run(
          sample.model,
          day,
          sample.status === 'ok' ? 1 : 0,
          sample.status === 'degraded' ? 1 : 0,
          sample.status === 'failed' ? 1 : 0,
          sample.status === 'probe-error' ? 1 : 0,
          // probe-error 的耗时不计入平均：它不是模型的耗时，混进去会把均值算歪。
          sample.status === 'probe-error' ? 0 : Math.max(0, Math.round(sample.latencyMs)),
          sample.status === 'probe-error' ? 0 : 1,
        )
      this.db.exec('COMMIT')
      return { ...sample, id: Number(inserted.lastInsertRowid) }
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务已经不在活动状态，忽略。
      }
      if (error instanceof ModelProbeError) throw error
      throw new ModelProbeError(
        'MODEL_PROBE_STORE_CORRUPT',
        `写入探测记录失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 某模型最近的 N 条（最新在前）。 */
  recent(model: string, limit: number): ModelProbeSampleRow[] {
    const rows = this.db
      .prepare(
        'SELECT id, model, status, latency_ms, http_status, error_code, tested_at_ms ' +
          'FROM model_probe_samples WHERE model = ? ORDER BY tested_at_ms DESC, id DESC LIMIT ?',
      )
      .all(model, limit)
    return rows.map(toRow)
  }

  /** 全部探过的模型名（最新一次探测在前）。 */
  probedModels(): string[] {
    const rows = this.db
      .prepare('SELECT model, MAX(tested_at_ms) AS last FROM model_probe_samples GROUP BY model ORDER BY last DESC')
      .all()
    return rows.map((row) => String(row.model))
  }

  /** 某模型的日汇总（按天倒序）。 */
  daily(model: string, days: number): ModelProbeDailyRollup[] {
    const rows = this.db
      .prepare(
        'SELECT model, day, total_checks, ok_count, degraded_count, failed_count, ' +
          'probe_error_count, sum_latency_ms, count_latency FROM model_probe_daily ' +
          'WHERE model = ? ORDER BY day DESC LIMIT ?',
      )
      .all(model, days)
    return rows.map((row) => ({
      model: String(row.model),
      day: String(row.day),
      totalChecks: Number(row.total_checks),
      okCount: Number(row.ok_count),
      degradedCount: Number(row.degraded_count),
      failedCount: Number(row.failed_count),
      probeErrorCount: Number(row.probe_error_count),
      sumLatencyMs: Number(row.sum_latency_ms),
      countLatency: Number(row.count_latency),
    }))
  }

  /** 明细总条数（`status()` 用，只增不减到清理为止）。 */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM model_probe_samples').get()
    return Number(row?.n ?? 0)
  }

  /** 删掉早于 `beforeMs` 的明细；返回删了几条。日汇总不动（它本来就是长期趋势）。 */
  prune(beforeMs: number): number {
    const result = this.db
      .prepare('DELETE FROM model_probe_samples WHERE tested_at_ms < ?')
      .run(beforeMs)
    return Number(result.changes ?? 0)
  }

  /** 读本插件自己的小状态（探测 key 的 id / 名字）。**不存秘密。** */
  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM model_probe_meta WHERE key = ?').get(key)
    return row === undefined ? undefined : String(row.value)
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO model_probe_meta (key, value) VALUES (?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value)
  }

  close(): void {
    this.db.close()
  }
}

function toRow(raw: Record<string, unknown>): ModelProbeSampleRow {
  const status = String(raw.status ?? '')
  return {
    id: Number(raw.id),
    model: String(raw.model ?? ''),
    // 脏数据兜底成 failed 而不是 ok：不能把「读不出来」当成「是好的」。
    status: (STATUSES.has(status) ? status : 'failed') as ModelProbeStatus,
    latencyMs: Number(raw.latency_ms ?? 0),
    httpStatus: raw.http_status === null || raw.http_status === undefined ? null : Number(raw.http_status),
    errorCode: raw.error_code === null || raw.error_code === undefined ? null : String(raw.error_code),
    testedAtMs: Number(raw.tested_at_ms ?? 0),
  }
}
