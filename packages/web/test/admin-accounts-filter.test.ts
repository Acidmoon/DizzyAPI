/**
 * 上游账号列表页的**信息架构**测试（不起 HTTP）：筛选在上、列表在下、操作收进「编辑」。
 *
 * owner 第 9 条要的是 sub2api 那种「先条件、后结果」。这里盯住两件事：
 * 1. 筛选条件真的进了服务层（页面原来一律 `list({})`，条件等于没做）；
 * 2. 行上不再有启用 / 停用 / 测试 / 删除按钮，只剩一个「编辑」链接。
 *
 * 行为（停用走 disable 而不是 update）在 `admin-accounts.test.ts` 里，那份起真 HTTP。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminAccountsPage } from '../src/pages/admin_accounts.ts'
import { emptyServices, renderPage } from './helpers/page-fixture.ts'
import type { AccountListItem, AccountListQuery, WebRuntime } from '../src/runtime.ts'

const ITEM: AccountListItem = {
  id: 'acc-1',
  label: '主账号',
  provider: 'custom',
  kind: 'api_key',
  enabled: true,
  status: 'active',
  credentialConfigured: true,
  priority: 3,
  labels: ['tier:pro'],
  weight: 2.5,
  concurrency: 4,
  health: 'degraded',
  autoDisabledAt: null,
  autoDisabledReason: null,
  lastUsedAt: '2026-10-27T10:00:00.000Z',
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
  lastTestLatencyMs: null,
}

/** 门面桩：只实现列表页会调到的 `list`，并把每次收到的筛选条件记下来。 */
function accountAdminSpy(): NonNullable<WebRuntime['accountAdmin']> & {
  readonly queries: readonly AccountListQuery[]
} {
  const queries: AccountListQuery[] = []
  return {
    queries,
    list(query?: AccountListQuery) {
      if (query !== undefined) queries.push(query)
      return [ITEM]
    },
  } as unknown as NonNullable<WebRuntime['accountAdmin']> & { readonly queries: readonly AccountListQuery[] }
}

function servicesWith(admin: NonNullable<WebRuntime['accountAdmin']>): WebRuntime {
  return { ...emptyServices(), accountAdmin: admin }
}

test('筛选：条件从查询串读出来，并真的传给服务层', async () => {
  const admin = accountAdminSpy()
  await renderPage(adminAccountsPage, servicesWith(admin), 'search=main&labels=tier%3Apro%2C+team%3Aops&health=degraded&enabled=0')

  // 页面会调两次 list：一次无条件（拿总数）、一次带条件（拿列表）。
  const filtered = admin.queries.filter((query) => Object.keys(query).length > 0)
  assert.deepEqual(filtered, [
    { search: 'main', labels: ['tier:pro', 'team:ops'], health: 'degraded', enabled: false },
  ])
})

test('筛选：不认识的条件不往服务层传（只有四类合法键）', async () => {
  const admin = accountAdminSpy()
  await renderPage(adminAccountsPage, servicesWith(admin), 'search=&labels=&health=bogus&enabled=2')

  assert.equal(admin.queries.length > 0, true)
  assert.equal(
    admin.queries.every((query) => Object.keys(query).length === 0),
    true,
    '空串与非法值一律当「不筛」',
  )
})

test('信息架构：筛选表单在上、账号列表在下', async () => {
  const html = await renderPage(adminAccountsPage, servicesWith(accountAdminSpy()), 'search=main')

  const filterAt = html.indexOf('method="get"')
  const tableAt = html.indexOf('<table')
  assert.ok(filterAt >= 0, '要有筛选表单')
  assert.ok(tableAt > filterAt, '筛选必须在列表之前')
  assert.ok(html.includes('value="main"'), '搜索词要回填')
})

test('行上只剩「编辑」：启用 / 停用 / 测试 / 删除都不再是行内按钮', async () => {
  const html = await renderPage(adminAccountsPage, servicesWith(accountAdminSpy()))

  assert.ok(html.includes('href="/admin/accounts/detail?id=acc-1"'), '「编辑」跳到详情页')
  for (const action of ['action=enable', 'action=disable', 'action=test', 'action=remove']) {
    assert.equal(html.includes(`/admin/accounts?${action}`), false, `行上不该再有 ${action} 按钮`)
  }
})
