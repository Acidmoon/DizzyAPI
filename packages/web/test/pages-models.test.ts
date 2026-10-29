/**
 * 模型广场页（`/console/models`）的渲染测试（不起 HTTP）。
 *
 * 只验证渲染层：服务缺失说人话、价格按整数微元换算成元（无浮点误差）、
 * 可用性 / 不可用原因 / 覆盖度都渲染出来、过滤链接与表单保留查询参数、
 * 以及**所有来自账号与价格表的文本都被转义**。
 * 聚合逻辑本身由 `packages/modelhub` 的测试覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { modelsPage } from '../src/pages/models.ts'
import { parseYuanToMicros } from '../src/forms.ts'
import type { PageContext } from '../src/layout.ts'
import type { ModelCatalogView, ModelHubLike, SessionView, WebRuntime } from '../src/runtime.ts'

const SESSION: SessionView = {
  sessionId: 'session-1',
  userId: 7,
  user: {
    id: 7,
    name: 'alice',
    status: 'enabled',
    role: 'user',
    balance: 2_500_000n,
    balanceEnabled: true,
    avatar: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  expiresAt: '2099-10-19T00:00:00.000Z',
}

const EMPTY_SERVICES: WebRuntime = {
  user: undefined,
  auth: undefined,
  apiKey: undefined,
  usage: undefined,
  pricing: undefined,
  modelhub: undefined,
  settings: undefined,
  catalog: undefined,
  accountAdmin: undefined,
  redeem: undefined,
  billing: undefined,
  topup: undefined,
  fontSmiley: undefined,
  audit: undefined,
  observability: undefined,
  contentAudit: undefined,
}

function pageContext(services: WebRuntime, query = '', template: PageTemplateService): PageContext {
  return {
    path: '/console/models',
    title: '模型广场',
    query: new URLSearchParams(query),
    user: SESSION,
    t: template,
    services,
    notice: null,
    takeSecret: () => undefined,
  }
}

async function templateOf(): Promise<PageTemplateService> {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  return ctx.get('pageTemplate') as PageTemplateService
}

function priceOf(input: string, output: string, patch: Partial<ModelCatalogView['available'][number]['price']> = {}) {
  return {
    inputPerMillion: input,
    outputPerMillion: output,
    cacheReadPerMillion: '0',
    cacheWritePerMillion: '0',
    currency: 'CNY',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...patch,
  }
}

/** 目录桩：只实现页面会调到的方法，并记录查询条件。 */
function modelhubStub(): ModelHubLike & { readonly queries: unknown[] } {
  const queries: unknown[] = []
  return {
    queries,
    catalog(query) {
      queries.push(query)
      return {
        available: [
          {
            model: 'deepseek-chat',
            priced: true,
            price: priceOf('2', '8', { cacheReadPerMillion: '0.5' }),
            accountCount: 3,
            healthyAccountCount: 2,
            protocols: ['openai-chat', 'anthropic'],
            upstreamModels: ['deepseek-chat-2026'],
            mapped: true,
          },
          {
            model: 'free-model',
            priced: false,
            price: null,
            accountCount: 1,
            healthyAccountCount: 1,
            protocols: [],
            upstreamModels: [],
            mapped: false,
          },
        ],
        unavailable: [
          {
            model: 'expensive-model',
            reason: 'no_healthy_account',
            detail: '提供这个模型的账号当前都不可用（停用、凭据缺失或健康检查未通过）',
            accountCount: 1,
            price: priceOf('3.75', '15'),
            priced: true,
          },
        ],
        summary: { total: 3, availableCount: 2, unavailableCount: 1, pricedCount: 2, accountCount: 4 },
      }
    },
  }
}

test('模型广场：服务缺失时说人话，不白屏', async () => {
  const template = await templateOf()
  const html = await modelsPage.render(pageContext(EMPTY_SERVICES, '', template))
  assert.match(html, /模型广场服务未运行/)
})

test('模型广场：价格按整数微元换算成元，可用性与覆盖度都渲染', async () => {
  const template = await templateOf()
  const html = await modelsPage.render(
    pageContext({ ...EMPTY_SERVICES, modelhub: modelhubStub() }, '', template),
  )

  // 2 元 / 百万 token → ¥2.00；3.75 → ¥3.75（整数微元换算，不经浮点）。
  assert.match(html, /¥2\.00/)
  assert.match(html, /¥8\.00/)
  assert.match(html, /¥0\.50/)
  assert.match(html, /¥3\.75/)
  assert.match(html, /¥15\.00/)

  assert.match(html, /deepseek-chat/)
  assert.match(html, /free-model/)
  assert.match(html, /expensive-model/)
  assert.match(html, /已定价/)
  assert.match(html, /未定价/)
  assert.match(html, /可用/)
  assert.match(html, /不可用/)
  assert.match(html, /没有账号声明|不可用（停用/)

  // 覆盖度与协议。
  assert.match(html, /2\/3/, '健康 / 总账号数要渲染出来')
  assert.match(html, /openai-chat \/ anthropic/)
  assert.match(html, /未声明/, '没声明协议的模型要有明确文案')
  assert.match(html, /deepseek-chat-2026/, '被映射到上游名时要显示出来')

  // 统计卡。
  assert.match(html, /可用模型/)
  assert.match(html, /已定价/)
  assert.ok(!html.includes('undefined'))
})

test('模型广场：过滤条件透传给服务，并从查询串回填', async () => {
  const template = await templateOf()
  const stub = modelhubStub()
  const html = await modelsPage.render(
    pageContext({ ...EMPTY_SERVICES, modelhub: stub }, 'search=deep&availability=available&priced=priced', template),
  )
  assert.deepEqual(stub.queries.at(-1), {
    search: 'deep',
    availability: 'available',
    priced: 'priced',
  })
  // 搜索框回填。
  assert.match(html, /value="deep"/)
  // 过滤链接保留其它参数（避免点一个筛选就把别的条件清掉）。
  assert.match(html, /href="\/console\/models\?search=deep&amp;availability=unavailable&amp;priced=priced"/)
})

test('模型广场：账号/价格里的文本一律转义（不能当 HTML 执行）', async () => {
  const template = await templateOf()
  const stub: ModelHubLike = {
    catalog() {
      return {
        available: [
          {
            model: '<script>alert(1)</script>',
            priced: true,
            price: priceOf('1', '2'),
            accountCount: 1,
            healthyAccountCount: 1,
            protocols: ['<b>proto</b>'],
            upstreamModels: ['<img src=x>'],
            mapped: true,
          },
        ],
        unavailable: [
          {
            model: 'bad',
            reason: 'no_account',
            detail: '<script>alert(2)</script>',
            accountCount: 0,
            price: null,
            priced: false,
          },
        ],
        summary: { total: 2, availableCount: 1, unavailableCount: 1, pricedCount: 1, accountCount: 1 },
      }
    },
  }
  const html = await modelsPage.render(pageContext({ ...EMPTY_SERVICES, modelhub: stub }, '', template))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(!html.includes('<script>alert(2)</script>'))
  assert.ok(!html.includes('<b>proto</b>'))
  assert.ok(!html.includes('<img src=x>'))
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
})

test('价格换算：元 / 百万 token 的十进制字符串 → 微元永远精确', () => {
  // 这些是最容易出浮点误差的值。
  assert.equal(parseYuanToMicros('0.1'), 100_000n)
  assert.equal(parseYuanToMicros('0.3'), 300_000n)
  assert.equal(parseYuanToMicros('3.75'), 3_750_000n)
  assert.equal(parseYuanToMicros('0.000001'), 1n)
  assert.equal(parseYuanToMicros('1000'), 1_000_000_000n)
})
