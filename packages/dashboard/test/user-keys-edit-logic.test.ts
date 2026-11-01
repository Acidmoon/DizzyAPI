/**
 * 密钥编辑弹窗的纯逻辑单测。
 *
 * 这一段错了的后果：**以为清空了其实没发**、**以为不限其实发了个 0**、
 * 或者保存一下就把到期时间/上限悄悄改掉。所以逐条钉住五个口径：
 *
 * 1. **只发改了的字段**（没改就 `{}`，不发请求）；
 * 2. **清空用 `null`**（`expiresAt` / `spendingLimitMicros` / `concurrencyLimit` 三个都是）；
 * 3. **金额按字符串换算成微元**，`Number` / 浮点一次都不经过；
 * 4. **过期时间按「那一天结束」下发**（Go 是 `now >= expiresAt` 就 401，按零点下发等于当天一早失效）；
 * 5. 非法输入返回 `"invalid"`，**不发请求**。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import * as logicModule from '../app/src/app/(main)/user/keys/_components/key-edit-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const logic = unwrap<typeof logicModule>(logicModule)

const here = dirname(fileURLToPath(import.meta.url))
const keysDir = resolve(here, '../app/src/app/(main)/user/keys')

/** 一把「三个上限都设了」的现有密钥。 */
function filledKey() {
  return {
    name: '线上服务',
    enabled: true,
    expiresAt: '2026-11-10T15:59:59.999Z',
    spendingLimitMicros: '12500000',
    concurrencyLimit: 4,
  }
}

/** 由现有密钥造「什么都没改」的草稿。 */
function untouchedDraft() {
  return logic.keyEditDraftOf(filledKey())
}

test('什么都没改 → patch 是空对象（一个键都不发）', () => {
  assert.deepEqual(logic.keyEditPatchOf(untouchedDraft(), filledKey()), {})
})

test('三个上限清空 → 各自发 null（不是 0、不是空串）', () => {
  const draft = { ...untouchedDraft(), expiresOn: '', spendingYuan: '', concurrency: '' }
  assert.deepEqual(logic.keyEditPatchOf(draft, filledKey()), {
    expiresAt: null,
    spendingLimitMicros: null,
    concurrencyLimit: null,
  })
})

test('原来就是不限（null）→ 留空不算改动', () => {
  const before = {
    name: 'k',
    enabled: true,
    expiresAt: null,
    spendingLimitMicros: null,
    concurrencyLimit: null,
  }
  assert.deepEqual(logic.keyEditPatchOf(logic.keyEditDraftOf(before), before), {})
})

test('金额「12.5 元」→ 微元字符串 "12500000"', () => {
  const before = { ...filledKey(), spendingLimitMicros: null }
  const draft = { ...logic.keyEditDraftOf(before), spendingYuan: '12.5' }
  const patch = logic.keyEditPatchOf(draft, before)
  assert.notEqual(patch, 'invalid')
  assert.deepEqual(patch, { spendingLimitMicros: '12500000' })
})

test('金额回填与换算互为逆运算（不进浮点也读得回去）', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['1', '1000000'],
    ['0.5', '500000'],
    ['0.000001', '1'],
    ['12.5', '12500000'],
    ['9007199254.740991', '9007199254740991'],
  ]
  for (const [yuan, micros] of cases) {
    assert.equal(logic.yuanTextToMicrosText(yuan), micros, `${yuan} 元应换成 ${micros} 微元`)
    assert.equal(logic.microsToYuanText(micros), yuan, `${micros} 微元应回填成 ${yuan}`)
  }
})

test('超大金额逐位保留（> 2^53 也不丢精度）', () => {
  // 2^53 = 9007199254740992。这个值服务端会以「超出上限」明确拒绝，
  // 但**客户端不许先自己丢精度**再发出去（丢了就变成一个合法但错误的数）。
  const micros = logic.yuanTextToMicrosText('9007199254741')
  assert.equal(micros, '9007199254741000000')
  // 这个字符串值已经超出安全整数范围：一旦被当作 JSON number 发出去就会丢位，
  // 所以 patch 里的 `spendingLimitMicros` 必须是**字符串**（下面这条就是证据）。
  assert.equal(Number.isSafeInteger(Number(micros)), false)
  assert.equal(logic.microsToYuanText('9007199254741000000'), '9007199254741')
})

test('金额非法一律 invalid（0 / 负数 / 7 位小数 / 非数字）', () => {
  for (const bad of ['0', '0.0', '-1', '1.1234567', 'abc', '12,5']) {
    const draft = { ...untouchedDraft(), spendingYuan: bad }
    assert.notEqual(logic.keyEditError(draft), null, `${bad} 应被判非法`)
    assert.equal(logic.keyEditPatchOf(draft, filledKey()), 'invalid', `${bad} 不该发请求`)
  }
})

test('并发上限非法一律 invalid（0 / 负数 / 小数）', () => {
  for (const bad of ['0', '-1', '1.5', 'abc']) {
    const draft = { ...untouchedDraft(), concurrency: bad }
    assert.notEqual(logic.keyEditError(draft), null, `${bad} 应被判非法`)
    assert.equal(logic.keyEditPatchOf(draft, filledKey()), 'invalid', `${bad} 不该发请求`)
  }
  // 合法值照旧发数字（不是字符串）。
  const draft = { ...untouchedDraft(), concurrency: '8' }
  assert.deepEqual(logic.keyEditPatchOf(draft, filledKey()), { concurrencyLimit: 8 })
})

test('过期时间：同一天的另一个时刻不算改动（否则保存一下就把期限推后）', () => {
  const before = filledKey()
  // 服务端可能存的是当天零点的 UTC 写法；用户看到的是本地日期，什么都没动。
  const draft = { ...logic.keyEditDraftOf(before), expiresOn: logic.localDayOfIso(before.expiresAt) }
  assert.deepEqual(logic.keyEditPatchOf(draft, before), {})
})

test('过期时间：改日期 → 下发那一天结束（本地 23:59:59.999）的 ISO', () => {
  const before = { ...filledKey(), expiresAt: null }
  const draft = { ...logic.keyEditDraftOf(before), expiresOn: '2026-12-31' }
  const patch = logic.keyEditPatchOf(draft, before)
  assert.notEqual(patch, 'invalid')
  const iso = (patch as { expiresAt?: string | null }).expiresAt
  assert.equal(typeof iso, 'string')
  // 落回本地日期必须还是用户选的那天（跨时区不会漂到前一天/后一天）。
  assert.equal(logic.localDayOfIso(iso as string), '2026-12-31')
  const end = new Date(iso as string)
  assert.equal(end.getHours(), 23)
  assert.equal(end.getMinutes(), 59)
  assert.equal(end.getSeconds(), 59)
  // 且必须晚于当天零点（Go 是 `now >= expiresAt` 就 401，零点下发等于当天一早失效）。
  const start = logic.localDayDate('2026-12-31')
  assert.notEqual(start, null)
  assert.ok(end.getTime() > (start as Date).getTime())
})

test('过期日期不存在（2026-02-30）→ invalid，不发请求', () => {
  const draft = { ...untouchedDraft(), expiresOn: '2026-02-30' }
  assert.notEqual(logic.keyEditError(draft), null)
  assert.equal(logic.keyEditPatchOf(draft, filledKey()), 'invalid')
})

test('名称：去空格后相同不算改动；空名字 invalid', () => {
  const before = { ...filledKey() }
  assert.deepEqual(logic.keyEditPatchOf({ ...untouchedDraft(), name: `  ${before.name}  ` }, before), {})
  assert.equal(logic.keyEditError({ ...untouchedDraft(), name: '   ' }), '名称不能为空')
  assert.equal(logic.keyEditPatchOf({ ...untouchedDraft(), name: ' ' }, before), 'invalid')
})

test('启用开关是普通字段（改了就发，并发发）', () => {
  const before = filledKey()
  const draft = { ...untouchedDraft(), enabled: false, spendingYuan: '20' }
  assert.deepEqual(logic.keyEditPatchOf(draft, before), {
    enabled: false,
    spendingLimitMicros: '20000000',
  })
})

test('草稿回填：元文本不带千分位、日期是本地日', () => {
  const draft = logic.keyEditDraftOf(filledKey())
  assert.equal(draft.spendingYuan, '12.5')
  assert.equal(draft.concurrency, '4')
  assert.equal(draft.expiresOn, logic.localDayOfIso(filledKey().expiresAt))
  // 回填的金额文本必须能被原样解析回去。
  assert.equal(logic.yuanTextToMicrosText(draft.spendingYuan), '12500000')
})

test('脏数据不崩：上线出现无法解析的值时按「不限」回填', () => {
  const before = {
    name: 'k',
    enabled: false,
    expiresAt: 'not-a-date',
    spendingLimitMicros: '12.5',
    concurrencyLimit: null,
  }
  assert.deepEqual(logic.keyEditDraftOf(before), {
    name: 'k',
    enabled: false,
    expiresOn: '',
    spendingYuan: '',
    concurrency: '',
  })
})

// ───────────────────────────── 弹窗接线（源码级护栏）─────────────────────────────

/** 去掉注释再断言：护栏约束的是代码，不是说明文案（本项目 convention）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function readCode(relative: string): string {
  return stripComments(readFileSync(join(keysDir, relative), 'utf8'))
}

test('编辑弹窗：五个字段齐全，日期用自研控件而不是原生控件', () => {
  const dialog = readCode('_components/key-edit-dialog.tsx')
  for (const id of ['key-edit-name', 'key-expires-at', 'key-spending-limit', 'key-concurrency']) {
    assert.ok(dialog.includes(`id="${id}"`), `编辑弹窗缺字段：${id}`)
  }
  assert.ok(dialog.includes('启用'), '编辑弹窗缺启用开关')
  // owner 的硬要求：弹窗与浮层一律自研控件，不用浏览器默认控件。
  assert.equal(dialog.includes('type="date"'), false, '日期用了原生 <input type="date">')
  assert.equal(dialog.includes('<select'), false, '出现了原生 <select>')
  assert.ok(dialog.includes('<Calendar'), '日期要用自研 Calendar')
  assert.ok(dialog.includes('<Popover'), '日期浮层要用自研 Popover')
  // 提交前必须走纯逻辑判「改了没」，不许自己拼 patch。
  assert.ok(dialog.includes('keyEditPatchOf'), '没走 keyEditPatchOf，等于绕过了「只发改动」')
})
