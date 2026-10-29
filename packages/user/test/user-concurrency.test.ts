/**
 * 用户并发上限的存储用例。
 *
 * 守两件事：
 *  1. **老库升级不炸**：升级前的 users 表没有 concurrency_limit，打开时必须幂等补列，
 *     历史用户一律「不限并发」；
 *  2. 余额快照（额度闸门的心跳帧）顺带带出用户级并发上限——两者必须同源，
 *     分两条快照会出现「余额新、并发旧」的分裂。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { UserDatabase } from '../src/db.ts'

const OLD_SCHEMA = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  balance INTEGER NOT NULL DEFAULT 0,
  balance_enabled INTEGER NOT NULL DEFAULT 0,
  avatar TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE balance_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
`

function withTempDir(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'dizzyapi-user-'))
  return { path: join(dir, 'users.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('老库升级：幂等补齐 concurrency_limit，历史用户不限并发', () => {
  const { path, cleanup } = withTempDir()
  try {
    const legacy = new DatabaseSync(path)
    legacy.exec(OLD_SCHEMA)
    legacy
      .prepare(
        'INSERT INTO users (name, status, role, balance, balance_enabled, avatar, created_at, updated_at) ' +
          "VALUES ('old', 'enabled', 'admin', 5000000, 0, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      )
      .run()
    legacy.close()

    const db = new UserDatabase(path)
    const user = db.getUser(1)
    assert.ok(user !== undefined)
    assert.equal(user.concurrencyLimit, null, '历史用户不能因为升级被限流')
    assert.equal(user.balance, 5_000_000n, '余额原样保留')
    db.close()

    // 再打开一次：幂等。
    const again = new UserDatabase(path)
    again.close()
  } finally {
    cleanup()
  }
})

test('并发上限写入后出现在余额快照里（与余额同源）', () => {
  const { path, cleanup } = withTempDir()
  try {
    const db = new UserDatabase(path)
    const user = db.insertUser({
      name: 'limited',
      status: 'enabled',
      role: 'user',
      balanceEnabled: false,
      avatar: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    db.setConcurrencyLimit(user.id, 3, '2026-01-02T00:00:00.000Z')
    assert.equal(db.getUser(user.id)?.concurrencyLimit, 3)

    const entries = db.listBalances()
    assert.deepEqual(entries, [{ userId: String(user.id), balance: 0n, concurrencyLimit: 3 }])

    // null = 不限（清掉上限）。
    db.setConcurrencyLimit(user.id, null, '2026-01-03T00:00:00.000Z')
    assert.equal(db.getUser(user.id)?.concurrencyLimit, null)
    db.close()
  } finally {
    cleanup()
  }
})
