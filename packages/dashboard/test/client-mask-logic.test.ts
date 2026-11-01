/**
 * 客户端指纹档案的纯逻辑单测。
 *
 * 这一段的两个真实风险：
 * 1. **受保护头 / 占位符 / 秘密形状**没拦住 —— 用户白填一通，提交才被服务端拒；
 *    更糟的是「像秘密的值」进了档案，就被推到 Go、进了快照。
 * 2. **只发改了的键**这条口径错了 —— 多发一个键就是一条空审计，
 *    把「原来有 UA、现在清空」写成省略，则是**清不掉**。
 *
 * 规则与服务端 `packages/client-mask/src/template.ts` 逐条对齐（那边也有一套用例）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as logicModule from '../app/src/app/(main)/dashboard/_components/client-mask-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const {
  addHeaderRow,
  clientCreateBodyOf,
  clientDraftError,
  clientDraftIssues,
  clientDraftOf,
  clientHeaderNameError,
  clientHeaderValueError,
  clientMaskSummary,
  clientProfileIdError,
  clientUpdatePatchOf,
  clientUserAgentError,
  emptyClientDraft,
  groupProfiles,
  MAX_HEADERS_PER_PROFILE,
  profileSubtitle,
  PROTECTED_HEADERS,
  removeHeaderRow,
  updateHeaderRow,
} = unwrap<typeof logicModule>(logicModule)

function profileOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'opencode',
    label: 'opencode',
    description: null,
    enabled: true,
    userAgent: null,
    headers: [{ name: 'x-opencode-session', value: '{{session}}' }],
    builtin: true,
    ...overrides,
  }
}

// ───────────────────────────── 校验 ─────────────────────────────

test('档案 id：小写字母/数字开头，允许 - 与 _，上限 64 字节', () => {
  assert.equal(clientProfileIdError('opencode'), null)
  assert.equal(clientProfileIdError('my-cli_2'), null)
  assert.equal(clientProfileIdError(''), '档案 id 不能为空')
  assert.equal(clientProfileIdError('OpenCode') !== null, true, '大写不合法')
  assert.equal(clientProfileIdError('-lead') !== null, true, '不能以连字符开头')
  assert.equal(clientProfileIdError('a'.repeat(65)) !== null, true, '超长')
})

test('头名：受保护名单一律拒（鉴权 / Host / Accept / Content-Type / UA / Cookie）', () => {
  for (const name of ['Authorization', 'x-api-key', 'x-goog-api-key', 'Host', 'Accept', 'Content-Type', 'User-Agent', 'Cookie']) {
    assert.ok(PROTECTED_HEADERS.includes(name.toLowerCase()), `${name} 应在受保护名单里`)
    assert.notEqual(clientHeaderNameError(name), null, `${name} 必须被拒`)
  }
  assert.equal(clientHeaderNameError('x-opencode-session'), null)
  assert.equal(clientHeaderNameError('bad name') !== null, true, '含空格不是合法 token')
  assert.equal(clientHeaderNameError('') !== null, true)
})

test('头值：只允许三个占位符，陌生的 {{...}} 一律拒', () => {
  assert.equal(clientHeaderValueError('{{uuid}}'), null)
  assert.equal(clientHeaderValueError('{{session}}'), null)
  assert.equal(clientHeaderValueError('{{timestamp}}'), null)
  assert.equal(clientHeaderValueError('v1:{{session}}:x'), null)
  assert.notEqual(clientHeaderValueError('{{token}}'), null)
  assert.notEqual(clientHeaderValueError('{{session'), null)
})

test('头值：控制字符（换行 = 头注入）与疑似秘密都拒', () => {
  assert.notEqual(clientHeaderValueError('a\r\nInjected: 1'), null)
  assert.notEqual(clientHeaderValueError('a\n'), null)
  assert.notEqual(clientHeaderValueError('sk-abcdefgh1234'), null)
  assert.notEqual(clientHeaderValueError('Bearer abcdefgh123'), null)
  assert.equal(clientHeaderValueError('plain-value'), null)
})

test('User-Agent：同一套形状规则（不许控制字符 / 不许像秘密）', () => {
  assert.equal(clientUserAgentError('dizzy-cli/1.0'), null)
  assert.notEqual(clientUserAgentError('a\nb'), null)
  assert.notEqual(clientUserAgentError('sk-live-1234567890'), null)
})

test('草稿问题：一次性给出所有字段的错（就近显示），并带行号', () => {
  const draft = {
    ...emptyClientDraft(),
    id: 'Bad Id',
    label: '',
    headers: [
      { name: 'Authorization', value: 'x' },
      { name: 'ok-header', value: '{{nope}}' },
    ],
  }
  const issues = clientDraftIssues(draft, true)
  const fields = issues.map((issue) => issue.field)
  assert.ok(fields.includes('id'))
  assert.ok(fields.includes('label'))
  assert.ok(fields.includes('headers.0.name'))
  assert.ok(fields.includes('headers.1.value'))
  assert.equal(clientDraftError(draft, true), issues[0]?.message)
})

test('头数上限：超过 24 个报错', () => {
  const headers = Array.from({ length: MAX_HEADERS_PER_PROFILE + 1 }, (_, index) => ({
    name: `x-h-${String(index)}`,
    value: 'v',
  }))
  const draft = { ...emptyClientDraft(), id: 'x', label: 'x', headers }
  assert.ok(clientDraftIssues(draft, true).some((issue) => issue.field === 'headers'))
})

// ───────────────────────────── 请求体 ─────────────────────────────

test('新建：完全空的行丢掉、首尾空白 trim、可选项留空就不发', () => {
  const draft = {
    ...emptyClientDraft(),
    id: 'my-cli',
    label: ' 我的 CLI ',
    userAgent: '',
    description: '  ',
    headers: [
      { name: ' x-client ', value: 'cli' },
      // 完全空的一行 = 点「添加一行」多出来的，提交时丢掉。
      { name: '   ', value: '' },
    ],
  }
  const body = clientCreateBodyOf(draft)
  assert.notEqual(body, 'invalid')
  if (body === 'invalid') return
  assert.deepEqual(body, {
    id: 'my-cli',
    label: '我的 CLI',
    enabled: true,
    headers: [{ name: 'x-client', value: 'cli' }],
  })
})

test('新建：头名空但值填了 → 报错（不许把用户填的值静默丢掉）', () => {
  const draft = {
    ...emptyClientDraft(),
    id: 'my-cli',
    label: 'x',
    headers: [{ name: '   ', value: 'x-opencode-session' }],
  }
  assert.equal(clientCreateBodyOf(draft), 'invalid')
  const issues = clientDraftIssues(draft, true)
  assert.ok(issues.some((issue) => issue.message.includes('第 1 行：头名不能为空')))
})

test('新建：不合法直接 "invalid"（不发请求）', () => {
  const draft = { ...emptyClientDraft(), id: 'my-cli', label: 'x', headers: [{ name: 'Host', value: 'evil' }] }
  assert.equal(clientCreateBodyOf(draft), 'invalid')
})

test('改：只发改了的键；清空要显式发 null', () => {
  const profile = profileOf({ userAgent: 'old/1.0', description: 'keep' }) as never
  const draft = clientDraftOf(profile)

  // 什么都没改 → 空补丁
  assert.deepEqual(clientUpdatePatchOf(draft, profile), {})

  // 清空 UA 与说明 → null（不是省略）
  const cleared = clientUpdatePatchOf({ ...draft, userAgent: '', description: '' }, profile)
  assert.notEqual(cleared, 'invalid')
  if (cleared === 'invalid') return
  assert.deepEqual(cleared, { userAgent: null, description: null })

  // 改头 → 整份新头（顺序有意义）
  const reordered = clientUpdatePatchOf(
    { ...draft, headers: [{ name: 'b', value: '2' }, { name: 'a', value: '1' }] },
    profile,
  )
  assert.notEqual(reordered, 'invalid')
  if (reordered === 'invalid') return
  assert.deepEqual(reordered.headers, [{ name: 'b', value: '2' }, { name: 'a', value: '1' }])
})

test('改：id 不参与校验（改已有档案时 id 不可改）', () => {
  const profile = profileOf({ id: 'opencode' }) as never
  const draft = { ...clientDraftOf(profile), id: 'ignored-in-patch', label: '改名' }
  const patch = clientUpdatePatchOf(draft, profile)
  assert.notEqual(patch, 'invalid')
  if (patch === 'invalid') return
  assert.equal(Object.hasOwn(patch, 'id'), false)
  assert.equal(patch.label, '改名')
})

// ───────────────────────────── 头行操作 ─────────────────────────────

test('头行：加一行 / 删一行 / 改一行都不改原数组', () => {
  const base = [{ name: 'a', value: '1' }]
  const added = addHeaderRow(base)
  assert.deepEqual(added, [{ name: 'a', value: '1' }, { name: '', value: '' }])
  assert.deepEqual(base, [{ name: 'a', value: '1' }], '原数组不许被改')

  const updated = updateHeaderRow(added, 1, { name: 'b' })
  assert.deepEqual(updated[1], { name: 'b', value: '' })

  const removed = removeHeaderRow(added, 0)
  assert.deepEqual(removed, [{ name: '', value: '' }])
})

// ───────────────────────────── 列表与文案 ─────────────────────────────

test('分组：内置与自定义分开，顺序不变', () => {
  const items: { id: string; builtin: boolean }[] = [
    { id: 'a', builtin: true },
    { id: 'b', builtin: false },
  ]
  const groups = groupProfiles(items)
  assert.deepEqual(groups.builtin.map((item) => item.id), ['a'])
  assert.deepEqual(groups.custom.map((item) => item.id), ['b'])
})

test('文案：总闸状态与数量、停用标记', () => {
  assert.equal(clientMaskSummary(null), '档案读取中…')
  assert.equal(
    clientMaskSummary({ enabled: true, profiles: 5, builtin: 4, custom: 1, enabledProfiles: 4 }),
    '伪装总闸开启 · 共 5 档（内置 4 / 自定义 1）· 已启用 4',
  )
  assert.equal(
    clientMaskSummary({ enabled: false, profiles: 0, builtin: 0, custom: 0, enabledProfiles: 0 }),
    '伪装总闸关闭 · 共 0 档（内置 0 / 自定义 0）· 已启用 0',
  )
  assert.equal(profileSubtitle({ id: 'opencode', headers: [], enabled: true }), 'opencode · 0 个头')
  assert.equal(profileSubtitle({ id: 'codex', headers: [1], enabled: false }), 'codex · 1 个头 · 已停用')
})
