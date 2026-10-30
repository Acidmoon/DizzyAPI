/**
 * 服务端渲染前端的测试。
 *
 * 覆盖：配置校验、路由表唯一性、登录页、未登录重定向、静态资源、404、金额换算。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from 'cordis'
import { PageTemplateService } from '@dizzyapi/plugin-page-template'
import { FontSmileyService } from '@dizzyapi/plugin-font-smiley'
import { WebService } from '../src/service.ts'
import { listenFetchable } from './helpers/fetch-port.ts'
import { PAGES } from '../src/pages/index.ts'
import { WEB_DEFAULTS, validateWebConfig, type ResolvedWebConfig } from '../src/config.ts'
import { formatYuan, microsToYuan } from '../src/forms.ts'
import { bucketDaily, hourlyBuckets } from '../src/series.ts'

async function boot(): Promise<{ ctx: Context; base: string; close(): Promise<void> }> {
  // port:0 仍由 OS 分配；拿到端口后若落在 fetch 屏蔽集合里，辅助会关掉重来。
  const started = await listenFetchable(async () => {
    const ctx = new Context()
    await ctx.plugin(PageTemplateService)
    await ctx.plugin(FontSmileyService)
    await ctx.plugin(WebService, { port: 0 })
    const web = ctx.get('web') as WebService
    for (let i = 0; i < 100; i += 1) {
      if (web.address !== undefined) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const address = web.address
    assert.ok(address !== undefined, 'web 服务没有启动')
    return {
      app: ctx,
      port: address.port,
      close: async () => {
        await web.close()
      },
    }
  })
  return {
    ctx: started.app,
    base: started.base,
    close: async () => {
      await started.close()
    },
  }
}

test('配置：默认值、非法端口、未知字段', () => {
  const resolved = validateWebConfig({}) as ResolvedWebConfig
  assert.equal(resolved.port, WEB_DEFAULTS.port)
  assert.equal(resolved.sessionCookieName, 'dizzyapi_session')

  assert.ok(Array.isArray(validateWebConfig({ port: 70000 })))
  assert.ok(Array.isArray(validateWebConfig({ nope: 1 })))
  assert.ok(Array.isArray(validateWebConfig({ sessionCookieName: 'bad name' })))
})

test('路由表：路径唯一，每页有标题，登录 / 注册不要求登录', () => {
  const paths = PAGES.map((page) => page.path)
  assert.equal(new Set(paths).size, paths.length)
  for (const page of PAGES) {
    assert.ok(page.title.length > 0)
  }
  const login = PAGES.find((page) => page.path === '/login')
  const register = PAGES.find((page) => page.path === '/register')
  assert.equal(login?.auth, false)
  assert.equal(register?.auth, false)
  assert.equal(PAGES.filter((page) => page.area === 'admin').every((page) => page.admin === true), true)
})

test('金额：微元 ↔ 元，负数与进位都正确', () => {
  assert.equal(formatYuan(1_137_940_000n), '¥1,137.94')
  assert.equal(formatYuan(0n), '¥0.00')
  assert.equal(formatYuan(-5_000_000n), '-¥5.00')
  assert.equal(microsToYuan('2500000'), 2.5)
})

test('序列：30 天压成 7 个桶，金额用整数微元累加', () => {
  const daily = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-10-${String(index + 1).padStart(2, '0')}`,
    costMicros: '1000000',
    requests: 1,
    totalTokens: 10,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
  }))
  const buckets = bucketDaily(daily)
  assert.equal(buckets.length, 7)
  assert.equal(buckets[0].date, '2026-10-01')
  assert.equal(buckets[6].date, '2026-10-26')
  const total = buckets.reduce((sum, point) => sum + BigInt(point.costMicros), 0n)
  assert.equal(total, 30_000_000n)
  assert.equal(bucketDaily(daily.slice(0, 5)).length, 5)
})

test('小时桶：最近 7 个整点聚合，空小时补 0', () => {
  const toMs = Date.parse('2026-10-23T12:30:00+08:00')
  const rows = [
    { startedAt: '2026-10-23T12:10:00+08:00', costMicros: '1000000' },
    { startedAt: '2026-10-23T12:50:00+08:00', costMicros: '2000000' },
    { startedAt: '2026-10-23T09:05:00+08:00', costMicros: '500000' },
  ]
  const buckets = hourlyBuckets(rows, toMs, 7)
  assert.equal(buckets.length, 7)
  assert.equal(buckets[buckets.length - 1].costMicros, '3000000')
  assert.ok(buckets.some((bucket) => bucket.costMicros === '500000'))
  assert.ok(buckets.every((bucket) => /^\d{2}:00$/.test(bucket.label)))
  const total = buckets.reduce((sum, bucket) => sum + BigInt(bucket.costMicros), 0n)
  assert.equal(total, 3_500_000n)
})

test('HTTP：登录页 200，未登录访问控制台 302 到 /login', async () => {
  const app = await boot()
  try {
    const login = await fetch(`${app.base}/login`)
    assert.equal(login.status, 200)
    const html = await login.text()
    assert.ok(html.includes('登录 DizzyAPI'))
    assert.ok(html.includes('name="email"'))
    assert.ok(html.includes('/assets/app.css'))
    // 资源地址必须带内容哈希：这些字节是 immutable 长缓存，路径固定就会被缓存一年。
    assert.match(html, /\/assets\/app\.css\?v=[0-9a-f]{8}/)
    assert.match(html, /\/assets\/app\.js\?v=[0-9a-f]{8}/)
    // 死代码护栏：没在用的库（htmx / floating-ui）不许挂在页面上。
    assert.ok(!html.includes('htmx.min.js'), 'htmx 还没人用，不该出现在页面里')
    assert.ok(!html.includes('floating-ui'), 'floating-ui 还没人用，不该出现在页面里')
    // 真正在用的两个必须都在，且按契约顺序（tom-select 先于 flatpickr，app.js 最后）
    const tsIdx = html.indexOf('tom-select.complete.min.js')
    const fpIdx = html.indexOf('flatpickr.min.js')
    const appIdx = html.indexOf('/assets/app.js')
    assert.ok(tsIdx > 0 && fpIdx > tsIdx, '脚本顺序：tom-select 必须在 flatpickr 之前')
    assert.ok(appIdx > fpIdx, 'app.js 必须最后加载')
    // vendor 的 URL 同样带哈希
    assert.match(html, /vendor\/tom-select\/tom-select\.complete\.min\.js\?v=[0-9a-f]{8}/)

    const usage = await fetch(`${app.base}/console/usage`, { redirect: 'manual' })
    assert.equal(usage.status, 302)
    assert.equal(usage.headers.get('location'), '/login?err=' + encodeURIComponent('请先登录'))
  } finally {
    await app.close()
  }
})

test('HTTP：静态资源、404、跨站 POST 被拒', async () => {
  const app = await boot()
  try {
    const css = await fetch(`${app.base}/assets/app.css`)
    assert.equal(css.status, 200)
    assert.ok((await css.text()).includes('--bg-base: #151517'))

    const missing = await fetch(`${app.base}/nope`)
    assert.equal(missing.status, 404)

    const cross = await fetch(`${app.base}/login?action=login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      body: 'email=a%40b.c&password=x',
    })
    assert.equal(cross.status, 500)
  } finally {
    await app.close()
  }
})

test('HTTP：登录 POST 在鉴权服务缺失时回到登录页带错误', async () => {
  const app = await boot()
  try {
    const response = await fetch(`${app.base}/login?action=login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'email=a%40b.c&password=x',
      redirect: 'manual',
    })
    assert.equal(response.status, 303)
    assert.ok((response.headers.get('location') ?? '').startsWith('/login?err='))
  } finally {
    await app.close()
  }
})

test('HTTP：字体 @font-face 追加进 app.css，woff2 可下载', async () => {
  const app = await boot()
  try {
    const css = await (await fetch(`${app.base}/assets/app.css`)).text()
    assert.ok(css.includes('@font-face'))
    assert.ok(css.includes("font-family: 'Smiley Sans'"))
    assert.ok(css.includes('/assets/fonts/smiley-sans.woff2'))
    // 字体 URL 自己带版本串：它是 immutable 一年缓存，路径固定就换不动。
    assert.match(css, /\/assets\/fonts\/smiley-sans\.woff2\?v=[0-9a-f]{8}/)

    const font = await fetch(`${app.base}/assets/fonts/smiley-sans.woff2`)
    assert.equal(font.status, 200)
    assert.equal(font.headers.get('content-type'), 'font/woff2')
    const bytes = Buffer.from(await font.arrayBuffer())
    assert.equal(bytes.subarray(0, 4).toString('latin1'), 'wOF2')
  } finally {
    await app.close()
  }
})

test('HTTP：页面 `<link>` 里的 app.css 版本串 == 实际发出的正文哈希（含字体块）', async () => {
  // 这是「哈希洞」的端到端守护：正文是 `APP_CSS_BODY + fontSmiley.css()`，
  // 而字体块要运行时才有。只要有一边漏算字体，这条就红。
  const app = await boot()
  try {
    const html = await (await fetch(`${app.base}/login`)).text()
    const href = html.match(/<link rel="stylesheet" href="([^"]+)"/)?.[1]
    assert.ok(href !== undefined, '登录页没有 <link rel="stylesheet">')
    assert.match(href, /^\/assets\/app\.css\?v=[0-9a-f]{8}$/)

    const css = await (await fetch(`${app.base}${href}`)).text()
    // 用抓到的正文复算哈希，必须与页面给的版本串一致
    const { shortHash } = await import('../src/asset-version.ts')
    assert.equal(href, `/assets/app.css?v=${shortHash(css)}`)
  } finally {
    await app.close()
  }
})
