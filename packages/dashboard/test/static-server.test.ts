/**
 * 静态服务的行为测试。
 *
 * 全部用 Node 直接打 HTTP，不开真浏览器：这里验的是「发什么字节、带什么头、
 * 状态码对不对」，与浏览器渲染无关。
 *
 * 覆盖的任务书条目：
 * - 静态文件 200 + `Content-Type` + 哈希资源 `immutable`；
 * - 页面路由回退 200；
 * - **不存在的静态文件 404**（不许回退成 index.html）；
 * - HTML 有内联 script 时 CSP 头含 nonce，且响应体里那段 script 真带 nonce，
 *   外部脚本不要求；
 * - 方法限制、Host 限制、路径穿越、HEAD。
 */
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { StaticServer } from '../src/static-server.ts'

const INLINE_SCRIPT = '<script>self.__next_f=self.__next_f||[]</script>'
const EXTERNAL_SCRIPT = '<script src="/_next/static/chunk-a1b2c3.js" defer></script>'

interface Fixture {
  readonly server: StaticServer
  readonly base: string
  readonly dir: string
}

async function fixture(t: TestContext): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzy-dashboard-'))
  await mkdir(join(dir, '_next', 'static'), { recursive: true })
  await mkdir(join(dir, 'dashboard'), { recursive: true })
  await mkdir(join(dir, 'auth', 'v2', 'login'), { recursive: true })
  await writeFile(
    join(dir, 'index.html'),
    `<!doctype html><html lang="zh-CN"><head>${INLINE_SCRIPT}${EXTERNAL_SCRIPT}</head><body>DizzyAPI</body></html>`,
    'utf8',
  )
  await writeFile(join(dir, 'dashboard', 'index.html'), '<!doctype html><html><body>仪表盘</body></html>', 'utf8')
  await writeFile(
    join(dir, 'auth', 'v2', 'login', 'index.html'),
    '<!doctype html><html><body>登录</body></html>',
    'utf8',
  )
  await writeFile(join(dir, '_next', 'static', 'chunk-a1b2c3.js'), 'self.x=1;', 'utf8')
  await writeFile(join(dir, '_next', 'static', 'app-a1b2c3.css'), 'body{color:#000}', 'utf8')
  await writeFile(join(dir, 'favicon.ico'), Buffer.from([0, 0, 1, 0]))

  const server = new StaticServer({ distDir: dir })
  await server.start(0)
  const port = server.address?.port
  assert.equal(typeof port, 'number')
  t.after(async () => {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })
  return { server, base: `http://127.0.0.1:${port}`, dir }
}

/** 用 node:http 发一个请求（可以改 Host 头，fetch 改不了）。 */
function send(
  base: string,
  path: string,
  options: { readonly method?: string; readonly host?: string } = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const url = new URL(path, base)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: options.host === undefined ? {} : { host: options.host },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

// ───────────────────────────── 页面路由 ─────────────────────────────

test('页面路由：/ 发根 index.html，Content-Type 是 html、不缓存', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.match(res.body, /DizzyAPI/)
})

test('页面路由：/dashboard 回退到 dist/dashboard/index.html', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/dashboard')
  assert.equal(res.status, 200)
  assert.match(res.body, /仪表盘/)
})

test('页面路由：带尾斜杠同样命中', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/auth/v2/login/')
  assert.equal(res.status, 200)
  assert.match(res.body, /登录/)
})

test('页面路由：不存在的路由回退 SPA 外壳（200，不是 404）', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/no-such-page')
  assert.equal(res.status, 200)
  assert.match(res.body, /DizzyAPI/)
})

// ───────────────────────────── 静态资源 ─────────────────────────────

test('静态资源：_next/static 下的 js 带 immutable 与正确 Content-Type', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/_next/static/chunk-a1b2c3.js')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  assert.equal(res.body, 'self.x=1;')
})

test('静态资源：css 也是 immutable', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/_next/static/app-a1b2c3.css')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
})

test('静态资源：不存在的 js 必须 404，不许回退成 index.html', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/_next/static/missing-a1b2c3.js')
  assert.equal(res.status, 404)
  assert.doesNotMatch(res.body, /DizzyAPI/)
})

test('静态资源：不存在的图片 404（带扩展名就算资源）', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/not-exist.png')
  assert.equal(res.status, 404)
})

test('静态资源：存在的 ico 照常发，未知类型不瞎猜', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/favicon.ico')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'image/x-icon')
})

// ───────────────────────────── CSP ─────────────────────────────

test('CSP：HTML 响应头带 nonce 的 script-src，且内联 script 真带同一个 nonce', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/')
  const csp = String(res.headers['content-security-policy'])
  const match = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)
  assert.ok(match, `CSP 头里没有 nonce：${csp}`)
  const nonce = match[1]
  assert.match(csp, /script-src 'self' 'nonce-/)
  assert.match(res.body, new RegExp(`<script nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">`))
})

test('CSP：外部脚本不加 nonce（它靠 self 过）', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/')
  assert.match(res.body, /<script src="\/_next\/static\/chunk-a1b2c3\.js" defer><\/script>/)
})

test('CSP：每次响应换一个 nonce', async (t) => {
  const { base } = await fixture(t)
  const first = String((await send(base, '/')).headers['content-security-policy'])
  const second = String((await send(base, '/')).headers['content-security-policy'])
  assert.notEqual(first, second)
})

test('CSP：不放行 script-src unsafe-inline / unsafe-eval', async (t) => {
  const { base } = await fixture(t)
  const csp = String((await send(base, '/')).headers['content-security-policy'])
  const scriptSrc = /script-src([^;]*)/.exec(csp)?.[1] ?? ''
  assert.doesNotMatch(scriptSrc, /unsafe-inline/)
  assert.doesNotMatch(scriptSrc, /unsafe-eval/)
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /frame-ancestors 'none'/)
  // 只放开 style 属性，`<style>` 元素仍受 style-src 'self' 约束。
  assert.match(csp, /style-src 'self'/)
  assert.match(csp, /style-src-attr 'unsafe-inline'/)
})

test('CSP：静态资源不背 CSP 头（只有 HTML 需要）', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/_next/static/chunk-a1b2c3.js')
  assert.equal(res.headers['content-security-policy'], undefined)
})

// ───────────────────────────── 协议细节 ─────────────────────────────

test('方法：POST 一律 405 且带 Allow', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/', { method: 'POST' })
  assert.equal(res.status, 405)
  assert.equal(res.headers.allow, 'GET, HEAD')
})

test('方法：HEAD 只回头不回体', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/', { method: 'HEAD' })
  assert.equal(res.status, 200)
  assert.equal(res.body, '')
  assert.ok(Number(res.headers['content-length']) > 0)
})

test('Host：不是回环地址就 421（挡 DNS rebinding）', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/', { host: 'evil.example.com' })
  assert.equal(res.status, 421)
})

test('路径穿越：编码过的 .. 被拒（400），读不到产物目录外的文件', async (t) => {
  const { base } = await fixture(t)
  // `%2f` 不会被 URL 规范化掉，解码后就是 `..` 段 —— 这一条才真正打到穿越检查上。
  const res = await send(base, '/..%2f..%2fetc/passwd')
  assert.equal(res.status, 400)
  assert.doesNotMatch(res.body, /root:/)
})

test('路径穿越：被 URL 规范化的 .. 也读不到产物外的文件（只会落到 SPA 兜底）', async (t) => {
  const { base } = await fixture(t)
  const res = await send(base, '/%2e%2e/%2e%2e/etc/passwd')
  assert.doesNotMatch(res.body, /root:/)
  assert.match(res.body, /DizzyAPI/)
})

test('产物不存在：根 index.html 也没有时 503，且文案说清原因', async (t) => {
  const empty = await mkdtemp(join(tmpdir(), 'dizzy-dashboard-empty-'))
  const server = new StaticServer({ distDir: empty })
  await server.start(0)
  t.after(async () => {
    await server.stop()
    await rm(empty, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address?.port}`
  const res = await send(base, '/dashboard')
  assert.equal(res.status, 503)
  assert.match(res.body, /静态产物不存在/)
})
