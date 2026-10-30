/**
 * 管理台「编辑」入口的渲染与动作测试（不起 HTTP）：API key / 用户 / 模型价格三页。
 *
 * owner 第 6 / 8 / 10 条要的是「行上只留编辑、操作进弹窗」。这里盯住三件事：
 * 1. 行上确实只剩「编辑」，且它是 `?edit=…` 的**普通链接** + `data-dialog-open`
 *    —— 无脚本时退化成整页表单，有脚本时由脚本拦下来开弹窗（`modal.ts` 要求
 *    「不要把唯一入口放进弹窗」）；
 * 2. 弹窗与整页表单用的是**同一份字段**（同一个 action），不会两处漂移；
 * 3. 保存动作真的调到服务、参数精确（金额是整数微元字符串、日期是 ISO），
 *    管理员写操作带正确审计动作码。
 *
 * 上游账号页（第 9 条）的行为测试在 `admin-accounts.test.ts`（它起真 HTTP）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keysPage } from '../src/pages/keys.ts'
import { adminUsersPage } from '../src/pages/admin_users.ts'
import { adminPricingPage } from '../src/pages/admin_pricing.ts'
import { WebError } from '../src/forms.ts'
import { auditSpy, emptyServices, renderPage, runAction } from './helpers/page-fixture.ts'
import type { GateFeedLike, GateFeedStatusView } from '../src/gate-types.ts'
import type {
  ApiKeyGatePatch,
  ApiKeyLike,
  ApiKeyView,
  ModelCatalogView,
  ModelPrice,
  PricingLike,
  UserView,
  WebRuntime,
} from '../src/runtime.ts'

// ───────────────────────────── API key 页 ─────────────────────────────

const KEY: ApiKeyView = {
  id: 'k1',
  userId: 7,
  name: '本地开发',
  trackingId: 'trk-1',
  secret: 'sk-full-secret',
  maskedKey: 'sk-…abcd',
  enabled: true,
  appManaged: false,
  createdAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  rotatedAt: null,
  expiresAt: '2026-12-31T00:00:00.000Z',
  spendingLimitMicros: '1500000',
  concurrencyLimit: 4,
}

function apiKeySpy(): ApiKeyLike & {
  readonly updates: { readonly userId: number; readonly id: string; readonly patch: ApiKeyGatePatch }[]
} {
  const updates: { userId: number; id: string; patch: ApiKeyGatePatch }[] = []
  return {
    updates,
    async list() {
      return [KEY]
    },
    async listAll() {
      return [KEY]
    },
    async create() {
      throw new Error('这个用例不建 key')
    },
    async update(userId, id, patch) {
      updates.push({ userId, id, patch })
      return KEY
    },
    async rotate() {
      throw new Error('这个用例不轮换 key')
    },
    async remove() {
      throw new Error('这个用例不删 key')
    },
  }
}

test('API key 页：行上只有复制 / 停用 / 删除 / 编辑，编辑是 ?edit= 链接 + data-dialog-open', async () => {
  const services = { ...emptyServices(), apiKey: apiKeySpy() }
  const html = await renderPage(keysPage, services)

  // 四个操作都在，且「编辑」走的是链接（无脚本可导航）
  assert.ok(html.includes('data-copy="sk-full-secret"'), '复制按钮要带完整 key（用户自己的 key 允许复制）')
  assert.ok(html.includes('action="/console/api-keys?action=toggle"'))
  assert.ok(html.includes('action="/console/api-keys?action=remove"'))
  assert.match(html, /href="\/console\/api-keys\?edit=k1"/)
  assert.ok(html.includes('data-dialog-open="key-edit-k1"'), '有脚本时同一链接开弹窗')

  // 第 6 条新增的三列
  for (const column of ['过期', '金额上限', '并发']) assert.ok(html.includes(column), `缺少列：${column}`)
  assert.ok(html.includes('2026-12-31'), '过期时间要显示成日期')
  assert.ok(html.includes('1.5'), '金额上限按元显示')
})

test('API key 页：无脚本时 ?edit= 整页渲染同一张表单（同一个 action）', async () => {
  const services = { ...emptyServices(), apiKey: apiKeySpy() }
  const html = await renderPage(keysPage, services, 'edit=k1')

  assert.ok(html.includes('编辑：本地开发'), '整页要说明正在编辑哪个 key')
  assert.ok(html.includes('action="/console/api-keys?action=edit"'), '与弹窗用同一个 action')
  // 字段齐全：名称 / 过期 / 金额上限 / 并发 / 启停
  for (const field of ['name="name"', 'name="expiresAt"', 'name="spendingLimitYuan"', 'name="concurrencyLimit"', 'name="enabled"']) {
    assert.ok(html.includes(field), `缺少字段：${field}`)
  }
  assert.ok(html.includes('name="id" value="k1"'), '要有隐藏的 id')
  // 回填：日期控件的值、金额换成元、并发是数字
  assert.ok(html.includes('value="2026-12-31"'), '日期控件要回填 YYYY-MM-DD')
  assert.ok(html.includes('value="1.5"'), '金额上限回填成元')
  assert.ok(html.includes('value="4"'), '并发上限回填')
})

test('API key 编辑：金额按元输入、落库是整数微元字符串；日期转 ISO；并发转数字', async () => {
  const keys = apiKeySpy()
  const services = { ...emptyServices(), apiKey: keys }
  const location = await runAction(keysPage, services, 'edit', 'id=k1&name=生产&expiresAt=2027-01-31&spendingLimitYuan=88.5&concurrencyLimit=8&enabled=1')

  assert.equal(location, '/console/api-keys?ok=' + encodeURIComponent('已保存'))
  assert.deepEqual(keys.updates, [
    {
      userId: 7,
      id: 'k1',
      patch: {
        name: '生产',
        enabled: true,
        expiresAt: '2027-01-31T00:00:00.000Z',
        spendingLimitMicros: '88500000',
        concurrencyLimit: 8,
      },
    },
  ])
})

test('API key 编辑：清空三条上限 = null（不是 0，也不是空字符串）', async () => {
  const keys = apiKeySpy()
  const services = { ...emptyServices(), apiKey: keys }
  await runAction(keysPage, services, 'edit', 'id=k1&name=本地开发&expiresAt=&spendingLimitYuan=&concurrencyLimit=&enabled=0')

  assert.deepEqual(keys.updates[0]?.patch, {
    name: '本地开发',
    enabled: false,
    expiresAt: null,
    spendingLimitMicros: null,
    concurrencyLimit: null,
  })
})

test('API key 编辑：金额上限为 0 或负、并发非法时明确失败且不写库', async () => {
  const keys = apiKeySpy()
  const services = { ...emptyServices(), apiKey: keys }

  await assert.rejects(
    runAction(keysPage, services, 'edit', 'id=k1&name=x&spendingLimitYuan=0&enabled=1'),
    (error: unknown) => error instanceof WebError,
    '0 元上限等于「一次都不许用」，应当拒绝而不是静默存 0',
  )
  await assert.rejects(
    runAction(keysPage, services, 'edit', 'id=k1&name=x&concurrencyLimit=1.5&enabled=1'),
    (error: unknown) => error instanceof WebError,
  )
  assert.deepEqual(keys.updates, [], '校验失败不能写库')
})

test('API key 页「已消费」列：与闸门同一个来源（usage.summary 按 key 汇总）', async () => {
  const keys = apiKeySpy()
  const summaryCalls: { readonly apiKeyId?: string }[] = []
  const usage = {
    summary(query: { readonly apiKeyId?: string }) {
      summaryCalls.push({ ...(query.apiKeyId === undefined ? {} : { apiKeyId: query.apiKeyId }) })
      return { totals: { costMicros: '2500000' } }
    },
  } as unknown as NonNullable<WebRuntime['usage']>

  const html = await renderPage(keysPage, { ...emptyServices(), apiKey: keys, usage })

  // 只有「配了上限」的 key 才查（没上限的 Go 侧根本不判金额）。
  assert.deepEqual(summaryCalls, [{ apiKeyId: 'k1' }])
  assert.ok(html.includes('已消费'), '表头要有「已消费」')
  assert.ok(html.includes('2.5'), '已消费按元显示（2500000 微元 = 2.5 元）')
})

test('API key 页「已消费」列：没上限的 key 不查、显示「—」；用量服务缺席也不报错', async () => {
  const noLimit: ApiKeyView = { ...KEY, spendingLimitMicros: null }
  const keys = { ...apiKeySpy(), async list() { return [noLimit] } }
  const usage = {
    summary() {
      throw new Error('不该被调用')
    },
  } as unknown as NonNullable<WebRuntime['usage']>

  const html = await renderPage(keysPage, { ...emptyServices(), apiKey: keys, usage })
  assert.ok(html.includes('已消费'))

  const withoutUsage = await renderPage(keysPage, { ...emptyServices(), apiKey: apiKeySpy() })
  assert.ok(withoutUsage.includes('已消费'), '用量服务缺席只是少一个数，页面照常渲染')
})

// ───────────────────────────── 用户页 ─────────────────────────────

const USER: UserView = {
  id: 2,
  name: 'alice',
  status: 'enabled',
  role: 'user',
  balance: 2_500_000n,
  balanceEnabled: true,
  concurrencyLimit: 4,
  avatar: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
}

function userSpy(): {
  readonly calls: string[]
  readonly service: NonNullable<WebRuntime['user']>
} {
  const calls: string[] = []
  const service = {
    async get() {
      return USER
    },
    async list() {
      return [USER]
    },
    async setStatus(_actor: string, _id: number, status: 'enabled' | 'banned') {
      calls.push(`status:${status}`)
      return { ...USER, status }
    },
    async setRole(_actor: string, _id: number, role: 'admin' | 'user') {
      calls.push(`role:${role}`)
      return { ...USER, role }
    },
    async rename(_actor: string, _id: number, name: string) {
      calls.push(`name:${name}`)
      return { ...USER, name }
    },
    async setConcurrencyLimit(_actor: string, _id: number, limit: number | null) {
      calls.push(`concurrency:${String(limit)}`)
      return { ...USER, concurrencyLimit: limit }
    },
    async adjustBalance() {
      throw new Error('这个用例不调余额')
    },
    async remove() {
      throw new Error('这个用例不删用户')
    },
  } as unknown as NonNullable<WebRuntime['user']>
  return { calls, service }
}

test('用户页：行上只剩「编辑」，封禁 / 设管理员 / 删除不再是行内按钮', async () => {
  const users = userSpy()
  const html = await renderPage(adminUsersPage, { ...emptyServices(), user: users.service })

  assert.match(html, /href="\/admin\/users\?edit=2"/)
  assert.ok(html.includes('data-dialog-open="user-edit-2"'))
  // 老的三个行内动作码彻底消失（它们的入口已进弹窗，走 edit / balance / remove）
  assert.equal(html.includes('action=status'), false, '不该再有独立的封禁动作入口')
  assert.equal(html.includes('action=role'), false, '不该再有独立的设管理员入口')
  // 弹窗里三样都在：编辑字段、余额调整、删除
  assert.ok(html.includes('action="/admin/users?action=edit"'))
  assert.ok(html.includes('action="/admin/users?action=balance"'))
  assert.ok(html.includes('action="/admin/users?action=remove"'))
  for (const field of ['name="name"', 'name="role"', 'name="status"', 'name="concurrencyLimit"']) {
    assert.ok(html.includes(field), `弹窗缺少字段：${field}`)
  }
})

test('用户页：无脚本时 ?edit= 整页渲染同一张编辑表单', async () => {
  const users = userSpy()
  const html = await renderPage(adminUsersPage, { ...emptyServices(), user: users.service }, 'edit=2')

  assert.ok(html.includes('编辑：alice'))
  assert.ok(html.includes('action="/admin/users?action=edit"'))
  assert.ok(html.includes('name="id" value="2"'))
  assert.ok(html.includes('value="4"'), '并发上限要回填')
})

test('用户页保存：逐项 diff——只改状态就只写一次、只记一条审计', async () => {
  const users = userSpy()
  const audit = auditSpy()
  const services = { ...emptyServices(), user: users.service, audit }
  const location = await runAction(adminUsersPage, services, 'edit', 'id=2&name=alice&role=user&status=banned&concurrencyLimit=4')

  assert.equal(location, '/admin/users?ok=' + encodeURIComponent('已保存'))
  assert.deepEqual(users.calls, ['status:banned'], '没变的字段不该再写一遍')
  assert.deepEqual(audit.entries.map((entry) => entry.action), ['user.status.set'])
})

test('用户页保存：三项都改就三条审计，动作码各不相同', async () => {
  const users = userSpy()
  const audit = auditSpy()
  const services = { ...emptyServices(), user: users.service, audit }
  await runAction(adminUsersPage, services, 'edit', 'id=2&name=alice2&role=admin&status=enabled&concurrencyLimit=8')

  assert.deepEqual(users.calls, ['name:alice2', 'role:admin', 'concurrency:8'])
  assert.deepEqual(audit.entries.map((entry) => entry.action), ['user.rename', 'user.role.set', 'user.concurrency.set'])
  assert.equal(audit.entries.every((entry) => entry.targetId === '2'), true)
})

// ───────────────────────────── 模型价格页 ─────────────────────────────

const PRICE: ModelPrice = {
  model: 'deepseek-flash',
  inputPerMillion: '0.5',
  outputPerMillion: '2',
  cacheReadPerMillion: '0.1',
  cacheWritePerMillion: '0',
  updatedAt: '2026-10-20T00:00:00.000Z',
}

function pricingSpy(): PricingLike & {
  readonly sets: { readonly model: string; readonly input: unknown }[]
  readonly removes: string[]
} {
  const sets: { model: string; input: unknown }[] = []
  const removes: string[] = []
  return {
    sets,
    removes,
    list() {
      return [PRICE]
    },
    async set(_actor, model, input) {
      sets.push({ model, input })
      return { ...PRICE, ...input, model }
    },
    async remove(_actor, model) {
      removes.push(model)
      return true
    },
  }
}

function modelhubSpy(): NonNullable<WebRuntime['modelhub']> & { readonly queries: unknown[] } {
  const queries: unknown[] = []
  const catalog: ModelCatalogView = {
    available: [
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
    unavailable: [],
    summary: { total: 1, availableCount: 1, unavailableCount: 0, pricedCount: 0, accountCount: 1 },
  }
  return {
    queries,
    catalog(query) {
      queries.push(query)
      return catalog
    },
  }
}

test('价格页：每行「编辑」+ 顶部「添加模型」，并列出未定价的模型', async () => {
  const modelhub = modelhubSpy()
  const services = { ...emptyServices(), pricing: pricingSpy(), modelhub }
  const html = await renderPage(adminPricingPage, services)

  assert.match(html, /href="\/admin\/pricing\?edit=deepseek-flash"/)
  assert.ok(html.includes('data-dialog-open="price-edit-deepseek-flash"'))
  assert.match(html, /href="\/admin\/pricing\?add=1"/)
  assert.ok(html.includes('data-dialog-open="price-add"'), '「添加」也是一个弹窗')
  // 未定价区块：来自 modelhub 的 priced=unpriced 查询
  assert.deepEqual(modelhub.queries, [{ priced: 'unpriced' }])
  assert.ok(html.includes('未定价的模型'))
  assert.ok(html.includes('free-model'))
  assert.match(html, /href="\/admin\/pricing\?add=1&amp;model=free-model"|href="\/admin\/pricing\?add=1&model=free-model"/)
  assert.ok(html.includes('MODEL_NOT_PRICED'), '要写明未定价会被拒')
})

test('价格页：无脚本时 ?edit=<model> 与 ?add=1 各渲染一张整页表单', async () => {
  const services = { ...emptyServices(), pricing: pricingSpy() }

  const editHtml = await renderPage(adminPricingPage, services, 'edit=deepseek-flash')
  assert.ok(editHtml.includes('编辑价格：deepseek-flash'))
  assert.ok(editHtml.includes('action="/admin/pricing?action=set"'))
  assert.ok(editHtml.includes('name="model" value="deepseek-flash"'))
  assert.ok(editHtml.includes('value="0.5"'), '输入价要回填')

  const addHtml = await renderPage(adminPricingPage, services, 'add=1&model=brand-new')
  assert.ok(addHtml.includes('添加模型价格'))
  assert.ok(addHtml.includes('name="model" value="brand-new"'), '?model= 预填模型名（未定价表里的「补价格」）')
})

// ── 闸门状态三态：页面不能替 Go 猜开关（写死「默认关」在打开那天就变假话）

function gateFeedSpy(status: Partial<GateFeedStatusView> | null): GateFeedLike {
  return {
    status() {
      if (status === null) throw new Error('桥断')
      return {
        enabled: true,
        goPricing: { ready: true, stale: false, ageMs: 0, ttlMs: 60_000 },
        pricingGateEnabled: null,
        lastError: null,
        failureStreak: 0,
        ...status,
      }
    },
  }
}

test('价格页闸门状态：闸门关着才敢说「现在仍可请求」', async () => {
  const html = await renderPage(adminPricingPage, {
    ...emptyServices(),
    pricing: pricingSpy(),
    gateFeed: gateFeedSpy({ pricingGateEnabled: false }),
  })
  assert.ok(html.includes('仍可请求'), '闸门关：要明确说现在还能请求')
  assert.ok(html.includes('MODEL_NOT_PRICED'))
})

test('价格页闸门状态：闸门开着就说会被拒，且给出健康度', async () => {
  const html = await renderPage(adminPricingPage, {
    ...emptyServices(),
    pricing: pricingSpy(),
    gateFeed: gateFeedSpy({ pricingGateEnabled: true }),
  })
  assert.ok(html.includes('已开启'))
  assert.equal(html.includes('仍可请求'), false, '闸门开着时绝不能说仍可请求')
})

test('价格页闸门状态：闸门开着但快照 stale 要报 503（fail-closed）', async () => {
  const html = await renderPage(adminPricingPage, {
    ...emptyServices(),
    pricing: pricingSpy(),
    gateFeed: gateFeedSpy({
      pricingGateEnabled: true,
      goPricing: { ready: true, stale: true, ageMs: 60_000, ttlMs: 15_000 },
    }),
  })
  assert.ok(html.includes('PRICING_SNAPSHOT_UNAVAILABLE') || html.includes('已过期'))
  assert.ok(html.includes('503'))
})

test('价格页闸门状态：读不到状态时说「未知」，不冒充「没开」', async () => {
  for (const gateFeed of [undefined, gateFeedSpy(null), gateFeedSpy({ pricingGateEnabled: null })]) {
    const html = await renderPage(adminPricingPage, {
      ...emptyServices(),
      pricing: pricingSpy(),
      gateFeed,
    })
    assert.ok(html.includes('未知'), '读不到就说未知')
    assert.equal(html.includes('仍可请求'), false, '不知道时不能断言「仍可请求」')
  }
})

test('价格页保存：调到 pricing.set 并记 pricing.write 审计', async () => {
  const pricing = pricingSpy()
  const audit = auditSpy()
  const services = { ...emptyServices(), pricing, audit }
  const location = await runAction(
    adminPricingPage,
    services,
    'set',
    'model=deepseek-flash&inputPerMillion=0.5&outputPerMillion=2&cacheReadPerMillion=0.1&cacheWritePerMillion=',
  )

  assert.equal(location, '/admin/pricing?ok=' + encodeURIComponent('价格已保存'))
  assert.deepEqual(pricing.sets, [
    { model: 'deepseek-flash', input: { inputPerMillion: '0.5', outputPerMillion: '2', cacheReadPerMillion: '0.1' } },
  ])
  assert.equal(audit.entries.at(-1)?.action, 'pricing.write')
  assert.equal(audit.entries.at(-1)?.targetId, 'deepseek-flash')
})

test('价格页删除：调到 pricing.remove 并记 pricing.remove 审计', async () => {
  const pricing = pricingSpy()
  const audit = auditSpy()
  const services = { ...emptyServices(), pricing, audit }
  const location = await runAction(adminPricingPage, services, 'remove', 'model=deepseek-flash')

  assert.equal(location, '/admin/pricing?ok=' + encodeURIComponent('价格已删除'))
  assert.deepEqual(pricing.removes, ['deepseek-flash'])
  assert.equal(audit.entries.at(-1)?.action, 'pricing.remove')
})
