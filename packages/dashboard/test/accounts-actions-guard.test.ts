/**
 * 护栏：上游账号页**每一行都必须有操作入口**。
 *
 * 这条来自 owner 上线后抓到的硬伤（2026-11-01）：
 * 「上游账号为什么我不能设置，连删除都删不掉……我甚至无法启用或者禁用账号」。
 * 服务端 `PATCH / DELETE / POST :id/test` **全都有**，客户端函数**也全都有**，
 * 缺的只是页面上的入口 —— 而 `pnpm test` 与 `next build` 都不报这种错。
 *
 * 与 `admin-pages-mounted.test.ts` 的分工：那边管「组件/弹窗有没有被挂上」，
 * 这边管「行操作与批量操作到底走没走对端点」。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const COMPONENTS = join(import.meta.dirname, '..', 'app', 'src', 'app', '(main)', 'dashboard', '_components')

function source(name: string): string {
  return readFileSync(join(COMPONENTS, name), 'utf8')
}

/**
 * 去掉注释后的源码。
 *
 * 「不许出现 localStorage / console」这类否定断言必须看**代码**：
 * 注释里写「不写 localStorage」是说明，不是违规 —— 拿整份文件去正则匹配会误报。
 */
function code(name: string): string {
  return source(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('每行都要有「编辑 / 测试 / 启停 / 删除」四个入口', () => {
  const table = source('accounts-table.tsx')
  const actions = source('account-row-actions.tsx')
  // 表格必须真的挂上行操作组件（写完忘挂 = 页面上啥也没有，这正是被 owner 抓到的那次）。
  assert.match(table, /<AccountRowActions/, 'accounts-table.tsx 没挂 AccountRowActions')
  for (const handler of ['onEdit(account)', 'onCredential(account)', 'onTest(account)', 'onDelete(account)']) {
    assert.ok(actions.includes(handler), `行操作缺少「${handler}」入口`)
  }
  // 启停按钮文案只看 enabled（系统自动停用的语义不在这里表达）。
  assert.ok(actions.includes('{account.enabled ? "停用" : "启用"}'), '启停按钮没按 enabled 给文案')
})

test('测试走详情弹窗：请求提示词 / 响应片段 / 再测一次', () => {
  const actions = source('account-row-actions.tsx')
  assert.ok(actions.includes('onTest(account)'), '行操作没有「测试」入口')
  assert.equal(actions.includes('testAccount('), false, '测试不许在行里直接发（要进详情弹窗）')
  assert.ok(
    /adminUsers\.updateAccount\(api, account\.id, \{ enabled: next \}\)/.test(actions),
    '启停没走 updateAccount + enabled（它必须是单独的 body 键）',
  )

  const dialog = source('account-test-dialog.tsx')
  assert.ok(dialog.includes('adminUsers.testAccount(api, account.id)'), '测试弹窗没调 testAccount')
  assert.ok(dialog.includes('formatDurationMs(result.latencyMs)'), '测试弹窗没显示耗时')
  assert.ok(dialog.includes('HTTP ${String(status)}'), '测试弹窗没显示 HTTP 状态')
  assert.ok(dialog.includes('未拿到 HTTP 响应'), '没拿到响应的情况没单独表达')
  assert.ok(dialog.includes('request.prompt'), '测试弹窗没显示实际发出去的提示词')
  assert.ok(dialog.includes('response.bodySnippet'), '测试弹窗没显示上游响应片段')
  assert.ok(dialog.includes('再测一次'), '测试弹窗没有「再测一次」')
  assert.ok(dialog.includes('max-h-56 overflow-auto'), '长正文没有滚动容器（会把弹窗撑爆）')
  assert.ok(dialog.includes('response.truncated'), '截断时没有提示')
})

test('编辑弹窗：patch 与 enabled 分开（enabled 不进 patch 对象）', () => {
  const dialog = source('account-edit-dialog.tsx')
  // 提交体是「patch 展开 + 顶层 enabled」，不是把 enabled 塞进 patch。
  assert.ok(
    dialog.includes('...plan.patch') && dialog.includes('{ enabled: plan.enabled }'),
    '编辑弹窗没把 enabled 放在 body 顶层',
  )
  assert.ok(dialog.includes('accountEditPlanOf(draft, account)'), '编辑弹窗没用纯逻辑算 patch')
  // 凭据不在这里改：凭据是「只写不读」的独立动作。
  assert.equal(dialog.includes('importAccountCredentials'), false, '编辑弹窗不该碰凭据')
})

test('删除要二次确认，且用自研 AlertDialog（不用浏览器原生 confirm）', () => {
  const dialog = source('account-delete-dialog.tsx')
  assert.ok(dialog.includes('AlertDialog'), '删除没有二次确认弹窗')
  assert.ok(dialog.includes('AlertDialogAction'), '删除确认弹窗没有确认按钮')
  assert.equal(/\bwindow\.confirm\s*\(/.test(dialog), false, '不许用 window.confirm')
  assert.equal(/\bwindow\.alert\s*\(/.test(dialog), false, '不许用 window.alert')
  assert.equal(/<select\b/.test(dialog), false, '不许用原生 <select>')
})

test('批量：启停走 /bulk，删除逐条 DELETE（每条一条审计）', () => {
  const board = source('accounts-board.tsx')
  assert.ok(board.includes('adminUsers.bulkAccounts(api, body)'), '批量启停没走 bulkAccounts')
  assert.ok(board.includes('<AccountsBulkBar'), '批量操作条没挂上')
  // 删除是逐条的：dialog 里调 deleteAccount，不是批量端点。
  const dialog = source('account-delete-dialog.tsx')
  assert.ok(dialog.includes('adminUsers.deleteAccount(api, account.id)'), '删除没逐条调 deleteAccount')
  assert.equal(dialog.includes('bulkAccounts'), false, '删除不该走批量端点（服务端没有 bulkRemove）')
  // 批量失败要说清哪几条失败。
  assert.ok(dialog.includes('bulkFailureLines'), '删除失败没列出失败的账号')
  assert.ok(board.includes('bulkFailureLines(outcome)'), '批量启停失败没列出失败的账号')
})

test('选择态只对本页有效：换筛选 / 换页要清空选择', () => {
  const board = source('accounts-board.tsx')
  const resets = board.match(/resetSelection\(\)/g) ?? []
  // 至少：筛选变化 ×2、上一页、下一页、批量完成后 ×2。
  assert.ok(resets.length >= 5, `清空选择的调用点太少（${String(resets.length)}）`)
})

test('每行也要能导入凭据（服务端一直有 POST :id/credentials，页面没入口就等于没有）', () => {
  const actions = source('account-row-actions.tsx')
  assert.ok(actions.includes('onCredential(account)'), '行操作没有「凭据」入口')

  const dialog = code('account-credential-dialog.tsx')
  // 明文只走 body：payload 是 body 字段，绝不进 URL。
  assert.ok(
    dialog.includes('adminUsers.importAccountCredentials(api, account.id, { payload, format })'),
    '导入凭据没走 importAccountCredentials（payload 必须走 body）',
  )
  assert.equal(dialog.includes('encodeURIComponent(payload)'), false, '凭据不许进 URL')
  assert.equal(dialog.includes('localStorage'), false, '凭据不许落 storage')
  assert.equal(dialog.includes('console.'), false, '凭据不许打 console')
  // 提交成功与关闭弹窗都要清空明文。
  const clears = dialog.match(/setPayload\(""\)/g) ?? []
  assert.ok(clears.length >= 2, `清空明文的调用点太少（${String(clears.length)}）`)
})

test('编辑弹窗不碰凭据（凭据是只写不读的独立动作）', () => {
  const dialog = code('account-edit-dialog.tsx')
  assert.equal(dialog.includes('importAccountCredentials'), false)
  assert.equal(dialog.includes('credentials'), false)
})

test('整页不许出现解释性说明段落（owner 第 4 条）以外的浏览器原生控件', () => {
  for (const file of ['accounts-board.tsx', 'accounts-table.tsx', 'account-row-actions.tsx']) {
    const text = source(file)
    assert.equal(/\bwindow\.confirm\s*\(/.test(text), false, `${file} 用了 window.confirm`)
    assert.equal(/\bwindow\.alert\s*\(/.test(text), false, `${file} 用了 window.alert`)
    assert.equal(/<dialog\b/.test(text), false, `${file} 用了原生 <dialog>`)
  }
})
