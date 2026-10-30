/**
 * 界面偏好（`users.ui_preferences`）的**校验与序列化**。
 *
 * 这一列是「用户可自选」的落点：字号 / 字距（第 2 条）与侧栏顺序（第 12 条）共用一个
 * JSON 列。三条纪律：
 *
 * 1. **解析永不抛错**：老库没有这一列、手改库塞了垃圾，一律回落默认值——
 *    抛错会让用户连页面都打不开，而「字号不对」是可以忍受的；
 * 2. **写入拒绝未知字段**：不做「悄悄多出一个可写字段」这种事；
 * 3. **结构校验只做结构**：`navOrder` 只认「短字符串数组」，真正「这是不是我们站的
 *    路径」由渲染层判断（它才有那份导航表）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_UI_PREFERENCES,
  parseUiPreferences,
  normalizeUiPreferencesPatch,
  serializeUiPreferences,
} from '../../user/src/uiprefs.ts'

// ───────────────────────────── 解析（永不抛错）─────────────────────────────

test('解析：老库没有这一列（null / 空串）→ 默认值', () => {
  assert.deepEqual(parseUiPreferences(null), DEFAULT_UI_PREFERENCES)
  assert.deepEqual(parseUiPreferences(undefined), DEFAULT_UI_PREFERENCES)
  assert.deepEqual(parseUiPreferences(''), DEFAULT_UI_PREFERENCES)
})

test('解析：坏 JSON 回落默认，不抛错', () => {
  for (const raw of ['{', 'not json', '[1,2,3]', '"hello"', 'null', '42']) {
    assert.deepEqual(parseUiPreferences(raw), DEFAULT_UI_PREFERENCES, `${raw} 应该回落默认`)
  }
})

test('解析：只缺 navOrder 时其余偏好照样生效（A 段的老数据）', () => {
  const saved = JSON.stringify({ fontScale: 1.25, letterSpacing: 'wide' })
  const parsed = parseUiPreferences(saved)
  assert.equal(parsed.fontScale, 1.25)
  assert.equal(parsed.letterSpacing, 'wide')
  assert.deepEqual(parsed.navOrder, [])
})

test('解析：navOrder 只认字符串数组，坏项逐条丢掉', () => {
  const saved = JSON.stringify({
    navOrder: ['/a', 3, null, '/b', '', '/c', { path: '/d' }],
  })
  assert.deepEqual(parseUiPreferences(saved).navOrder, ['/a', '/b', '/c'])
})

test('解析：navOrder 必须是 / 开头的短字符串，超长丢弃', () => {
  const saved = JSON.stringify({ navOrder: ['nope', '/ok', `/${'x'.repeat(300)}`] })
  assert.deepEqual(parseUiPreferences(saved).navOrder, ['/ok'])
})

test('解析：navOrder 去重（第一次出现的位置保留）', () => {
  const saved = JSON.stringify({ navOrder: ['/b', '/a', '/b'] })
  assert.deepEqual(parseUiPreferences(saved).navOrder, ['/b', '/a'])
})

test('解析：navOrder 有长度上限（一份被写坏的 JSON 撑不爆页面）', () => {
  const many = Array.from({ length: 500 }, (_, index) => `/p${index}`)
  const saved = JSON.stringify({ navOrder: many })
  assert.ok(parseUiPreferences(saved).navOrder.length <= 64)
})

// ───────────────────────────── 写入（部分更新）─────────────────────────────

const BASE = { ...DEFAULT_UI_PREFERENCES, fontScale: 1.25 as const, letterSpacing: 'wide' as const }

test('写入：只给 navOrder 时不动字号 / 字距', () => {
  const next = normalizeUiPreferencesPatch(BASE, { navOrder: ['/b', '/a'] })
  assert.deepEqual(next, { fontScale: 1.25, letterSpacing: 'wide', navOrder: ['/b', '/a'] })
})

test('写入：不给 navOrder 时保留原值（改字号不重置侧栏顺序）', () => {
  const withOrder = { ...BASE, navOrder: ['/b', '/a'] }
  const next = normalizeUiPreferencesPatch(withOrder, { fontScale: 1 })
  assert.deepEqual(next, { fontScale: 1, letterSpacing: 'wide', navOrder: ['/b', '/a'] })
})

test('写入：未知字段一律拒绝（不做悄悄可写）', () => {
  const result = normalizeUiPreferencesPatch(BASE, { nope: 1 })
  assert.equal(typeof result, 'string')
  assert.match(result as string, /未知的界面偏好字段/)
})

test('写入：navOrder 不是数组直接拒绝', () => {
  for (const bad of ['/a', 42, null, { 0: '/a' }]) {
    const result = normalizeUiPreferencesPatch(BASE, { navOrder: bad })
    assert.equal(typeof result, 'string', `${String(bad)} 应该被拒绝`)
  }
})

test('写入：字号 / 字距仍按档位校验（原有契约不变）', () => {
  assert.equal(typeof normalizeUiPreferencesPatch(BASE, { fontScale: 99 }), 'string')
  assert.equal(typeof normalizeUiPreferencesPatch(BASE, { letterSpacing: 'nope' }), 'string')
  assert.equal(typeof normalizeUiPreferencesPatch(BASE, { letterSpacing: 'wide; } body{x' }), 'string')
})

// ───────────────────────────── 序列化 ─────────────────────────────

test('序列化：三个字段都在，键顺序固定（便于人工比对）', () => {
  const json = serializeUiPreferences({ fontScale: 1.25, letterSpacing: 'wide', navOrder: ['/b', '/a'] })
  assert.equal(json, '{"fontScale":1.25,"letterSpacing":"wide","navOrder":["/b","/a"]}')
  // 往返一致
  assert.deepEqual(parseUiPreferences(json), { fontScale: 1.25, letterSpacing: 'wide', navOrder: ['/b', '/a'] })
})

test('序列化：空顺序也写出来（不是省略字段，否则「恢复默认」与「没设过」分不清）', () => {
  const json = serializeUiPreferences(DEFAULT_UI_PREFERENCES)
  assert.ok(json.includes('"navOrder":[]'))
  assert.deepEqual(parseUiPreferences(json), DEFAULT_UI_PREFERENCES)
})
