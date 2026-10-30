/**
 * routeApi 的**判定顺序**是不变量（AGENTS.md §5.6）。
 *
 * 拆 `http.ts` 时最容易静默打挂的是顺序：`/api/usage/export` 必须排在 `/api/usage/:reqId`
 * 之前（固定子路径不能被当成 reqId），`/api/keys/:id/rotate` 与 `/api/keys/:id` 同理。
 * 这些判定全是 `if` 链，typecheck 查不出来，跑通一遍全量测试也未必覆盖到每一对。
 * 所以这里直接从**源码**读出判定顺序，把它钉成一张表。
 *
 * 这个用例是纯静态断言，不起进程（起进程打真 HTTP 的是 server.test.ts）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const httpSource = readFileSync(resolve(here, '../src/http.ts'), 'utf8')

/** 取 `routeApi` 的函数体（从声明行起，按花括号配平）。 */
function routeApiBody(): string {
  const lines = httpSource.split('\n')
  const start = lines.findIndex((line) => /^\s*private async routeApi\(/.test(line))
  assert.ok(start >= 0, 'http.ts 里找不到 routeApi 的声明')
  let depth = 0
  let started = false
  const body: string[] = []
  for (let index = start; index < lines.length; index += 1) {
    body.push(lines[index])
    for (const char of lines[index]) {
      if (char === '{') {
        depth += 1
        started = true
      } else if (char === '}') depth -= 1
    }
    if (started && depth === 0) break
  }
  return body.join('\n')
}

/**
 * 判定链里每一段「条件 + 调用的路由函数」。
 * 条件取 `parts[...]` 的字面量比较，调用取第一个路由函数名。
 */
function dispatchChain(): { condition: string; target: string }[] {
  const body = routeApiBody()
  const chain: { condition: string; target: string }[] = []
  // 每一段：if (cond) { ... target(...) ... }
  for (const match of body.matchAll(/if \(([^)]*)\) \{\n([\s\S]*?)\n    \}/g)) {
    const condition = match[1].replace(/\s+/g, ' ')
    const target = /\b(route[A-Za-z]+|usage[A-Za-z]*|health|adminStats|catalogModules)\(/.exec(match[2])?.[1]
    if (target === undefined) continue
    chain.push({ condition, target })
  }
  return chain
}

test('routeApi 判定顺序：usage/export 早于 usage/:reqId', () => {
  const chain = dispatchChain()
  const indexOf = (predicate: (item: { condition: string; target: string }) => boolean): number =>
    chain.findIndex(predicate)

  const exportAt = indexOf((item) => item.condition.includes("parts[1] === 'export'"))
  const detailAt = indexOf((item) => item.target === 'usageDetail')
  assert.ok(exportAt >= 0, `判定链里找不到 usage/export，实际链：${JSON.stringify(chain)}`)
  assert.ok(detailAt >= 0, `判定链里找不到 usageDetail，实际链：${JSON.stringify(chain)}`)
  assert.ok(exportAt < detailAt, 'usage/export 必须排在 usage/:reqId 之前（固定子路径不能被当成 reqId）')
})

test('keys 的子路径判定：rotate 用 parts.length === 3，与 :id 的 parts.length === 2 互斥', () => {
  const keysSource = readFileSync(resolve(here, '../src/routes/keys.ts'), 'utf8')
  // `:id/rotate` 是三段路径，`:id` 是两段 —— **长度互斥**，所以顺序不构成歧义：
  // `/api/keys/abc` 只会进 :id 分支，`/api/keys/abc/rotate` 只会进 rotate 分支。
  // 这里钉的是「互斥」这个性质，不是先后（先后是历史遗留，语义不依赖它）。
  assert.ok(
    keysSource.includes("parts.length === 3 && parts[2] === 'rotate'"),
    "keys.ts 里找不到 parts.length === 3 && parts[2] === 'rotate' 的判定",
  )
  assert.ok(
    keysSource.includes('parts.length === 2'),
    'keys.ts 里找不到 parts.length === 2 的 :id 判定',
  )
  // 两处判定必须用不同的长度，否则 `/api/keys/abc/rotate` 会被 :id 分支吃掉。
  const rotateAt = keysSource.indexOf("parts.length === 3 && parts[2] === 'rotate'")
  const idAt = keysSource.indexOf('parts.length === 2')
  assert.ok(rotateAt >= 0 && idAt >= 0)
  assert.notEqual(
    keysSource.slice(idAt, idAt + 40).includes("parts[2] === 'rotate'"),
    true,
    ':id 与 :id/rotate 的长度判定必须不同（互斥）',
  )
})

test('routeApi 判定顺序：整条链逐条比对，不许悄悄插队', () => {
  const chain = dispatchChain()
  const actual = chain.map((item) => `${item.target}@${item.condition}`)
  const expected = [
    'health@parts.length === 1 && parts[0] === \'health\'',
    'routeAuth@parts[0] === \'auth\'',
    'routeProfile@parts[0] === \'profile\'',
    'routeKeys@parts[0] === \'keys\'',
    'usage@parts.length === 1 && parts[0] === \'usage\'',
    'usageExport@parts.length === 2 && parts[0] === \'usage\' && parts[1] === \'export\'',
    'usageDetail@parts.length === 2 && parts[0] === \'usage\'',
    'routePricing@parts[0] === \'pricing\'',
    'routeModels@parts.length === 1 && parts[0] === \'models\'',
    'routeTopup@parts[0] === \'topup\'',
    'routeRedeem@parts[0] === \'redeem\'',
    'routeAdminRedeemCodes@parts[0] === \'admin\' && parts[1] === \'redeem-codes\'',
    'routeAdminRedeemBatches@parts[0] === \'admin\' && parts[1] === \'redeem-batches\'',
    'routeAdminRedeemStats@parts[0] === \'admin\' && parts[1] === \'redeem-stats\'',
    'routeAdminBilling@parts[0] === \'admin\' && parts[1] === \'billing\'',
    'routeAdminTopupOrders@parts[0] === \'admin\' && parts[1] === \'topup-orders\'',
    'routeAdminAudit@parts[0] === \'admin\' && parts[1] === \'audit\'',
    'routeAdminContentAudit@parts[0] === \'admin\' && parts[1] === \'content-audit\'',
    'routeAdminObservability@parts.length === 2 && parts[0] === \'admin\' && parts[1] === \'observability\'',
    'routeAdminUsage@parts[0] === \'admin\' && parts[1] === \'usage\'',
    'adminStats@parts.length === 2 && parts[0] === \'admin\' && parts[1] === \'stats\'',
    'routeUsers@parts[0] === \'users\'',
    'routeAccounts@parts[0] === \'accounts\'',
    'catalogModules@parts.length === 2 && parts[0] === \'catalog\' && parts[1] === \'modules\'',
    'routeSettings@parts[0] === \'settings\'',
  ]
  assert.deepEqual(actual, expected)
})

test('routeApi 判定顺序：每个管理面前缀都必须自己先 requireAdmin（不许依赖上游鉴权）', () => {
  const body = routeApiBody()
  // 管理面前缀：分发里只负责转发，鉴权在 routes/* 里自己做。
  const adminTargets = [
    'routeAdminRedeemCodes', 'routeAdminRedeemBatches', 'routeAdminRedeemStats',
    'routeAdminBilling', 'routeAdminTopupOrders', 'routeAdminAudit',
    'routeAdminContentAudit', 'routeAdminObservability', 'routeAdminUsage',
    'routeUsers', 'routeAccounts', 'routeSettings',
  ]
  for (const target of adminTargets) {
    assert.ok(body.includes(`${target}(`), `routeApi 里没有 ${target} 的调用`)
  }
  // 分发层不自己调 requireAdmin（那样就变成「上游已经鉴权过」的假设）。
  assert.ok(!/await this\.requireAdmin\(/.test(body), 'routeApi 不该自己鉴权')
})
