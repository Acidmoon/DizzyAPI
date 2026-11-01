/**
 * 上游账号批量操作的纯逻辑单测。
 *
 * 这一段的两个真实风险：
 * 1. **`enabled` 混进 `patch`**：服务端 `bulkUpdate` 明确拒绝，但错在客户端就会让人
 *    以为「批量改名字」能顺手批量启用 —— 实际上是被 400 挡回来，看着像功能坏了；
 * 2. **失败被当成成功**：批量操作最容易「看起来成功」，所以归一化时**不认识的结果按失败算**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as logicModule from '../app/src/app/(main)/dashboard/_components/account-bulk-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const {
  MAX_BULK,
  bulkBodyOf,
  bulkFailureLines,
  bulkOutcomeOf,
  bulkOutcomeText,
  deleteOutcomeOf,
  isPageAllSelected,
  isPagePartiallySelected,
  toggleSelectAll,
  toggleSelected,
} = unwrap<typeof logicModule>(logicModule)

// ───────────────────────────── 选择 ─────────────────────────────

test('toggleSelected：加入 / 移出，顺序稳定', () => {
  assert.deepEqual(toggleSelected([], 'a'), ['a'])
  assert.deepEqual(toggleSelected(['a'], 'b'), ['a', 'b'])
  assert.deepEqual(toggleSelected(['a', 'b'], 'a'), ['b'])
})

test('toggleSelectAll：没全选就补满本页，已全选就只清本页', () => {
  assert.deepEqual(toggleSelectAll(['x'], ['a', 'b']), ['x', 'a', 'b'])
  assert.deepEqual(toggleSelectAll(['x', 'a', 'b'], ['a', 'b']), ['x'])
})

test('全选判定：空页不算全选；部分选中要能识别（全选框的 indetermine 态）', () => {
  assert.equal(isPageAllSelected([], []), false)
  assert.equal(isPageAllSelected(['a', 'b'], ['a', 'b']), true)
  assert.equal(isPagePartiallySelected(['a'], ['a', 'b']), true)
  assert.equal(isPagePartiallySelected(['a', 'b'], ['a', 'b']), false)
  assert.equal(isPagePartiallySelected([], ['a', 'b']), false)
})

// ───────────────────────────── 请求体 ─────────────────────────────

test('bulkBodyOf：去重、空集合与超上限都挡在客户端', () => {
  assert.deepEqual(bulkBodyOf('enable', ['a', 'a', 'b']), { action: 'enable', ids: ['a', 'b'] })
  assert.equal(bulkBodyOf('disable', []), 'empty')
  const tooMany = Array.from({ length: MAX_BULK + 1 }, (_, index) => `acc-${String(index)}`)
  assert.equal(bulkBodyOf('enable', tooMany), 'too-large')
})

test('bulkBodyOf：启停不带 patch（patch 里更不许出现 enabled）', () => {
  const body = bulkBodyOf('disable', ['a'])
  assert.notEqual(body, 'empty')
  if (body === 'empty' || body === 'too-large') return
  assert.equal(Object.hasOwn(body, 'patch'), false)
  assert.equal(JSON.stringify(body).includes('enabled'), false)
})

test('bulkBodyOf：update 时把 patch 原样带上（字段校验交给服务端）', () => {
  const body = bulkBodyOf('update', ['a'], { priority: 5 })
  assert.notEqual(body, 'empty')
  if (body === 'empty' || body === 'too-large') return
  assert.deepEqual(body, { action: 'update', ids: ['a'], patch: { priority: 5 } })
})

// ───────────────────────────── 结果归一化 ─────────────────────────────

test('bulkOutcomeOf：逐项统计成功 / 失败，失败带 code 与消息', () => {
  const outcome = bulkOutcomeOf({
    total: 3,
    succeeded: 1,
    failed: 2,
    items: [
      { id: 'a', ok: true, account: null, error: null },
      { id: 'b', ok: false, account: null, error: { code: 'ACCOUNT_NOT_FOUND', message: '账号不存在' } },
      { id: 'c', ok: false, account: null, error: null },
    ],
  })
  assert.equal(outcome.total, 3)
  assert.equal(outcome.succeeded, 1)
  assert.equal(outcome.failed, 2)
  assert.deepEqual(outcome.failures.map((item) => item.code), ['ACCOUNT_NOT_FOUND', 'ACCOUNT_BULK_FAILED'])
  assert.equal(outcome.failures[0]?.message, '账号不存在')
})

test('bulkOutcomeOf：不认识的形状按失败算（绝不假装成功）', () => {
  const outcome = bulkOutcomeOf({ items: [{ id: 'a' }, null, 'x'] })
  assert.equal(outcome.succeeded, 0)
  assert.equal(outcome.failed, 3)
  assert.equal(outcome.total, 3)
})

test('bulkOutcomeOf：空响应不炸，也不编造成功', () => {
  const outcome = bulkOutcomeOf(null)
  assert.deepEqual(outcome, { total: 0, succeeded: 0, failed: 0, failures: [] })
})

test('deleteOutcomeOf：逐条删除的结果汇总成同一口径', () => {
  const outcome = deleteOutcomeOf(
    [{ id: 'b', code: 'ACCOUNT_ADMIN_NOT_FOUND', message: '没有这个账号' }],
    3,
  )
  assert.equal(outcome.total, 3)
  assert.equal(outcome.succeeded, 2)
  assert.equal(outcome.failed, 1)
})

// ───────────────────────────── 提示文案 ─────────────────────────────

test('bulkOutcomeText：全成功 / 部分失败 / 空选三种说法都要区分开', () => {
  assert.equal(
    bulkOutcomeText({ total: 2, succeeded: 2, failed: 0, failures: [] }, '启用'),
    '已启用 2 个账号',
  )
  assert.equal(
    bulkOutcomeText(
      { total: 3, succeeded: 1, failed: 2, failures: [] },
      '删除',
    ),
    '已删除 1 个，失败 2 个',
  )
  assert.equal(bulkOutcomeText({ total: 0, succeeded: 0, failed: 0, failures: [] }, '停用'), '没有可停用的账号')
})

test('bulkFailureLines：最多列 5 条，带稳定 code', () => {
  const failures = Array.from({ length: 7 }, (_, index) => ({
    id: `acc-${String(index)}`,
    code: 'ACCOUNT_ADMIN_FAILED',
    message: '失败',
  }))
  const lines = bulkFailureLines({ total: 7, succeeded: 0, failed: 7, failures })
  assert.equal(lines.length, 5)
  assert.equal(lines[0], 'acc-0：失败（ACCOUNT_ADMIN_FAILED）')
})
