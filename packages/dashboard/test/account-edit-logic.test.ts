/**
 * 编辑上游账号的纯逻辑单测。
 *
 * 这一段错了的后果：**改一个账号顺手改坏别的字段**，或者「以为清空了其实没发」。
 * 所以逐条钉住四个口径：
 * 1. **只发改了的字段**（多发 = 多记一条审计，事后看不见真正改了什么）；
 * 2. **清空用 `null`**（服务端 `Object.hasOwn` 判「给了没」，省略 = 不改）；
 * 3. **`enabled` 不进 patch**（服务端启停是独立通道、独立审计）；
 * 4. 非法输入**不发请求**（`"invalid"`）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import * as logicModule from '../app/src/app/(main)/dashboard/_components/account-edit-logic.ts'

import { unwrap } from './helpers/module-interop.ts'

const {
  accountEditDraftOf,
  accountEditError,
  accountEditPlanOf,
  changedFieldLabels,
  isNoopPlan,
} = unwrap<typeof logicModule>(logicModule)

type AccountEditSource = Parameters<typeof accountEditDraftOf>[0]
type AccountEditDraft = ReturnType<typeof accountEditDraftOf>

function accountOf(overrides: Partial<AccountEditSource> = {}): AccountEditSource {
  return {
    label: '主力 Claude',
    email: 'owner@example.com',
    subject: 'sub-1',
    baseUrl: 'https://api.example.com/v1',
    protocol: 'anthropic',
    models: ['claude-sonnet', 'claude-haiku'],
    modelMap: { 'claude-sonnet': 'sonnet-4' },
    priority: 10,
    clientProfile: null,
    enabled: true,
    ...overrides,
  }
}

/** 从账号造一份「什么都没改」的草稿。 */
function draftOf(account: AccountEditSource): AccountEditDraft {
  return accountEditDraftOf(account)
}

// ───────────────────────────── 账号 → 草稿 ─────────────────────────────

test('accountEditDraftOf：模型摊成多行、映射摊成「对外名=上游名」、可空字段变空串', () => {
  const draft = draftOf(
    accountOf({ email: null, subject: null, baseUrl: null, protocol: null, models: null, modelMap: null }),
  )
  assert.equal(draft.email, '')
  assert.equal(draft.subject, '')
  assert.equal(draft.baseUrl, '')
  assert.equal(draft.protocol, '')
  assert.equal(draft.models, '')
  assert.equal(draft.modelMap, '')
  assert.equal(draft.priority, '10')
  assert.equal(draft.enabled, true)
})

test('accountEditDraftOf：不认识的 protocol 归成「同提供商默认」（不让下拉显示空值）', () => {
  const draft = draftOf(accountOf({ protocol: 'weird-proto' }))
  assert.equal(draft.protocol, '')
})

test('accountEditDraftOf：models 与 modelMap 逐个还原', () => {
  const draft = draftOf(accountOf())
  assert.equal(draft.models, 'claude-sonnet\nclaude-haiku')
  assert.equal(draft.modelMap, 'claude-sonnet=sonnet-4')
})

// ───────────────────────────── 只发改了的字段 ─────────────────────────────

test('什么都没改 → patch 为空、enabled 为 null（不发请求）', () => {
  const account = accountOf()
  const plan = accountEditPlanOf(draftOf(account), account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, {})
  assert.equal(plan.enabled, null)
  assert.equal(isNoopPlan(plan), true)
})

test('只改名称 → patch 只有 label', () => {
  const account = accountOf()
  const plan = accountEditPlanOf({ ...draftOf(account), label: '备用号' }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, { label: '备用号' })
  assert.equal(plan.enabled, null)
})

test('只动启用开关 → patch 里没有 enabled，enabled 单独返回 false', () => {
  const account = accountOf({ enabled: true })
  const plan = accountEditPlanOf({ ...draftOf(account), enabled: false }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, {})
  assert.equal(Object.keys(plan.patch).includes('enabled'), false)
  assert.equal(plan.enabled, false)
  assert.deepEqual(changedFieldLabels(plan), ['停用'])
})

test('模型名顺序变了但内容一样 → 不算改动（服务端只用来过滤候选，顺序无语义）', () => {
  const account = accountOf({ models: ['a', 'b'] })
  const plan = accountEditPlanOf({ ...draftOf(account), models: 'b\na' }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, {})
})

// ───────────────────────────── 清空 = null ─────────────────────────────

test('清空邮箱 / 标识 / Base URL → 发 null（真清空），不是省略键', () => {
  const account = accountOf()
  const draft = { ...draftOf(account), email: '', subject: '', baseUrl: '' }
  const plan = accountEditPlanOf(draft, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, { email: null, subject: null, baseUrl: null })
})

test('原本就是 null、草稿还是空 → 不发（少一条空审计）', () => {
  const account = accountOf({
    email: null,
    subject: null,
    baseUrl: null,
    protocol: null,
    models: null,
    modelMap: null,
  })
  const plan = accountEditPlanOf(draftOf(account), account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, {})
})

test('清空模型名与映射 → 两个 null', () => {
  const account = accountOf()
  const plan = accountEditPlanOf({ ...draftOf(account), models: '', modelMap: '' }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, { models: null, modelMap: null })
})

test('协议从 anthropic 改成「同提供商默认」→ protocol: null', () => {
  const account = accountOf({ protocol: 'anthropic' })
  const plan = accountEditPlanOf({ ...draftOf(account), protocol: '' }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, { protocol: null })
})

test('模型映射改一个值 → 整份新映射（不是增量）', () => {
  const account = accountOf({ modelMap: { a: 'x', b: 'y' } })
  const plan = accountEditPlanOf({ ...draftOf(account), modelMap: 'a=x\nb=z' }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(plan.patch, { modelMap: { a: 'x', b: 'z' } })
})

// ───────────────────────────── 非法输入 ─────────────────────────────

test('名称为空 / 超长 → invalid', () => {
  const account = accountOf()
  assert.equal(accountEditPlanOf({ ...draftOf(account), label: '   ' }, account), 'invalid')
  assert.equal(accountEditPlanOf({ ...draftOf(account), label: 'x'.repeat(201) }, account), 'invalid')
})

test('优先级不是 0..1000 的整数 → invalid', () => {
  const account = accountOf()
  assert.equal(accountEditPlanOf({ ...draftOf(account), priority: '-1' }, account), 'invalid')
  assert.equal(accountEditPlanOf({ ...draftOf(account), priority: '1001' }, account), 'invalid')
  assert.equal(accountEditPlanOf({ ...draftOf(account), priority: '1.5' }, account), 'invalid')
})

test('Base URL 不是 http(s) → invalid', () => {
  const account = accountOf()
  assert.equal(accountEditPlanOf({ ...draftOf(account), baseUrl: 'ftp://x' }, account), 'invalid')
})

test('模型映射写成一行非法文本 → invalid（不静默跳过）', () => {
  const account = accountOf()
  assert.equal(accountEditPlanOf({ ...draftOf(account), modelMap: '没有等号' }, account), 'invalid')
})

test('accountEditError 给出人话（每条规则一句）', () => {
  const account = accountOf()
  assert.equal(accountEditError({ ...draftOf(account), label: '' }), '名称不能为空')
  assert.equal(accountEditError({ ...draftOf(account), priority: 'x' }), '优先级要填 0..1000 的整数')
  assert.equal(
    accountEditError({ ...draftOf(account), baseUrl: 'nope' }),
    'Base URL 要填 http(s) 开头的合法地址',
  )
  assert.equal(
    accountEditError({ ...draftOf(account), modelMap: '坏行' }),
    '模型映射每行要写成「对外名=上游名」',
  )
  assert.equal(accountEditError(draftOf(account)), null)
})

// ───────────────────────────── 多字段一起改 ─────────────────────────────

test('多字段一起改：patch 键集合与提示文案都对得上', () => {
  const account = accountOf()
  const plan = accountEditPlanOf(
    {
      ...draftOf(account),
      label: '新名字',
      priority: '20',
      models: 'm1\nm2\nm3',
      enabled: false,
    },
    account,
  )
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(Object.keys(plan.patch).sort(), ['label', 'models', 'priority'])
  assert.deepEqual(plan.patch.models, ['m1', 'm2', 'm3'])
  assert.equal(plan.enabled, false)
  assert.deepEqual(changedFieldLabels(plan), ['名称', '对外模型名', '优先级', '停用'])
  assert.equal(isNoopPlan(plan), false)
})

// ───────────────────────────── 客户端档案 ─────────────────────────────

test('clientProfile：挂档 / 换档 / 清空都进 patch，没变不发', () => {
  const account = accountOf({ clientProfile: null })

  const attached = accountEditPlanOf({ ...draftOf(account), clientProfile: 'opencode' }, account)
  assert.notEqual(attached, 'invalid')
  if (attached === 'invalid') return
  assert.deepEqual(attached.patch, { clientProfile: 'opencode' })

  const switched = accountEditPlanOf({ ...draftOf(account), clientProfile: 'codex' }, accountOf({ clientProfile: 'opencode' }))
  assert.notEqual(switched, 'invalid')
  if (switched === 'invalid') return
  assert.deepEqual(switched.patch, { clientProfile: 'codex' })

  // 清空 = 发 null（服务端用 Object.hasOwn 判「给了没」，省略 != 清空）。
  const cleared = accountEditPlanOf({ ...draftOf(account), clientProfile: '' }, accountOf({ clientProfile: 'opencode' }))
  assert.notEqual(cleared, 'invalid')
  if (cleared === 'invalid') return
  assert.deepEqual(cleared.patch, { clientProfile: null })

  // 原来是 null、现在还是空 → 一个键都不发。
  const untouched = accountEditPlanOf(draftOf(account), account)
  assert.notEqual(untouched, 'invalid')
  if (untouched === 'invalid') return
  assert.deepEqual(untouched.patch, {})
})

test('clientProfile：草稿从账号带出，提示文案叫「客户端档案」', () => {
  const account = accountOf({ clientProfile: 'opencode' })
  assert.equal(draftOf(account).clientProfile, 'opencode')
  const plan = accountEditPlanOf({ ...draftOf(account), clientProfile: '' }, account)
  assert.notEqual(plan, 'invalid')
  if (plan === 'invalid') return
  assert.deepEqual(changedFieldLabels(plan), ['客户端档案'])
})
