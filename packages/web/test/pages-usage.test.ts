/**
 * 用量页（概览 `/console/usage` + 明细 `/console/usage/detail`）的行为用例。
 *
 * 盯住 owner 的四条口径：
 * 1. 概览页**最近请求只 10 条**，完整列表在明细页；
 * 2. 柱状图**恒 7 个时间点**（空桶补 0），支持按模型 / 按 API key 两种维度；
 * 3. 时间维度是显式下拉（今天 / 昨天 / 近 7 天 / 近 30 天），用 `renderSelect`（Tom Select 钩子）；
 * 4. 每行「详情」弹窗展示 模型 / 耗时 / TTFT / 四桶 token / 金额，且金额注明「读取时按价格表计算」。
 *
 * 另外守住两条降级：`?reqId=` 走整页详情（无 JS 路径）、别人的记录一律「没有这条用量记录」。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'
const USER_ID = 1

class FakeAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'auth')
  }

  async verifySession(token: string) {
    if (token !== 'test-token') throw new Error('会话无效')
    return {
      sessionId: 's1',
      userId: USER_ID,
      user: {
        id: USER_ID,
        name: '用户',
        status: 'enabled' as const,
        role: 'user' as const,
        balance: 0n,
        balanceEnabled: false,
        avatar: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
  }

  async logout(): Promise<void> {
    // 用例不关心。
  }
}

interface Row {
  id: number
  reqId: string
  userId: number
  startedAt: string
  model: string
  apiKeyId: string
  apiKeyName: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  usagePresent: boolean
  usageComplete: boolean
  costMicros: string
  durationMs: number
  ttftMs: number | null
  status: number
}

let nextId = 1

function row(overrides: Partial<Row> = {}): Row {
  const id = overrides.id ?? nextId++
  return {
    id,
    reqId: `req-${id}`,
    userId: USER_ID,
    startedAt: new Date().toISOString(),
    model: 'deepseek-chat',
    apiKeyId: 'key-1',
    apiKeyName: '生产 key',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    reasoningTokens: 3,
    totalTokens: 21,
    usagePresent: true,
    usageComplete: true,
    costMicros: '1234567',
    durationMs: 2500,
    ttftMs: 321,
    status: 200,
    ...overrides,
  }
}

interface Query {
  fromMs: number
  toMs: number
  userId?: number
  model?: string
  apiKeyId?: string
  cursor?: number
  limit?: number
}

class FakeUsage extends Service {
  rows: Row[] = []
  /** 记下每次查询：用例据此断言「页面确实传了 userId」，而不是只看输出。 */
  readonly queries: Query[] = []

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  private filter(query: Query): Row[] {
    this.queries.push(query)
    return this.rows
      .filter((item) => Date.parse(item.startedAt) >= query.fromMs && Date.parse(item.startedAt) < query.toMs)
      .filter((item) => query.userId === undefined || item.userId === query.userId)
      .filter((item) => query.model === undefined || item.model === query.model)
      .filter((item) => query.apiKeyId === undefined || item.apiKeyId === query.apiKeyId)
      .sort((a, b) => b.id - a.id)
  }

  private totals(rows: readonly Row[]) {
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheWriteTokens = 0
    let reasoningTokens = 0
    let totalTokens = 0
    let cost = 0n
    for (const item of rows) {
      inputTokens += item.inputTokens
      outputTokens += item.outputTokens
      cacheReadTokens += item.cacheReadTokens
      cacheWriteTokens += item.cacheWriteTokens
      reasoningTokens += item.reasoningTokens
      totalTokens += item.totalTokens
      cost += BigInt(item.costMicros)
    }
    return {
      requests: rows.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens,
      costMicros: cost.toString(),
    }
  }

  summary(query: Query) {
    const rows = this.filter(query)
    const byModel = new Map<string, Row[]>()
    for (const item of rows) {
      const list = byModel.get(item.model) ?? []
      list.push(item)
      byModel.set(item.model, list)
    }
    return {
      totals: this.totals(rows),
      daily: [],
      models: [...byModel.entries()].map(([model, list]) => ({ model, ...this.totals(list) })),
    }
  }

  list(query: Query) {
    const filtered = this.filter(query)
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 200)
    const page = filtered.filter((item) => query.cursor === undefined || item.id < query.cursor).slice(0, limit)
    return {
      items: page,
      nextCursor: page.length === limit && page.length > 0 ? page[page.length - 1]!.id : null,
    }
  }

  get(reqId: string): Row | null {
    return this.rows.find((item) => item.reqId === reqId) ?? null
  }

  exportRows(query: Query, limit = 5000): readonly Row[] {
    return this.filter(query).slice(0, limit)
  }

  stats() {
    const totals = this.totals(this.rows)
    return { today: totals, total: totals, series: [], models: [], topUsers: [] }
  }

  listRejected() {
    return { items: [], total: 0, pending: 0 }
  }

  ignoreRejected(): void {}
  async replayRejected() {
    return { status: 'replayed', inserted: false }
  }
}

interface App {
  readonly base: string
  readonly usage: FakeUsage
}

async function boot(t: TestContext): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    await ctx.plugin(FakeUsage)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: ctx.get('usage') as unknown as FakeUsage,
      port: address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  t.after(async () => {
    await started.close()
  })
  return { base: started.base, usage: started.app }
}

async function page(app: App, path: string): Promise<string> {
  const response = await fetch(`${app.base}${path}`, { headers: { cookie: SESSION_COOKIE }, redirect: 'manual' })
  assert.equal(response.status, 200, `${path} 应 200`)
  return response.text()
}

// ───────────────────────────── 概览 ─────────────────────────────

test('概览：最近请求只 10 条，完整列表给明细页', async (t) => {
  const app = await boot(t)
  for (let index = 0; index < 15; index += 1) app.usage.rows.push(row())

  const html = await page(app, '/console/usage')
  // 详情改成分组键值对之后，reqId 在 dd.kv-value--mono 里（不再是一行表格）。
  // 断言口径不变：概览页只该出现 10 条请求（每条一个详情弹窗）。
  const reqIds = [...html.matchAll(/class="kv-value kv-value--mono">(req-\d+)<\/dd>/g)].map((match) => match[1])
  assert.equal(new Set(reqIds).size, 10, `概览只该有 10 条请求，实际 ${new Set(reqIds).size}`)
  assert.match(html, /查看全部明细/)
  assert.match(html, /\/console\/usage\/detail\?/)
})

test('概览：柱状图恒 7 个时间点（空桶补 0），四种时间档位都在下拉里', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(row())

  const html = await page(app, '/console/usage')
  // X 轴标签：`pickLabelIndexes(7)` 返回全部 7 个索引 → 7 个居中的轴文字。
  const labels = [...html.matchAll(/<text class="axis-text"[^>]*text-anchor="middle"/g)]
  assert.equal(labels.length, 7, '柱状图必须恒 7 个时间点')

  // 时间维度是下拉（renderSelect → 原生 select + data-tom-select 钩子），四档齐全。
  for (const key of ['today', 'yesterday', '7d', '30d']) {
    assert.match(html, new RegExp(`<option value="${key}"`), `缺少时间档位 ${key}`)
  }
  assert.match(html, /name="range"[^>]*data-tom-select|data-tom-select[^>]*name="range"/)
  assert.match(html, /name="model"[^>]*data-tom-select|data-tom-select[^>]*name="model"/)
  assert.match(html, /name="apiKeyId"/)
})

test('概览：按模型 / 按 API key 两种维度都真的分组', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(
    row({ model: 'deepseek-chat', apiKeyName: '生产 key' }),
    row({ model: 'gpt-4o-mini', apiKeyName: '测试 key', apiKeyId: 'key-2' }),
  )

  const byModel = await page(app, '/console/usage?dim=model')
  assert.match(byModel, /deepseek-chat/)
  assert.match(byModel, /gpt-4o-mini/)

  const byKey = await page(app, '/console/usage?dim=key')
  // 柱子的 <title> 里应当出现分组名（不是「消费金额」这个总量口径）。
  assert.match(byKey, /生产 key/)
  assert.match(byKey, /测试 key/)
  assert.match(byKey, /aria-selected="true"[^>]*href="\/console\/usage\?[^"]*dim=key|href="[^"]*dim=key"[^>]*aria-selected="true"/)
})

test('概览：详情弹窗含 TTFT / 四桶 / 金额，且注明金额是读取时算的', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(row({ id: 7, reqId: 'req-detail', ttftMs: 456, durationMs: 3000, costMicros: '2000000' }))

  const html = await page(app, '/console/usage')
  assert.match(html, /id="usage-detail-7"/)
  assert.match(html, /456 ms/, '弹窗要显示首字延迟')
  assert.match(html, /3\.0 s/, '弹窗要显示总耗时')
  assert.match(html, /输入 tokens/)
  assert.match(html, /输出 tokens/)
  assert.match(html, /缓存读 tokens/)
  assert.match(html, /缓存写 tokens/)
  assert.match(html, /推理 tokens/)
  assert.match(html, /2\.00 CNY/)
  assert.match(html, /读取时按价格表计算/)
  // 详情是**分组键值对**（请求 / 令牌 / 费用 / 时间 四小节），不再是「字段 / 值」两列平铺表。
  for (const title of ['请求', '令牌', '费用', '时间']) {
    assert.match(html, new RegExp(`<h3 class="kv-group-title">${title}</h3>`), `详情缺少小节：${title}`)
  }
  assert.ok(!html.includes('>字段</th>'), '详情不该再是「字段 / 值」表格')
  // 「详情」在无 JS 时是普通链接，跳到明细页并带 reqId。
  assert.match(html, /href="\/console\/usage\/detail\?[^"]*reqId=req-detail"[^>]*data-dialog-open="usage-detail-7"/)
})

test('概览：没有采集到 TTFT 的记录显示「—」而不是 0 ms', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(row({ ttftMs: null }))
  const html = await page(app, '/console/usage')
  assert.match(html, /首字延迟（TTFT）<\/dt><dd class="kv-value">—<\/dd>/)
  assert.ok(!html.includes('>0 ms<'), '未采集不能显示 0 ms')
})

// ───────────────────────────── 明细页 ─────────────────────────────

test('明细：完整列表 + keyset 分页 + 筛选条件在链接里保留', async (t) => {
  const app = await boot(t)
  for (let index = 0; index < 25; index += 1) app.usage.rows.push(row())

  const first = await page(app, '/console/usage/detail?range=7d')
  const rowsHtml = [...first.matchAll(/data-dialog-open="usage-detail-(\d+)"/g)]
  assert.equal(rowsHtml.length, 20, '明细页一页 20 条')
  assert.match(first, /下一页/)
  assert.match(first, /cursor=/)

  const nextCursor = app.usage.list({ fromMs: 0, toMs: Date.now() + 1, limit: 20 }).nextCursor
  assert.ok(nextCursor !== null)
  const second = await page(app, `/console/usage/detail?range=7d&cursor=${nextCursor}`)
  const secondIds = [...second.matchAll(/data-dialog-open="usage-detail-(\d+)"/g)].map((match) => Number(match[1]))
  assert.equal(secondIds.length, 5)
  assert.ok(secondIds.every((id) => id < (nextCursor as number)), '第二页只能更旧')
  assert.match(second, /回到最新/)
})

test('明细：?reqId= 走整页详情（无 JS 路径），别人的记录一律拒绝', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(
    row({ id: 11, reqId: 'mine', userId: USER_ID, ttftMs: 222 }),
    row({ id: 12, reqId: 'other', userId: 99 }),
  )

  const mine = await page(app, '/console/usage/detail?range=7d&reqId=mine')
  assert.match(mine, /请求详情/)
  assert.match(mine, /222 ms/)
  assert.match(mine, /关闭详情/)

  const other = await page(app, '/console/usage/detail?range=7d&reqId=other')
  assert.match(other, /没有这条用量记录/)
  assert.ok(!other.includes('关闭详情'), '别人的记录不能渲染详情区块（详情区块才有「关闭详情」）')
})

test('明细：按模型 / 按 API key 筛选真的传给服务（不留假成功）', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(
    row({ model: 'deepseek-chat', apiKeyId: 'key-1', apiKeyName: '生产 key' }),
    row({ model: 'gpt-4o-mini', apiKeyId: 'key-2', apiKeyName: '测试 key' }),
  )

  const filtered = await page(app, '/console/usage/detail?range=7d&model=gpt-4o-mini')
  assert.match(filtered, /gpt-4o-mini/)
  assert.ok(!filtered.includes('<td>deepseek-chat</td>'), '按模型筛选后表格里不该出现别的模型（下拉选项里可以有）')

  const byKey = await page(app, '/console/usage/detail?range=7d&apiKeyId=key-1')
  assert.match(byKey, /生产 key/)
  assert.ok(!byKey.includes('<td>测试 key</td>'), '按 key 筛选后表格里不该出现别的 key（下拉选项里可以有）')
})

// ───────────────────────────── 越权（回归） ─────────────────────────────

test('越权回归：两页的查询都必须带会话 userId，别人的用量一个字都不许出现', async (t) => {
  // 这是 2026-10-30 修掉的真漏洞：`usage.list/summary/exportRows` 在**不给 userId**
  // 时是全站口径（那是管理面的语义）。页面漏传就等于把所有人的用量摊给任意登录用户看。
  // 断言方式：别人的行带上独有标记，两页 HTML 里都不能出现。
  const app = await boot(t)
  app.usage.rows.push(
    row({ id: 21, reqId: 'mine-1', userId: USER_ID, model: 'my-model', apiKeyName: '我的 key' }),
    row({ id: 22, reqId: 'other-1', userId: 99, model: 'others-model', apiKeyName: '别人的 key' }),
    row({ id: 23, reqId: 'other-2', userId: 99, model: 'others-model', apiKeyName: '别人的 key' }),
  )

  for (const path of ['/console/usage', '/console/usage/detail?range=7d']) {
    app.usage.queries.length = 0
    const html = await page(app, path)
    assert.ok(html.includes('my-model'), `${path}：自己的记录必须出现`)
    assert.ok(!html.includes('others-model'), `${path}：别人的模型名泄露了`)
    assert.ok(!html.includes('别人的 key'), `${path}：别人的 key 名泄露了`)
    assert.ok(!html.includes('other-1') && !html.includes('other-2'), `${path}：别人的 reqId 泄露了`)
    // 双向钉死：光看输出没泄露不够，还要确认每一次查询都带了会话 userId。
    // （以后加新查询忘了传 userId，这条会红，而不是等用户报「能看到别人的量」。）
    assert.ok(app.usage.queries.length > 0, `${path}：一次查询都没发生？`)
    const missing = app.usage.queries.filter((query) => query.userId !== USER_ID)
    assert.equal(missing.length, 0, `${path}：有 ${missing.length} 次查询没带 userId（全站口径）`)
  }
})

test('越权回归：别人的用量不进统计卡 / 图 / 下拉选项（不只是不进表格）', async (t) => {
  // 光把行过滤掉不够：汇总数字、7 个时间点的柱子、模型与 key 的下拉选项
  // 都是从「同一个查询」来的，任何一处漏传 userId 都会把别人的量算进来。
  const app = await boot(t)
  app.usage.rows.push(
    row({ id: 31, userId: USER_ID, costMicros: '1000000', model: 'my-model', apiKeyName: '我的 key' }),
    // 别人的 9 元：如果被算进汇总，概览的「消费金额」就会变成 ¥10.00 而不是 ¥1.00。
    row({ id: 32, userId: 99, costMicros: '9000000', model: 'others-model', apiKeyName: '别人的 key' }),
  )

  const overview = await page(app, '/console/usage')
  assert.match(overview, /¥1\.00/, '汇总金额只该算自己的（¥1.00）')
  assert.ok(!overview.includes('¥10.00'), '汇总金额把别人的用量算进来了')
  assert.ok(!overview.includes('others-model'), '模型下拉选项里出现了别人的模型')
  assert.ok(!overview.includes('别人的 key'), 'key 下拉选项里出现了别人的 key')
})

