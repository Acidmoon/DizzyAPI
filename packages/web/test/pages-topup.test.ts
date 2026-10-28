/**
 * 充值两个页面（用户 `/console/top-up` + 管理台 `/admin/topup-orders`）的测试。
 *
 * 真起 web 服务 + 表单 POST，盯住四件事：
 * 1. 用户页明确「不会自动到账」，下单后 303 回页面并展示人工确认说明；
 * 2. 只有 pending 订单给「取消 / 确认到账」按钮，其余状态只显示文字；
 * 3. 确认到账的两种结果都说人话（真的加了钱 / 此前已到账没有重复加钱）；
 * 4. 缺服务时降级成人话，不白屏；页面渲染的是转义后的文本。
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context, Service } from 'cordis'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import type { TopupLike, TopupOrderView } from '../src/runtime.ts'

const SESSION_COOKIE = 'dizzyapi_session=test-token'

class FakeAuth extends Service {
  constructor(ctx: Context) {
    super(ctx, 'auth')
  }

  async verifySession(token: string) {
    if (token !== 'test-token') throw new Error('会话无效')
    return {
      sessionId: 's1',
      userId: 2,
      user: {
        id: 2,
        name: 'alice',
        status: 'enabled' as const,
        role: 'admin' as const,
        balance: 2_500_000n,
        balanceEnabled: true,
        avatar: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      expiresAt: '2030-01-01T00:00:00.000Z',
    }
  }

  async logout(): Promise<void> {
    // 测试不关心。
  }
}

const PENDING_NO = 'T20261019110000ABCD1234'
const PAID_NO = 'T20261019111500EFGH5678'

function orderOf(patch: Partial<TopupOrderView> & { orderNo: string }): TopupOrderView {
  return {
    userId: 2,
    amountMicro: 100_000_000n,
    status: 'pending',
    provider: 'manual',
    // 故意放一段像标签的文本：页面必须转义，不能当 HTML 执行。
    providerLabel: '人工确认（线下转账）<img src=x onerror=alert(1)>',
    providerOrderId: null,
    instructions: '请联系管理员线下转账，并在备注里写明单号；管理员确认后到账。',
    note: '对公转账',
    createdAt: '2026-10-19T11:00:00.000Z',
    expiresAt: '2026-10-19T11:30:00.000Z',
    paidAt: null,
    canceledAt: null,
    ...patch,
  }
}

/** 假充值服务：只实现页面会调到的方法，记录动作与参数。 */
class FakeTopup extends Service implements TopupLike {
  readonly calls: string[] = []
  readonly orders: TopupOrderView[] = [
    orderOf({ orderNo: PENDING_NO }),
    orderOf({
      orderNo: PAID_NO,
      status: 'paid',
      amountMicro: 20_000_000n,
      paidAt: '2026-10-19T11:20:00.000Z',
    }),
  ]
  credited = true

  constructor(ctx: Context) {
    super(ctx, 'topup')
  }

  options() {
    return {
      currency: 'CNY' as const,
      providerId: 'manual',
      providerLabel: '人工确认（线下转账）',
      online: false,
      minAmountMicros: 1_000_000n,
      maxAmountMicros: 10_000_000_000n,
      expiresMinutes: 30,
      notice: '当前仅支持人工确认到账，不会自动到账。',
    }
  }

  async createOrder(input: { userId: number; amountYuan: unknown; note?: string | null }) {
    this.calls.push(`create:${input.userId}:${String(input.amountYuan)}:${String(input.note)}`)
    const order = orderOf({ orderNo: PENDING_NO, amountMicro: 50_000_000n })
    return { order }
  }

  listMine(userId: number, limit?: number) {
    this.calls.push(`listMine:${userId}:${String(limit)}`)
    return { items: this.orders, total: this.orders.length }
  }

  getMine(userId: number, orderNo: string) {
    this.calls.push(`getMine:${userId}:${orderNo}`)
    const found = this.orders.find((item) => item.orderNo === orderNo)
    if (found === undefined) throw Object.assign(new Error('没有这笔充值订单'), { code: 'TOPUP_ORDER_NOT_FOUND' })
    return found
  }

  cancelMine(userId: number, orderNo: string) {
    this.calls.push(`cancelMine:${userId}:${orderNo}`)
    return orderOf({ orderNo, status: 'canceled', canceledAt: '2026-10-19T11:05:00.000Z' })
  }

  list(_actor: string, query: { status?: string; limit?: number; offset?: number } = {}) {
    this.calls.push(`list:${String(query.status)}:${String(query.limit)}:${String(query.offset)}`)
    const filtered =
      query.status === undefined ? this.orders : this.orders.filter((item) => item.status === query.status)
    return { items: filtered, total: filtered.length }
  }

  async confirmPaid(actor: string, orderNo: string) {
    this.calls.push(`confirm:${actor}:${orderNo}`)
    const base = this.orders.find((item) => item.orderNo === orderNo) ?? orderOf({ orderNo })
    return {
      order: { ...base, status: 'paid', paidAt: '2026-10-19T11:20:00.000Z' },
      credited: this.credited,
    }
  }

  cancel(actor: string, orderNo: string) {
    this.calls.push(`cancel:${actor}:${orderNo}`)
    return orderOf({ orderNo, status: 'canceled', canceledAt: '2026-10-19T11:05:00.000Z' })
  }

  stats() {
    this.calls.push('stats')
    return {
      todayPaidCount: 1,
      todayPaidMicros: 100_000_000n,
      totalPaidCount: 2,
      totalPaidMicros: 300_000_000n,
      pendingCount: 3,
      expiredCount: 4,
    }
  }
}

interface App {
  readonly base: string
  readonly topup: FakeTopup | undefined
}

async function boot(t: TestContext, options: { withTopup?: boolean } = {}): Promise<App> {
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(FakeAuth)
    if (options.withTopup !== false) await ctx.plugin(FakeTopup)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let index = 0; index < 100; index += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: options.withTopup === false ? undefined : (ctx.get('topup') as unknown as FakeTopup),
      port: address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  t.after(async () => {
    await started.close()
  })
  return { base: started.base, topup: started.app }
}

function get(app: App, path: string): Promise<Response> {
  return fetch(`${app.base}${path}`, {
    headers: { cookie: SESSION_COOKIE },
    redirect: 'manual',
  })
}

function post(app: App, path: string, body: string): Promise<Response> {
  return fetch(`${app.base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: app.base,
      cookie: SESSION_COOKIE,
    },
    body,
    redirect: 'manual',
  })
}

// ───────────────────────────────── 用户页 ─────────────────────────────────

test('充值页：说明不会自动到账、表单、我的订单与状态徽章', async (t) => {
  const app = await boot(t)
  const response = await get(app, '/console/top-up')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /不会自动到账/)
  assert.match(html, /联系管理员线下转账/)
  assert.match(html, /当前余额/)
  assert.match(html, /¥2\.50/)
  assert.match(html, /name="amountYuan"/)
  assert.match(html, /我的充值订单/)
  assert.match(html, new RegExp(PENDING_NO))
  assert.match(html, /待确认/)
  assert.match(html, /已到账/)
  // 金额按整数微元渲染成元。
  assert.match(html, /¥100\.00/)
  assert.match(html, /¥20\.00/)
  // 只有 pending 行给取消按钮。
  assert.equal(html.split('action="/console/top-up?action=cancel"').length - 1, 1)
  // 支付方式里的标签必须被转义。
  assert.ok(!html.includes('<img src=x onerror=alert(1)>'))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('充值页：?order= 显示下单后的转账说明，未知单号给一条人话', async (t) => {
  const app = await boot(t)
  const detail = await get(app, `/console/top-up?order=${PENDING_NO}`)
  const html = await detail.text()
  assert.match(html, new RegExp(`订单 ${PENDING_NO}`))
  assert.match(html, /线下转账/)
  assert.match(html, /请在/)
  assert.match(html, /前完成转账/)

  const missing = await get(app, '/console/top-up?order=T20261019110000ZZZZ9999')
  assert.equal(missing.status, 200)
  assert.match(await missing.text(), /没有找到这笔充值订单/)
})

test('充值页：下单表单 POST 走 303 回页面，并把金额与备注交给服务', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/console/top-up?action=create', 'amountYuan=100&note=%E5%AF%B9%E5%85%AC')
  assert.equal(response.status, 303)
  const location = response.headers.get('location') ?? ''
  assert.ok(location.startsWith('/console/top-up?ok='), location)
  assert.ok(location.includes(`order=${PENDING_NO}`), location)
  assert.deepEqual(app.topup?.calls, ['create:2:100:对公'])

  const follow = await get(app, location)
  assert.equal(follow.status, 200)
  assert.match(await follow.text(), /人工确认到账/)
})

test('充值页：缺金额回到页面报错，不调用服务', async (t) => {
  const app = await boot(t)
  const response = await post(app, '/console/top-up?action=create', 'note=x')
  assert.equal(response.status, 303)
  const location = response.headers.get('location') ?? ''
  assert.ok(location.startsWith('/console/top-up?err='), location)
  assert.ok(location.includes(encodeURIComponent('充值金额')))
  assert.deepEqual(app.topup?.calls, [])
})

test('充值页：取消订单调用服务并 303', async (t) => {
  const app = await boot(t)
  const response = await post(app, `/console/top-up?action=cancel`, `orderNo=${PENDING_NO}`)
  assert.equal(response.status, 303)
  assert.ok((response.headers.get('location') ?? '').startsWith('/console/top-up?ok='))
  assert.deepEqual(app.topup?.calls, [`cancelMine:2:${PENDING_NO}`])
})

// ───────────────────────────────── 管理台 ─────────────────────────────────

test('管理台充值订单页：统计卡、筛选、只有待确认给两个动作', async (t) => {
  const app = await boot(t)
  const response = await get(app, '/admin/topup-orders')
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /今日到账/)
  assert.match(html, /¥100\.00/)
  assert.match(html, /累计到账/)
  assert.match(html, /¥300\.00/)
  assert.match(html, /待确认/)
  assert.match(html, /已过期/)
  assert.match(html, /没有在线支付/)
  assert.match(html, /status=pending/)

  assert.equal(html.split('action="/admin/topup-orders?action=confirm"').length - 1, 1)
  assert.equal(html.split('action="/admin/topup-orders?action=cancel"').length - 1, 1)
  assert.match(html, new RegExp(`name="orderNo" value="${PENDING_NO}"`))
  assert.ok(!html.includes('onerror=alert(1)>'))
})

test('管理台：确认到账 303 并说明真的加了钱；重复确认说明没有重复加钱', async (t) => {
  const app = await boot(t)
  const first = await post(app, '/admin/topup-orders?action=confirm', `orderNo=${PENDING_NO}`)
  assert.equal(first.status, 303)
  const firstLocation = decodeURIComponent(first.headers.get('location') ?? '')
  assert.ok(firstLocation.startsWith('/admin/topup-orders?ok='), firstLocation)
  assert.match(firstLocation, /已确认到账/)
  assert.match(firstLocation, /余额已增加/)
  assert.match(firstLocation, /¥100\.00/)

  assert.equal(app.topup?.credited, true)
  app.topup!.credited = false
  const again = await post(app, '/admin/topup-orders?action=confirm', `orderNo=${PAID_NO}`)
  assert.equal(again.status, 303)
  const againLocation = decodeURIComponent(again.headers.get('location') ?? '')
  assert.match(againLocation, /此前已到账/)
  assert.match(againLocation, /没有重复加钱/)
  assert.deepEqual(app.topup?.calls, [
    `confirm:@dizzyapi/plugin-web:${PENDING_NO}`,
    `confirm:@dizzyapi/plugin-web:${PAID_NO}`,
  ])
})

test('管理台：取消订单 303；缺单号报错且不调用服务', async (t) => {
  const app = await boot(t)
  const canceled = await post(app, '/admin/topup-orders?action=cancel', `orderNo=${PENDING_NO}`)
  assert.equal(canceled.status, 303)
  assert.match(decodeURIComponent(canceled.headers.get('location') ?? ''), /已取消/)
  assert.deepEqual(app.topup?.calls, [`cancel:@dizzyapi/plugin-web:${PENDING_NO}`])

  app.topup!.calls.length = 0
  const bad = await post(app, '/admin/topup-orders?action=cancel', '')
  assert.equal(bad.status, 303)
  const location = bad.headers.get('location') ?? ''
  assert.ok(location.startsWith('/admin/topup-orders?err='), location)
  assert.ok(decodeURIComponent(location).includes('订单号'))
  assert.deepEqual(app.topup?.calls, [])
})

// ───────────────────────────────── 缺服务 ─────────────────────────────────

test('充值订单服务缺失：两个页面都给人话，写动作回到页面报错', async (t) => {
  const app = await boot(t, { withTopup: false })

  const userPage = await get(app, '/console/top-up')
  assert.equal(userPage.status, 200)
  assert.match(await userPage.text(), /充值订单服务未运行/)

  const adminPage = await get(app, '/admin/topup-orders')
  assert.equal(adminPage.status, 200)
  assert.match(await adminPage.text(), /充值订单服务未运行/)

  const create = await post(app, '/console/top-up?action=create', 'amountYuan=100')
  assert.equal(create.status, 303)
  assert.match(decodeURIComponent(create.headers.get('location') ?? ''), /充值订单服务未运行/)
})
