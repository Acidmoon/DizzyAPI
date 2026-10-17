import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeConfig } from '../src/merge.ts'
import { revisionOf, stableStringify } from '../src/revision.ts'

test('对象逐键递归：改 smtp.host 不会把 smtp 里别的东西弄丢', () => {
  const merged = mergeConfig(
    { transport: 'smtp', smtp: { host: 'old.example.com', port: 465, user: 'robot' } },
    { smtp: { host: 'new.example.com' } },
  )
  assert.deepEqual(merged, {
    transport: 'smtp',
    smtp: { host: 'new.example.com', port: 465, user: 'robot' },
  })
})

test('null 表示删除这个键', () => {
  const merged = mergeConfig(
    { smtp: { host: 'x', passEnv: 'OLD_VAR' } },
    { smtp: { passEnv: null, passRef: 'dizzyapi/smtp' } },
  )
  assert.deepEqual(merged, { smtp: { host: 'x', passRef: 'dizzyapi/smtp' } })
})

test('删掉顶层键：删完就是没有这个键，不是 null', () => {
  const merged = mergeConfig({ a: 1, b: 2 }, { b: null })
  assert.deepEqual(merged, { a: 1 })
  assert.equal('b' in merged, false)
})

test('标量覆盖：新值胜', () => {
  assert.deepEqual(mergeConfig({ transport: 'log', timeoutMs: 1000 }, { transport: 'smtp', timeoutMs: 5000 }), {
    transport: 'smtp',
    timeoutMs: 5000,
  })
})

test('数组整体替换，不逐项合并', () => {
  assert.deepEqual(mergeConfig({ list: [1, 2, 3] }, { list: [9] }), { list: [9] })
  assert.deepEqual(mergeConfig({ adminPlugins: ['a', 'b'] }, { adminPlugins: ['c'] }), {
    adminPlugins: ['c'],
  })
})

test('基线不是对象（缺 config）时，按空对象处理', () => {
  assert.deepEqual(mergeConfig(undefined, { transport: 'log' }), { transport: 'log' })
  assert.deepEqual(mergeConfig(null, { transport: 'log' }), { transport: 'log' })
})

test('空覆盖：原样返回基线的一份副本', () => {
  const baseline = { a: { b: 1 } }
  const merged = mergeConfig(baseline, {})
  assert.deepEqual(merged, baseline)
  assert.notEqual(merged, baseline, '必须是副本，改它不能动到基线')
})

test('revision 只由内容决定：键序不影响结果', () => {
  assert.equal(revisionOf({ a: 1, b: 2 }), revisionOf({ b: 2, a: 1 }))
  assert.equal(revisionOf({ a: 1 }), revisionOf({ a: 1 }))
  assert.notEqual(revisionOf({ a: 1 }), revisionOf({ a: 2 }))
})

test('revision 是稳定的短串', () => {
  const revision = revisionOf({ smtp: { host: 'x' } })
  assert.match(revision, /^[0-9a-f]{16}$/)
})

test('stableStringify：undefined 的键不进结果', () => {
  assert.equal(stableStringify({ a: 1, b: undefined }), stableStringify({ a: 1 }))
})
