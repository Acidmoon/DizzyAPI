/**
 * 管理台批 2 后五页的纯逻辑单测（日期区间 / 审核规则入参 / 设置 patch / 标签）。
 *
 * 为什么这些必须被逐字钉住：
 * 1. **日期区间**：结束日要含当天（半开区间），服务端与旧 SSR 版都按 UTC 切天；
 *    这里算错一天，同一条审计记录就会落到不同的天里。
 * 2. **审核规则的「清空 vs 不改」**：服务端用 `Object.hasOwn` 判「给了没」，
 *    不带键 = 不改，发 `null` = 清空。写错就是「想清空却没清掉」。
 * 3. **设置的 patch 必须嵌套**：`mergeConfig` 按普通对象递归合并，扁平点分键
 *    能过校验但**不生效**——这是那种「接口回 200、配置却没变」的静默 bug。
 * 4. **未知标签不冒充已知值**：空白等于「这条没事」，比露出英文码危险得多。
 *
 * 逻辑刻意抽在 `.ts`（不 import React），所以能在没有 React 的仓库根测试环境里 import。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as logicModule from '../app/src/app/(main)/dashboard/_components/admin-logic.ts'
import * as auditModule from '../app/src/app/(main)/dashboard/_components/audit-logic.ts'
import * as contentAuditModule from '../app/src/app/(main)/dashboard/_components/content-audit-logic.ts'
import * as settingsModule from '../app/src/app/(main)/dashboard/_components/settings-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const {
  dateRangeMs,
  isProblemSettleStatus,
  settleStatusLabel,
  sourceHealthLabel,
  utcDayStartMs,
  warningLabel,
} = unwrap<typeof logicModule>(logicModule)

const {
  contentAuditActionLabel,
  contentAuditHitsOf,
  createRuleInputOf,
  draftOf,
  ruleHitCount,
  rulePatchOf,
} = unwrap<typeof contentAuditModule>(contentAuditModule)

const { AUDIT_ACTION_LABELS, auditActionLabel, auditTargetLabel, metadataLine } =
  unwrap<typeof auditModule>(auditModule)

const {
  fieldInputText,
  fieldValueText,
  integerFieldValue,
  patchFromPaths,
  settingsNamespacesOf,
  stringArrayFieldValue,
  textFieldValue,
} = unwrap<typeof settingsModule>(settingsModule)

// ───────────────────────────── 日期区间（UTC，半开）─────────────────────────────

test('utcDayStartMs：按 UTC 切天，非法日期返回 null', () => {
  assert.equal(utcDayStartMs('2026-10-31'), Date.UTC(2026, 9, 31))
  assert.equal(utcDayStartMs('2026-01-01'), Date.UTC(2026, 0, 1))
  for (const bad of ['', '2026-13-01', '2026-02-30', '2026-10-31T00:00', 'abc', '20261031']) {
    assert.equal(utcDayStartMs(bad), null, `期望「${bad}」被判非法`)
  }
})

test('dateRangeMs：结束日含当天（右端 +1 天、左闭右开）', () => {
  const range = dateRangeMs('2026-10-01', '2026-10-31')
  assert.ok(range !== null)
  assert.equal(range.fromMs, Date.UTC(2026, 9, 1))
  assert.equal(range.toMs, Date.UTC(2026, 10, 1), '右端应是 11-01 零点（含 10-31 当天）')
  assert.ok((range.toMs as number) > (range.fromMs as number))
})

test('dateRangeMs：空串 = 不限（不带这个键）', () => {
  assert.deepEqual(dateRangeMs('', ''), {})
  const onlyFrom = dateRangeMs('2026-10-01', '')
  assert.deepEqual(onlyFrom, { fromMs: Date.UTC(2026, 9, 1) })
  const onlyTo = dateRangeMs('', '2026-10-31')
  assert.deepEqual(onlyTo, { toMs: Date.UTC(2026, 10, 1) })
})

test('dateRangeMs：非法日期与反了的区间都返回 null（明确失败，不静默查空）', () => {
  assert.equal(dateRangeMs('2026-02-30', ''), null)
  assert.equal(dateRangeMs('', 'nope'), null)
  assert.equal(dateRangeMs('2026-10-31', '2026-10-01'), null, '起始晚于结束应判非法')
})

test('dateRangeMs：起止同一天是合法的「就这一天」（覆盖整天 24 小时）', () => {
  const range = dateRangeMs('2026-10-31', '2026-10-31')
  assert.ok(range !== null)
  assert.equal(range.toMs as number - (range.fromMs as number), 86_400_000)
})

// ───────────────────────────── 结算状态 ─────────────────────────────

test('settleStatusLabel：已知值给中文，未知值原样返回', () => {
  assert.equal(settleStatusLabel('settled'), '已结算')
  assert.equal(settleStatusLabel('no-price'), '无价格')
  assert.equal(settleStatusLabel('review'), '待核查')
  assert.equal(settleStatusLabel('weird'), 'weird')
})

test('isProblemSettleStatus：与服务端 problem 筛选同口径（失败 / 待核查 / 残留）', () => {
  assert.equal(isProblemSettleStatus('failed'), true)
  assert.equal(isProblemSettleStatus('review'), true)
  assert.equal(isProblemSettleStatus('settling'), true)
  assert.equal(isProblemSettleStatus('settled'), false)
  assert.equal(isProblemSettleStatus('no-price'), false)
  assert.equal(isProblemSettleStatus('no-user'), false)
})

// ───────────────────────────── 内容审核：清空 vs 不改 ─────────────────────────────

const ruleBefore = {
  pattern: '违禁词',
  action: 'block' as const,
  category: '政治',
  note: '第一条',
  enabled: true,
}

test('rulePatchOf：什么都没改就返回空对象（不发请求、不写审计）', () => {
  assert.deepEqual(rulePatchOf(draftOf(ruleBefore), ruleBefore), {})
})

test('rulePatchOf：清空分类 / 备注要显式发 null，不发就是「不改」', () => {
  const draft = { ...draftOf(ruleBefore), category: '', note: '' }
  assert.deepEqual(rulePatchOf(draft, ruleBefore), { category: null, note: null })
})

test('rulePatchOf：改值只放改了的字段', () => {
  assert.deepEqual(rulePatchOf({ ...draftOf(ruleBefore), pattern: '新词' }, ruleBefore), {
    pattern: '新词',
  })
  assert.deepEqual(rulePatchOf({ ...draftOf(ruleBefore), action: 'log' }, ruleBefore), {
    action: 'log',
  })
  assert.deepEqual(rulePatchOf({ ...draftOf(ruleBefore), enabled: false }, ruleBefore), {
    enabled: false,
  })
  assert.deepEqual(rulePatchOf({ ...draftOf(ruleBefore), category: '色情' }, ruleBefore), {
    category: '色情',
  })
})

test('rulePatchOf：关键词为空返回 invalid，不提交半条 patch', () => {
  assert.equal(rulePatchOf({ ...draftOf(ruleBefore), pattern: '  ' }, ruleBefore), 'invalid')
})

test('createRuleInputOf：空串的分类 / 备注不带这个键（服务端把空串当「没给」）', () => {
  const input = createRuleInputOf({
    pattern: '  新词  ',
    action: 'log',
    category: '  ',
    note: '',
    enabled: true,
  })
  assert.deepEqual(input, { pattern: '新词', action: 'log', enabled: true })
  assert.equal('category' in input, false)
  assert.equal('note' in input, false)
})

test('draftOf：新建时默认 block + 启用', () => {
  const draft = draftOf(null)
  assert.equal(draft.action, 'block')
  assert.equal(draft.enabled, true)
  assert.equal(draft.pattern, '')
})

// ───────────────────────────── 命中统计的收窄 ─────────────────────────────

test('contentAuditHitsOf：没有 hits 就是 null（不等于「全 0」）', () => {
  assert.equal(contentAuditHitsOf(null), null)
  assert.equal(contentAuditHitsOf(undefined), null)
  // 空对象是「有这条字段但键都读不出」——收窄成全 0，不是 null。
  const empty = contentAuditHitsOf({})
  assert.ok(empty !== null)
  assert.equal(empty.blocked, 0)
  assert.deepEqual(empty.byRule, {})
})

test('contentAuditHitsOf：读不出的键当 0，byRule 只收数字', () => {
  const hits = contentAuditHitsOf({ blocked: 3, logged: 'x', byRule: { r1: 2, r2: 'no' } })
  assert.ok(hits !== null)
  assert.equal(hits.blocked, 3)
  assert.equal(hits.logged, 0)
  assert.deepEqual(hits.byRule, { r1: 2 })
  assert.equal(ruleHitCount(hits, 'r1'), 2)
  assert.equal(ruleHitCount(hits, 'r9'), 0)
  assert.equal(ruleHitCount(null, 'r1'), 0)
})

// ───────────────────────────── 标签：未知值不冒充已知值 ─────────────────────────────

test('sourceHealthLabel / warningLabel / contentAuditActionLabel：未知值原样返回', () => {
  assert.equal(sourceHealthLabel('ok'), '正常')
  assert.equal(sourceHealthLabel('degraded'), '降级')
  assert.equal(sourceHealthLabel('unavailable'), '不可用')
  assert.equal(sourceHealthLabel('weird'), 'weird')
  assert.equal(warningLabel('USAGE_GAP'), '用量链路有缺口（记录被跳过）')
  assert.equal(warningLabel('NOT_A_CODE'), 'NOT_A_CODE')
  assert.equal(contentAuditActionLabel('block'), '拒绝')
  assert.equal(contentAuditActionLabel('log'), '仅记录')
  assert.equal(contentAuditActionLabel('weird'), 'weird')
})

test('auditActionLabel / auditTargetLabel：没映射的原样显示（绝不空白）', () => {
  assert.equal(auditActionLabel('user.balance.adjust'), '调整用户余额')
  assert.equal(auditActionLabel('unknown.action'), 'unknown.action')
  assert.equal(auditTargetLabel('user'), '用户')
  assert.equal(auditTargetLabel('unknown-target'), 'unknown-target')
  assert.equal(auditTargetLabel(''), '—')
})

test('审计动作表：每条 action 都能取到标签（空白等于「看起来没事」）', () => {
  for (const code of Object.keys(AUDIT_ACTION_LABELS)) {
    assert.notEqual(auditActionLabel(code), '', `动作 ${code} 没有标签`)
    assert.notEqual(auditActionLabel(code), code, `动作 ${code} 的标签等于码本身`)
  }
})

test('metadataLine：过长截断，空对象给「—」', () => {
  assert.equal(metadataLine(null), '—')
  assert.equal(metadataLine({}), '—')
  assert.equal(metadataLine({ fields: ['a'] }), '{"fields":["a"]}')
  const long = metadataLine({ blob: 'x'.repeat(300) })
  assert.ok(long.length < 200, `期望被截断，实际 ${String(long.length)} 字符`)
  assert.ok(long.endsWith('…'))
})

// ───────────────────────────── 设置：patch 必须嵌套 ─────────────────────────────

test('patchFromPaths：点分路径 → 嵌套对象（扁平键不生效）', () => {
  assert.deepEqual(patchFromPaths({ 'smtp.host': 'a' }), { smtp: { host: 'a' } })
  assert.deepEqual(patchFromPaths({ 'smtp.host': 'a', 'smtp.port': 25 }), {
    smtp: { host: 'a', port: 25 },
  })
  assert.deepEqual(patchFromPaths({ 'a.b.c': 1 }), { a: { b: { c: 1 } } })
})

test('patchFromPaths：null（清空）也要嵌到正确位置', () => {
  assert.deepEqual(patchFromPaths({ 'smtp.passEnv': null }), { smtp: { passEnv: null } })
})

test('patchFromPaths：空路径忽略', () => {
  assert.deepEqual(patchFromPaths({ '': 1 }), {})
})

test('设置字段的取值：空串 = 清空（null），整数非法给 invalid', () => {
  assert.equal(textFieldValue('  '), null)
  assert.equal(textFieldValue(' abc '), 'abc')
  assert.equal(integerFieldValue('12'), 12)
  assert.equal(integerFieldValue('-3'), -3)
  assert.equal(integerFieldValue('1.5'), 'invalid')
  assert.equal(integerFieldValue('abc'), 'invalid')
  assert.equal(integerFieldValue(''), 'invalid')
})

test('字符串数组：按换行或逗号切分，去掉空项', () => {
  assert.deepEqual(stringArrayFieldValue('a\nb'), ['a', 'b'])
  assert.deepEqual(stringArrayFieldValue('a, b ,c'), ['a', 'b', 'c'])
  assert.deepEqual(stringArrayFieldValue('a\n\n  \nb'), ['a', 'b'])
  assert.deepEqual(stringArrayFieldValue(''), [])
})

test('fieldInputText / fieldValueText：未知就是「—」，不是空串', () => {
  assert.equal(fieldInputText(undefined), '')
  assert.equal(fieldInputText(null), '')
  assert.equal(fieldInputText('x'), 'x')
  assert.equal(fieldInputText(true), 'true')
  assert.equal(fieldInputText(['a', 'b']), 'a\nb')
  assert.equal(fieldValueText(null), '—')
  assert.equal(fieldValueText(undefined), '—')
  assert.equal(fieldValueText(['a', 'b']), 'a, b')
})

// ───────────────────────────── 设置响应收窄 ─────────────────────────────

test('settingsNamespacesOf：形状对不上就返回空数组（不炸）', () => {
  assert.deepEqual(settingsNamespacesOf(null), [])
  assert.deepEqual(settingsNamespacesOf({}), [])
  assert.deepEqual(settingsNamespacesOf({ namespaces: 'x' }), [])
})

test('settingsNamespacesOf：收窄出真实字段', () => {
  const list = settingsNamespacesOf({
    namespaces: [
      {
        ns: 'mailer',
        plugin: '@dizzyapi/plugin-mailer',
        active: true,
        disabled: false,
        writable: true,
        overridden: true,
        revision: 'abc',
        updatedAt: '2026-10-31T00:00:00.000Z',
        pending: false,
        fields: [
          { path: 'smtp.host', label: '服务器', kind: 'string', writable: true, secret: false },
          { path: 'pass', label: '密码', kind: 'string', writable: false, secret: true, configured: true },
        ],
      },
    ],
  })
  assert.equal(list.length, 1)
  const ns = list[0]
  assert.ok(ns !== undefined)
  assert.equal(ns.ns, 'mailer')
  assert.equal(ns.revision, 'abc')
  assert.equal(ns.fields.length, 2)
  assert.equal(ns.fields[1]?.secret, true)
  assert.equal(ns.fields[1]?.configured, true)
})
