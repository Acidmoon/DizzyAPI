/**
 * API key 三个执行面上限（过期 / 金额上限 / 并发上限）的存储用例。
 *
 * 重点守两件事：
 *  1. **老库升级不炸**：升级前的 API key 库没有这三列，打开时必须幂等补列，
 *     历史 key 一律「不过期 / 不限金额 / 不限并发」（不能被升级变成不可用）；
 *  2. 金额一律十进制微元字符串进出：JSON number 会丢 >2^53 的精度，所以写侧只收字符串。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openApiKeyDatabase, toView, asRow } from '../src/db.ts'

const OLD_SCHEMA = `
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  tracking_id TEXT NOT NULL UNIQUE,
  secret_hash TEXT NOT NULL UNIQUE,
  secret TEXT,
  masked_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  app_managed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  rotated_at TEXT
);
CREATE TABLE api_key_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO api_key_meta(key, value) VALUES ('generation', '0');
`

function withTempDir(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dizzyapi-apikey-'))
  return {
    path: join(dir, 'api-keys.db'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('老库升级：幂等补齐三个执行面上限列，历史 key 仍然可用', () => {
  const { path, cleanup } = withTempDir()
  try {
    // 升级前的库：没有 expires_at / spending_limit / concurrency_limit 三列。
    const legacy = new DatabaseSync(path)
    legacy.exec(OLD_SCHEMA)
    legacy
      .prepare(
        'INSERT INTO api_keys (id, user_id, name, tracking_id, secret_hash, secret, masked_key, ' +
          'enabled, app_managed, created_at, updated_at, last_used_at, rotated_at) ' +
          "VALUES ('k-old', 1, 'old key', 'ABCDEFGHJKMN', ?, NULL, 'sk-dz-…abcd', 1, 0, " +
          "'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL)",
      )
      .run('0'.repeat(64))
    legacy.close()

    // 打开一次：补列 + 校验通过。
    const db = openApiKeyDatabase(path)
    const row = asRow(db.prepare('SELECT * FROM api_keys WHERE id = ?').get('k-old'))
    assert.ok(row !== undefined)
    const view = toView(row)
    assert.equal(view.expiresAt, null, '历史 key 不能因为升级变成已过期')
    assert.equal(view.spendingLimitMicros, null, '历史 key 不限金额')
    assert.equal(view.concurrencyLimit, null, '历史 key 不限并发')

    // 再打开一次：幂等（列已存在就跳过，重复启动不报错）。
    db.close()
    const again = openApiKeyDatabase(path)
    again.close()
  } finally {
    cleanup()
  }
})

test('三个上限读写往返：金额读回来是十进制微元字符串（不经浮点）', () => {
  const { path, cleanup } = withTempDir()
  try {
    const db = openApiKeyDatabase(path)
    db.prepare(
      'INSERT INTO api_keys (id, user_id, name, tracking_id, secret_hash, secret, masked_key, ' +
        'enabled, app_managed, created_at, updated_at, last_used_at, rotated_at, ' +
        'expires_at, spending_limit, concurrency_limit) ' +
        "VALUES ('k-new', 2, 'new key', 'ABCDEFGHJKMN', ?, NULL, 'sk-dz-…wxyz', 1, 0, " +
        "'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL, " +
        "?, ?, ?)",
    ).run('1'.repeat(64), '2027-01-01T00:00:00.000Z', 9_007_199_254_740_991n, 8)

    const view = toView(asRow(db.prepare('SELECT * FROM api_keys WHERE id = ?').get('k-new'))!)
    assert.equal(view.expiresAt, '2027-01-01T00:00:00.000Z')
    // 2^53-1（安全整数上界）必须精确往返：用 number 走一遍就会丢精度。
    assert.equal(view.spendingLimitMicros, '9007199254740991')
    assert.equal(view.concurrencyLimit, 8)
    db.close()
  } finally {
    cleanup()
  }
})
