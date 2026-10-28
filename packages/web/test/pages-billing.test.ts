/**
 * 「结算」管理页的渲染测试（不起 HTTP、不拉鉴权）。
 *
 * 只验证：服务缺失时降级成人话、有数据时金额 / 状态 / 请求 ID 都渲染出来。
 * 扣费本身由 packages/billing 的测试覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { adminBillingPage } from '../src/pages/admin_billing.ts'
import type { PageContext } from '../src/layout.ts'
import type { BillingLike, SessionView, WebRuntime } from '../src/runtime.ts'

const SESSION: SessionView = {
  sessionId: 'session-1',
  userId: 7,
  user: {
    id: 7,
    name: 'alice',
    status: 'enabled',
    role: 'admin',
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
  settings: undefined,
  catalog: undefined,
  accountAdmin: undefined,
  redeem: undefined,
  billing: undefined,
  topup: undefined,
  fontSmiley: undefined,
}

function pageContext(services: WebRuntime): PageContext {
  return {
    path: '/admin/billing',
    title: '结算',
    query: new URLSearchParams(''),
    user: SESSION,
    t: TEMPLATE,
    services,
    notice: null,
    takeSecret: () => undefined,
  }
}

let TEMPLATE: PageTemplateService

async function templateOf(): Promise<PageTemplateService> {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  return ctx.get('pageTemplate') as PageTemplateService
}

function billingStub(): BillingLike {
  return {
    list(_actor, query) {
      const items = [
        {
          reqId: 'req-settled',
          userId: 3,
          accountId: 'account-1',
          model: 'deepseek-chat',
          day: '2026-10-19',
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicro: 1_750_000n,
          overdrawn: false,
          balanceAfter: 8_250_000n,
          status: 'settled',
          note: null,
          attempts: 1,
          startedAt: '2026-10-19T11:00:00.000Z',
          settledAt: '2026-10-19T11:00:02.000Z',
        },
        {
          reqId: 'req-problem',
          userId: 4,
          accountId: '',
          model: 'unknown-model',
          day: '2026-10-19',
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicro: 0n,
          overdrawn: false,
          balanceAfter: null,
          status: 'no-price',
          note: '模型没有配置价格：按 0 结算，未动余额',
          attempts: 1,
          startedAt: '2026-10-19T12:00:00.000Z',
          settledAt: null,
        },
        {
          reqId: 'req-overdrawn',
          userId: 5,
          accountId: 'account-2',
          model: 'deepseek-chat',
          day: '2026-10-19',
          inputTokens: 900,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costMicro: 2_000_000n,
          overdrawn: true,
          balanceAfter: -500_000n,
          status: 'settled',
          note: '余额不足：扣费后余额 -500000 微元（后付费允许为负）',
          attempts: 1,
          startedAt: '2026-10-19T13:00:00.000Z',
          settledAt: '2026-10-19T13:00:02.000Z',
        },
      ]
      const filtered = query?.status === 'problem' ? items.filter((item) => item.status !== 'settled') : items
      return { items: filtered, total: filtered.length }
    },
    summary() {
      return {
        totals: {
          records: 2,
          settled: 1,
          noPrice: 1,
          noUser: 0,
          failed: 0,
          review: 0,
          settling: 0,
          overdrawn: 1,
          chargedMicros: 1_750_000n,
          todayChargedMicros: 1_750_000n,
        },
        daily: [{ date: '2026-10-19', records: 2, settled: 1, chargedMicros: 1_750_000n }],
        models: [{ model: 'deepseek-chat', records: 1, chargedMicros: 1_750_000n }],
      }
    },
  }
}

test('结算服务缺失：页面给出人话而不是白屏', async () => {
  TEMPLATE = await templateOf()
  const html = await adminBillingPage.render(pageContext(EMPTY_SERVICES))
  assert.match(html, /结算服务未运行/)
  assert.match(html, /结算/)
})

test('有数据：金额、状态与请求 ID 都渲染出来', async () => {
  TEMPLATE = await templateOf()
  const html = await adminBillingPage.render(
    pageContext({ ...EMPTY_SERVICES, billing: billingStub() }),
  )
  // 1_750_000 微元 = 1.75 元。
  assert.match(html, /¥1\.75/)
  assert.match(html, /req-settled/)
  assert.match(html, /已结算/)
  assert.match(html, /无价格/)
  assert.match(html, /模型没有配置价格/)
  // 余额不足扣成负数：状态仍是稳定字符串 settled，页面显示「（透支）」并给出扣后余额。
  assert.match(html, /（透支）/)
  assert.match(html, /-¥0\.50/)
  assert.match(html, /2026-10-19/)
  assert.ok(!html.includes('undefined'))
})
