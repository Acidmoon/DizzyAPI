/**
 * 用量 CSV 导出（`GET /console/usage/export.csv`）的用例。
 *
 * 为什么单独一个文件：导出是**路由 + 文件格式**，不是页面渲染；
 * 和 `pages-usage.test.ts` 里那堆 HTML 断言混在一起会看不出「导出到底验了什么」。
 *
 * 盯住四件事：
 * 1. **只导自己的**（`userId` 必传，别人的行一条都不许进文件）；
 * 2. 真下载：`text/csv` + `Content-Disposition: attachment`，且**不需要任何脚本**；
 * 3. 格式：UTF-8 BOM、CRLF、RFC 4180 转义、`= + - @` 前导 `'` 防公式注入；
 * 4. `ttftMs` 为 null 时留**空单元格**（不是 0），与页面显示「—」同口径。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import {
  USAGE_CSV_HEADER,
  USAGE_EXPORT_PATH,
  exportFilename,
  usageCsv,
} from '../src/usage-export.ts'
import { parseFilters } from '../src/usage-view.ts'
import type { UsageRow } from '../src/usage-types.ts'

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
        concurrencyLimit: null,
        avatar: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
  }

  async logout(): Promise<void> {}
}

interface Query {
  fromMs: number
  toMs: number
  userId?: number
  model?: string
  apiKeyId?: string
}

class FakeUsage extends Service {
  readonly rows: UsageRow[] = []
  readonly queries: Query[] = []

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  exportRows(query: Query, limit = 5_000): readonly UsageRow[] {
    this.queries.push(query)
    return this.rows
      .filter((row) => query.userId === undefined || row.userId === query.userId)
      .filter((row) => query.model === undefined || row.model === query.model)
      .filter((row) => query.apiKeyId === undefined || row.apiKeyId === query.apiKeyId)
      .slice(0, limit)
  }

  summary() {
    return { totals: {}, daily: [], models: [] }
  }

  list() {
    return { items: [], nextCursor: null }
  }

  get() {
    return null
  }

  stats() {
    return { today: {}, total: {}, models: [] }
  }

  listRejected() {
    return { items: [], total: 0, pending: 0 }
  }

  ignoreRejected(): void {}
  async replayRejected() {
    return { status: 'replayed', inserted: false }
  }
}

function row(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    id: 1,
    reqId: 'req-1',
    userId: USER_ID,
    startedAt: '2026-10-30T01:02:03.000Z',
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

interface App {
  readonly base: string
  readonly usage: FakeUsage
}

async function boot(t: TestContext, withUsage = true): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    if (withUsage) await ctx.plugin(FakeUsage)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: ctx.get('usage', false) as unknown as FakeUsage,
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

async function fetchExport(app: App, query = ''): Promise<Response> {
  return fetch(`${app.base}${USAGE_EXPORT_PATH}${query}`, {
    headers: { cookie: SESSION_COOKIE },
    redirect: 'manual',
  })
}

// ───────────────────────────── 真下载 ─────────────────────────────

test('导出：200 + text/csv + attachment，一次请求就拿到文件（不依赖脚本）', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(row())

  const response = await fetchExport(app, '?range=7d')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8')
  const disposition = response.headers.get('content-disposition') ?? ''
  assert.match(disposition, /^attachment; filename="usage-\d{8}(-\d{8})?\.csv"/)
  assert.match(disposition, /filename\*=UTF-8''/)
  // 按用户生成的数据不能进共享缓存。
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')

  // BOM 必须看**字节**：`response.text()` 走 TextDecoder，默认会把 BOM 吃掉，
  // 用字符串判断永远看不到它，等于这条断言从来没生效过。
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV 必须以 UTF-8 BOM 开头（Excel 认中文）')
  const body = bytes.toString('utf8').replace(/^\uFEFF/, '')
  assert.equal(body.split('\r\n')[0], USAGE_CSV_HEADER.join(','))
})

test('导出：未登录 302 到登录页（不是 401，也不是空文件）', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(row())

  const response = await fetch(`${app.base}${USAGE_EXPORT_PATH}?range=7d`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))
  assert.equal(await response.text(), '')
})

test('导出：用量服务不在运行时给人话 503，不返回空 CSV', async (t) => {
  const app = await boot(t, false)

  const response = await fetchExport(app, '?range=7d')
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.match(await response.text(), /用量服务未运行/)
})

// ───────────────────────────── 只导自己的 ─────────────────────────────

test('导出：只导自己的行，别人的一条都不许进文件', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(
    row({ id: 1, reqId: 'mine', userId: USER_ID, model: 'my-model' }),
    row({ id: 2, reqId: 'other', userId: 99, model: 'others-model' }),
  )

  const body = await (await fetchExport(app, '?range=7d')).text()
  assert.match(body, /my-model/)
  assert.ok(!body.includes('others-model'), '别人的模型名进了导出文件')
  assert.ok(!body.includes('req-'), '导出里出现了别人的 reqId？')
  // 双向钉死：查询必须带会话 userId（`usage` 服务不给 userId 就是全站口径）。
  assert.equal(app.usage.queries.length, 1)
  assert.equal(app.usage.queries[0]?.userId, USER_ID)
})

test('导出：筛选条件真的下传（model / apiKeyId），不是导全量', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(
    row({ id: 1, model: 'deepseek-chat', apiKeyId: 'key-1' }),
    row({ id: 2, model: 'gpt-4o-mini', apiKeyId: 'key-2' }),
  )

  const byModel = await (await fetchExport(app, '?range=7d&model=gpt-4o-mini')).text()
  assert.match(byModel, /gpt-4o-mini/)
  assert.ok(!byModel.includes('deepseek-chat'))
  assert.equal(app.usage.queries[0]?.model, 'gpt-4o-mini')

  app.usage.queries.length = 0
  await fetchExport(app, '?range=7d&apiKeyId=key-1')
  assert.equal(app.usage.queries[0]?.apiKeyId, 'key-1')
})

// ───────────────────────────── 格式 ─────────────────────────────

test('导出：TTFT 没采集时留空单元格（不是 0），与页面「—」同口径', async (t) => {
  const app = await boot(t)
  app.usage.rows.push(row({ ttftMs: null }), row({ id: 2, ttftMs: 0 }))

  const lines = (await (await fetchExport(app, '?range=7d')).text())
    .replace(/^\uFEFF/, '')
    .split('\r\n')
  assert.equal(lines.length, 3, '表头 + 两条数据')
  // 倒数第 2 列是 ttft_ms（最后一列是 client_ip 占位）。
  const cellsOf = (line: string): string[] => line.split(',')
  assert.equal(cellsOf(lines[1]!)[11], '', '没采集 → 空单元格')
  assert.equal(cellsOf(lines[2]!)[11], '0', '真 0ms 必须写成 0（与「没采集」区分）')
})

test('导出：公式注入前缀 `\'`、逗号引号换行按 RFC 4180 转义', () => {
  const body = usageCsv([
    row({ model: '=HYPERLINK("http://evil")' }),
    row({ id: 2, model: 'a,b"c' }),
    row({ id: 3, model: '+cmd' }),
    row({ id: 4, model: '-1+1' }),
    row({ id: 5, model: '@SUM(1)' }),
    row({ id: 6, model: 'line\nbreak' }),
    row({ id: 7, apiKeyName: '', apiKeyId: 'key-raw' }),
  ])
  const lines = body.replace(/^\uFEFF/, '').split('\r\n').slice(1)
  // 模型在 CSV 的第 3 列（下标 2）。
  assert.ok(lines[0]!.includes(`"'=HYPERLINK(""http://evil"")"`), `公式没被中和：${lines[0]}`)
  assert.ok(lines[1]!.includes('"a,b""c"'), `逗号/引号没转义：${lines[1]}`)
  assert.ok(lines[2]!.includes("'+cmd"), `+ 开头没中和：${lines[2]}`)
  assert.ok(lines[3]!.includes("'-1+1"), `- 开头没中和：${lines[3]}`)
  assert.ok(lines[4]!.includes("'@SUM(1)"), `@ 开头没中和：${lines[4]}`)
  // 换行会被引号包住，所以 split 后那条数据被拆成两行——检查原始正文里带引号版本。
  assert.ok(body.includes('"line\nbreak"'), '换行没按 RFC 4180 包引号')
  // key 名为空时回落 key id。
  assert.ok(lines.at(-1)!.includes('key-raw'), 'API key 名为空时该回落 key id')
})

test('导出：文件名的日期范围与时间档位对得上', () => {
  for (const key of ['today', 'yesterday', '7d', '30d'] as const) {
    const filters = parseFilters(new URLSearchParams(`range=${key}`))
    const name = exportFilename(filters)
    assert.match(name, /^usage-\d{8}(-\d{8})?\.csv$/, `${key} 的文件名格式不对：${name}`)
  }
  // 单日档位只有一个日期段。
  assert.match(exportFilename(parseFilters(new URLSearchParams('range=yesterday'))), /^usage-\d{8}\.csv$/)
  // 近 7 天跨天，两段。
  assert.match(exportFilename(parseFilters(new URLSearchParams('range=7d'))), /^usage-\d{8}-\d{8}\.csv$/)
})

// ───────────────────────────── 页面上的入口 ─────────────────────────────

test('明细页：导出是普通链接（带当前筛选），不是脚本钩子', async (t) => {
  const app = await boot(t)
  const html = await (await fetch(`${app.base}/console/usage/detail?range=7d&model=deepseek-chat`, {
    headers: { cookie: SESSION_COOKIE },
  })).text()
  assert.match(html, /导出 CSV/)
  assert.match(html, /href="\/console\/usage\/export\.csv\?range=7d(&amp;|&)[^"]*model=deepseek-chat/)
  assert.ok(!html.includes('data-export'), '导出不该依赖 data-export 脚本钩子（那条钩子没有处理器）')
})
