/**
 * 护栏：**首屏请求不许带 keyset 游标**。
 *
 * 来源是一个真 bug（2026-10-31，`界面` 用真浏览器量出来的）：管理台「用量明细」页
 * `usage-board.tsx` 用 `useState(0)` 起步、无条件把 `cursor` 发出去，而服务端
 * `packages/api/src/routes/admin_usage.ts` 的 `parseIntegerParam(cursorText, 'cursor', 0, 1, MAX)`
 * **下界是 1**（游标是「上一页最后一条 id」，0 不是合法 id）。后果：这一页**第一次打开永远是
 * 400 错误态**，用户以为页面坏了，得先点一次翻页才出数据。
 *
 * 为什么必须写成护栏：类型层两条都对（`cursor?: number` 可选、`0` 是合法 number），
 * `pnpm typecheck` 与 `next build` 全绿，只有真跑一次 HTTP 才看得见。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const BOARD = join(
  REPO_ROOT,
  'packages/dashboard/app/src/app/(main)/dashboard/_components/usage-board.tsx',
)
const SERVER_ROUTE = join(REPO_ROOT, 'packages/api/src/routes/admin_usage.ts')

test('用量明细首屏不传 cursor（服务端下界是 1，传 0 必 400）', () => {
  const source = readFileSync(BOARD, 'utf8')
  assert.ok(
    /cursor > 0 \? \{ cursor \}/.test(source),
    'usage-board.tsx 必须只在 cursor > 0 时才带上游标 —— 首屏发 cursor=0 会被服务端 400 拒绝',
  )
  assert.ok(
    !/fetchAdminUsage\(\s*api,\s*\{[^}]*\bcursor,/s.test(source),
    'usage-board.tsx 里出现无条件展开 cursor 的写法（`{ ...filters(), cursor, ... }`），首屏会 400',
  )
})

test('服务端 cursor 的合法下界仍然是 1（护栏要跟着服务端走）', () => {
  const source = readFileSync(SERVER_ROUTE, 'utf8')
  assert.ok(
    /parseIntegerParam\(\s*cursorText,\s*'cursor',\s*0,\s*1,/.test(source),
    "admin_usage.ts 的 cursor 解析应形如 parseIntegerParam(cursorText, 'cursor', 0, 1, MAX)；" +
      '如果服务端放宽了下界，可以同步放宽上面那条护栏，但**不要**在未确认的情况下去掉它',
  )
})
