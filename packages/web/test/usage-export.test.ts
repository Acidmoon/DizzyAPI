/**
 * 用量 CSV 导出（`GET /console/usage/export.csv`）的用例。
 *
 * **CSV 正文不在这里测**：格式由 `usage` 插件的 `exportCsv` 唯一实现
 * （`packages/usage/src/csv.ts`，护栏在 `packages/usage/test/csv.test.ts`）。
 * 本文件只盯 `web` 这一层的责任：
 *
 * 1. **只导自己的**（`userId` 必传，别人的行一条都不许进请求）；
 * 2. 真下载：`text/csv` + `Content-Disposition: attachment` + `private, no-store`；
 * 3. 未登录 302 / 服务缺失 503（不给空文件）；
 * 4. 筛选条件真的下传，且**正文就是服务返回的那份字节**（不二次加工）。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import { exportFilename, USAGE_EXPORT_PATH } from '../src/usage-export.ts'
import { parseFilters } from '../src/usage-view.ts'
import type { UsageQuery, UsageRow } from '../src/usage-types.ts'

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

class FakeUsage extends Service {
  /** 假 CSV 正文：故意带一个哨兵串，用来证明 web 原样发出、没有二次加工。 */
  static readonly CONTENT = '\uFEFFtime,api_key,model\r\n2026-10-30T01:02:03.000Z,key-1,deepseek-chat'
  readonly queries: UsageQuery[] = []
  readonly rows: UsageRow[] = []

  constructor(ctx: Context) {
    super(ctx, 'usage')
  }

  /** 唯一实现出的 `{ filename, content }`：web 只该拿 `content` 当正文。 */
  exportCsv(query: UsageQuery, _limit?: number) {
    this.queries.push(query)
    return { filename: 'usage-20261030.csv', content: FakeUsage.CONTENT }
  }

  exportRows(query: UsageQuery, limit = 5_000): readonly UsageRow[] {
    this.queries.push(query)
    return this.rows.slice(0, limit)
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

test('导出：200 + text/csv + attachment，正文就是服务返回的那份字节', async (t) => {
  const app = await boot(t)

  const response = await fetchExport(app, '?range=7d')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/csv; charset=utf-8')
  const disposition = response.headers.get('content-disposition') ?? ''
  assert.match(disposition, /^attachment; filename="usage-\d{8}(-\d{8})?\.csv"/)
  assert.match(disposition, /filename\*=UTF-8''/)
  // 按用户生成的数据不能进共享缓存。
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')

  // 原样发出（web 不再二次拼 CSV）。**用字节比**：`response.text()` 走 TextDecoder，
  // 默认会把 BOM 吃掉，用它比较等于从来没验过 BOM。
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.deepEqual(bytes, Buffer.from(FakeUsage.CONTENT, 'utf8'))
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM 必须原样发出')
})

test('导出：未登录 302 到登录页（不是 401，也不是空文件）', async (t) => {
  const app = await boot(t)

  const response = await fetch(`${app.base}${USAGE_EXPORT_PATH}?range=7d`, { redirect: 'manual' })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))
  assert.equal(await response.text(), '')
  assert.equal(app.usage.queries.length, 0, '未登录不该发起任何用量查询')
})

test('导出：用量服务不在运行时给人话 503，不返回空文件', async (t) => {
  const app = await boot(t, false)

  const response = await fetchExport(app, '?range=7d')
  assert.equal(response.status, 503)
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.match(await response.text(), /用量服务未运行/)
})

// ───────────────────────────── 口径 ─────────────────────────────

test('导出：查询必须带会话 userId（不给就是全站口径 = 越权）', async (t) => {
  const app = await boot(t)

  await fetchExport(app, '?range=7d')
  assert.equal(app.usage.queries.length, 1)
  assert.equal(app.usage.queries[0]?.userId, USER_ID)
})

test('导出：筛选条件真的下传（range / model / apiKeyId），不是导全量', async (t) => {
  const app = await boot(t)

  await fetchExport(app, '?range=7d&model=gpt-4o-mini&apiKeyId=key-2')
  const query = app.usage.queries[0]
  assert.equal(query?.model, 'gpt-4o-mini')
  assert.equal(query?.apiKeyId, 'key-2')
  // 时间窗口来自 range 档位，且是个合法区间。
  assert.ok((query?.fromMs ?? 0) < (query?.toMs ?? 0))
})

test('导出：文件名按本地时区，单日只有一个日期段', () => {
  // 页面上的日期一律本地显示；用 UTC 日期当文件名会让 UTC+8 的用户以为导出了昨天的。
  assert.match(exportFilename(parseFilters(new URLSearchParams('range=yesterday'))), /^usage-\d{8}\.csv$/)
  assert.match(exportFilename(parseFilters(new URLSearchParams('range=7d'))), /^usage-\d{8}-\d{8}\.csv$/)
  for (const key of ['today', 'yesterday', '7d', '30d'] as const) {
    const name = exportFilename(parseFilters(new URLSearchParams(`range=${key}`)))
    assert.match(name, /^usage-\d{8}(-\d{8})?\.csv$/, `${key} 的文件名格式不对：${name}`)
  }
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
