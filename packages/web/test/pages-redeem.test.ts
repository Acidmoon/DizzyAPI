/**
 * 兑换码两个页面的渲染测试（不起 HTTP、不拉鉴权）。
 *
 * 只验证「页面能渲染、服务缺失时说人话、明文只出现在一次性区块里、列表只有掩码」；
 * 表单动作（POST + 303）由 HTTP 层与 redeem 插件自己的测试覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { adminRedeemCodesPage } from '../src/pages/admin_redeem_codes.ts'
import { redeemPage } from '../src/pages/redeem.ts'
import { parseYuanToMicros } from '../src/forms.ts'
import type { PageContext } from '../src/layout.ts'
import type { RedeemLike, SessionView, WebRuntime } from '../src/runtime.ts'

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
    concurrencyLimit: null,
    avatar: null,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
  },
  expiresAt: '2099-10-19T00:00:00.000Z',
}

/** 所有可选服务都缺失：用来看页面是否降级成人话而不是白屏。 */
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
  modelhub: undefined,
  fontSmiley: undefined,
  audit: undefined,
  observability: undefined,
  contentAudit: undefined,
  gateFeed: undefined,
}

function pageContext(
  services: WebRuntime,
  template: PageTemplateService,
  options: {
    readonly path: string
    readonly title: string
    readonly query?: string
    readonly secret?: string
  },
): PageContext {
  return {
    path: options.path,
    title: options.title,
    query: new URLSearchParams(options.query ?? ''),
    user: SESSION,
    t: template,
    services,
    notice: null,
  themeCss: '',  navOrder: [],
    takeSecret: () => options.secret,
  }
}

async function templateOf(): Promise<PageTemplateService> {
  const ctx = new Context()
  await ctx.plugin(PageTemplateService)
  return ctx.get('pageTemplate') as PageTemplateService
}

function batchOf() {
  return {
    id: 'batch-1',
    name: '双十一',
    kind: 'balance',
    amountMicro: 5_000_000n,
    total: 2,
    notes: null,
    createdBy: '@dizzyapi/plugin-web',
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: null,
    codeCount: 2,
    usedCount: 0,
  }
}

function codeOf(patch: { id: string; codeMask: string; status: string }) {
  return {
    id: patch.id,
    batchId: 'batch-1',
    batchName: '双十一',
    codeMask: patch.codeMask,
    kind: 'balance',
    amountMicro: 5_000_000n,
    status: patch.status,
    createdAt: '2026-10-19T00:00:00.000Z',
    expiresAt: null,
    reservedAt: null,
    reservedBy: null,
    redeemedAt: null,
    redeemedBy: null,
    disabledBy: null,
    disabledAt: null,
  }
}

test('金额：元 → 微元只做字符串拆分，不经过浮点', () => {
  assert.equal(parseYuanToMicros('5'), 5_000_000n)
  assert.equal(parseYuanToMicros('5.5'), 5_500_000n)
  assert.equal(parseYuanToMicros('0.000001'), 1n)
  assert.equal(parseYuanToMicros(' 12.34 '), 12_340_000n)
  for (const bad of ['1.2345678', '1e3', '-1', '.5', '5.', '', 'abc', '1,000']) {
    assert.throws(() => parseYuanToMicros(bad), `应当拒绝 ${bad}`)
  }
})

test('兑换页：服务缺失时给出人话，余额照常显示；有服务时给出表单与记录', async () => {
  const template = await templateOf()
  const missing = await redeemPage.render(
    pageContext(EMPTY_SERVICES, template, { path: '/console/redeem', title: '兑换' }),
  )
  assert.ok(missing.includes('兑换码服务未运行'))
  assert.ok(missing.includes('¥2.50'), '余额（微元 → 元）应照常显示')

  const html = await redeemPage.render(
    pageContext({ ...EMPTY_SERVICES, redeem: redeemStub() }, template, {
      path: '/console/redeem',
      title: '兑换',
    }),
  )
  assert.ok(html.includes('name="code"'), '兑换表单要存在')
  assert.ok(html.includes('我的兑换记录'))
  assert.ok(html.includes('****A3F7'), '历史记录只显示掩码')
})

/** 只实现「页面渲染会调到」的那几个方法。 */
function redeemStub(): RedeemLike {
  return {
    redeemCode: async () => ({ amount: 5_000_000n, balance: 7_500_000n, batchName: '双十一' }),
    listMyRedemptions: async () => [
      {
        codeId: 'code-1',
        codeMask: '****A3F7',
        amountMicro: 5_000_000n,
        batchName: '双十一',
        redeemedAt: '2026-10-19T00:00:00.000Z',
      },
    ],
    createBatch: async () => ({ batch: batchOf(), codes: [] }),
    listBatches: async () => [batchOf()],
    listCodes: async () => ({
      items: [
        codeOf({ id: 'code-1', codeMask: '****A3F7', status: 'enabled' }),
        codeOf({ id: 'code-2', codeMask: '****B4C8', status: 'redeeming' }),
      ],
      total: 2,
    }),
    setCodeStatus: async () => codeOf({ id: 'code-1', codeMask: '****A3F7', status: 'disabled' }),
    deleteCodes: async () => ({ deleted: 0, rejected: [] }),
    resolveRedeeming: async () => codeOf({ id: 'code-2', codeMask: '****B4C8', status: 'used' }),
    stats: async () => ({
      batches: 1,
      codes: 2,
      enabled: 1,
      disabled: 0,
      redeeming: 1,
      used: 0,
      expired: 0,
      redeemedAmountMicro: 0n,
    }),
  }
}

test('管理台兑换码页：列表只有掩码，明文只在一次性区块里出现', async () => {
  const template = await templateOf()
  const redeem = redeemStub()

  const plainName = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ23'
  const html = await adminRedeemCodesPage.render(
    pageContext({ ...EMPTY_SERVICES, redeem }, template, {
      path: '/admin/redeem-codes',
      title: '兑换码',
      query: 'new=secret-1&batch=batch-1',
      secret: plainName,
    }),
  )

  assert.ok(html.includes('****A3F7'))
  assert.ok(html.includes('****B4C8'))
  assert.ok(html.includes('双十一'))
  assert.ok(html.includes('标记为已用'))
  assert.ok(html.includes('退回可用'))
  assert.ok(html.includes(plainName), '一次性区块应当显示整批明文')
  // 明文出现两次：一次在可见的 <pre>，一次在复制按钮的 data-copy 属性里。
  assert.equal(html.split(plainName).length - 1, 2, '明文只应出现在一次性区块与它的复制按钮里')

  // 服务缺失时也只是一条人话，不抛异常。
  const missing = await adminRedeemCodesPage.render(
    pageContext(EMPTY_SERVICES, template, { path: '/admin/redeem-codes', title: '兑换码' }),
  )
  assert.ok(missing.includes('兑换码服务未运行'))
})
