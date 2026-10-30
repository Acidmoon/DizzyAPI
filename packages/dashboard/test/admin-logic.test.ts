/**
 * 管理台页面的纯逻辑单测（金额 / 并发上限 / 只提交改动字段）。
 *
 * 为什么在**根** `pnpm test` 里跑：这些是「错了最贵」的换算（浮点、超 2^53、负号方向），
 * 必须被逐字钉住。逻辑刻意抽在 `admin-logic.ts`（不 import React），
 * 所以能在没有 React 的仓库根测试环境里直接 import。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as logicModule from '../app/src/app/(main)/dashboard/_components/admin-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const {
  accountStateLabel,
  balanceDelta,
  negateMicros,
  parseConcurrencyLimit,
  roleLabel,
  statusLabel,
  userPatchOf,
  yuanTextToMicros,
} = unwrap<typeof logicModule>(logicModule)

// ───────────────────────────── 金额：元 ↔ 微元（字符串，不经浮点）─────────────────────────────

test('yuanTextToMicros：整数与小数都按 6 位补齐', () => {
  assert.equal(yuanTextToMicros('10'), '10000000')
  assert.equal(yuanTextToMicros('1'), '1000000')
  assert.equal(yuanTextToMicros('0.5'), '500000')
  assert.equal(yuanTextToMicros('0.000001'), '1')
  assert.equal(yuanTextToMicros('0.123456'), '123456')
  assert.equal(yuanTextToMicros('0'), '0')
  assert.equal(yuanTextToMicros('  42  '), '42000000')
})

test('yuanTextToMicros：非法输入返回 null，不猜、不取 0', () => {
  for (const bad of ['', ' ', '-1', '1.1234567', 'abc', '1.', '.5', '1e6', '１', '0x10']) {
    assert.equal(yuanTextToMicros(bad), null, `期望「${bad}」被判非法`)
  }
})

test('yuanTextToMicros：大额也不丢精度（超过 Number.MAX_SAFE_INTEGER）', () => {
  // 9007199254740993 微元 = 9007199254.740993 元；Number 在这里会丢 1。
  assert.equal(yuanTextToMicros('9007199254.740993'), '9007199254740993')
  assert.notEqual(String(Number('9007199254740993')), '9007199254740993')
})

test('negateMicros：BigInt 取负，0 仍是 0', () => {
  assert.equal(negateMicros('1000000'), '-1000000')
  assert.equal(negateMicros('0'), '0')
  assert.equal(negateMicros('9007199254740993'), '-9007199254740993')
})

test('balanceDelta：方向决定正负，非法或 0 返回 null', () => {
  assert.equal(balanceDelta('add', '10'), '10000000')
  assert.equal(balanceDelta('subtract', '10'), '-10000000')
  assert.equal(balanceDelta('subtract', '0.5'), '-500000')
  assert.equal(balanceDelta('add', '0'), null, '金额 0 不该产生一条流水')
  assert.equal(balanceDelta('add', '0.0000001'), null, '7 位小数非法')
  assert.equal(balanceDelta('subtract', 'abc'), null)
})

// ───────────────────────────── 并发上限：空 = 不限（null），不是 0 ─────────────────────────────

test('parseConcurrencyLimit：空串是「不限」而不是 0', () => {
  assert.equal(parseConcurrencyLimit(''), null)
  assert.equal(parseConcurrencyLimit('   '), null)
})

test('parseConcurrencyLimit：只接受正整数', () => {
  assert.equal(parseConcurrencyLimit('1'), 1)
  assert.equal(parseConcurrencyLimit('32'), 32)
  assert.equal(parseConcurrencyLimit(' 8 '), 8)
  for (const bad of ['0', '-1', '1.5', 'abc', '1e3']) {
    assert.equal(parseConcurrencyLimit(bad), 'invalid', `期望「${bad}」被判非法`)
  }
})

// ───────────────────────────── 用户编辑：只提交改了的字段 ─────────────────────────────

const before = {
  name: '张三',
  role: 'user' as const,
  status: 'enabled' as const,
  balanceEnabled: true,
  concurrencyLimit: 4,
}

const draftOf = {
  name: '张三',
  role: 'user' as const,
  status: 'enabled' as const,
  balanceEnabled: true,
  concurrency: '4',
}

test('userPatchOf：什么都没改就返回空对象（不发请求、不写审计）', () => {
  assert.deepEqual(userPatchOf(draftOf, before), {})
})

test('userPatchOf：只放改了的字段', () => {
  assert.deepEqual(userPatchOf({ ...draftOf, role: 'admin' }, before), { role: 'admin' })
  assert.deepEqual(userPatchOf({ ...draftOf, status: 'banned' }, before), { status: 'banned' })
  assert.deepEqual(userPatchOf({ ...draftOf, name: ' 李四 ' }, before), { name: '李四' })
  assert.deepEqual(userPatchOf({ ...draftOf, balanceEnabled: false }, before), { balanceEnabled: false })
  assert.deepEqual(userPatchOf({ ...draftOf, concurrency: '' }, before), { concurrencyLimit: null })
  assert.deepEqual(userPatchOf({ ...draftOf, concurrency: '8' }, before), { concurrencyLimit: 8 })
})

test('userPatchOf：并发非法或名字为空返回 invalid，不提交半条 patch', () => {
  assert.equal(userPatchOf({ ...draftOf, concurrency: '0' }, before), 'invalid')
  assert.equal(userPatchOf({ ...draftOf, name: '   ' }, before), 'invalid')
})

test('userPatchOf：名字只有首尾空格差异不算改动（trim 后再比）', () => {
  assert.deepEqual(userPatchOf({ ...draftOf, name: '  张三  ' }, before), {})
})

// ───────────────────────────── 标签：未知值不冒充已知值 ─────────────────────────────

test('roleLabel / statusLabel：已知值给中文，未知值原样返回', () => {
  assert.equal(roleLabel('admin'), '管理员')
  assert.equal(roleLabel('user'), '普通用户')
  assert.equal(roleLabel('owner'), 'owner', '未知角色不能显示成「普通用户」')
  assert.equal(statusLabel('enabled'), '启用')
  assert.equal(statusLabel('banned'), '封禁')
  assert.equal(statusLabel('shadow'), 'shadow')
})

test('accountStateLabel：人手停用优先于 status，自动停用与待授权分开', () => {
  assert.equal(accountStateLabel(false, 'active'), '人为停用')
  assert.equal(accountStateLabel(false, 'auto_disabled'), '人为停用', 'enabled=false 就是人为停用')
  assert.equal(accountStateLabel(true, 'auto_disabled'), '系统自动停用')
  assert.equal(accountStateLabel(true, 'needs_reauth'), '待重新授权')
  assert.equal(accountStateLabel(true, 'active'), '可用')
  assert.equal(accountStateLabel(true, 'weird'), 'weird')
})
