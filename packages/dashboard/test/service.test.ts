/**
 * 插件的生命周期与配置测试。
 *
 * 这里不碰 Next 构建产物：自己造一个最小 `dist/`，验的是「插件把服务起起来、
 * 停在停掉时、配置非法明确失败」这三件事。真实产物的字节由
 * `static-server.test.ts` 的同类用例覆盖。
 */
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

import { Context } from 'cordis'
import { isIssueList } from '@dizzyapi/plugin-kit'

import DashboardService, { DASHBOARD_DEFAULTS, defaultDistDir, validateDashboardConfig } from '../src/index.ts'

/** 造一个只有 `/` 的最小产物目录。 */
async function distFixture(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dizzy-dashboard-dist-'))
  await mkdir(join(dir, '_next', 'static'), { recursive: true })
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><script>x</script></body></html>', 'utf8')
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  return dir
}

function resolved(over: Record<string, unknown> = {}) {
  const value = validateDashboardConfig(over)
  assert.ok(!isIssueList(value), '配置应该合法')
  return value
}

/** 打一个请求；连接被拒时返回 `undefined`（用来验端口确实关了）。 */
function probe(port: number, path = '/'): Promise<number | undefined> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', () => resolve(undefined))
    req.end()
  })
}

// ───────────────────────────── 配置 ─────────────────────────────

test('配置：空对象走默认端口 7792 且产物目录指向 packages/dashboard/dist', () => {
  const config = resolved()
  assert.equal(config.port, DASHBOARD_DEFAULTS.port)
  assert.equal(config.enabled, true)
  assert.ok(config.distDir.endsWith(`${'/'}dist`) || config.distDir.endsWith('\\dist'))
  assert.deepEqual(config.extraAllowedHosts, [])
})

test('配置：默认产物目录与 defaultDistDir() 一致', () => {
  assert.equal(resolved().distDir, defaultDistDir())
})

test('配置：显式值被保留，Host 白名单按逗号拆开', () => {
  const config = resolved({ port: 0, distDir: '/tmp/x', enabled: false, extraAllowedHosts: 'a.test, b.test' })
  assert.equal(config.port, 0)
  assert.equal(config.distDir, '/tmp/x')
  assert.equal(config.enabled, false)
  assert.deepEqual(config.extraAllowedHosts, ['a.test', 'b.test'])
})

test('配置：非法值明确失败，不静默降级', () => {
  for (const bad of [{ port: -1 }, { port: 65536 }, { enabled: 'yes' }, { distDir: '' }, { unknownKey: 1 }]) {
    assert.ok(isIssueList(validateDashboardConfig(bad)), `${JSON.stringify(bad)} 应该被拒`)
  }
})

// ───────────────────────────── 生命周期 ─────────────────────────────

test('生命周期：start 后监听回环端口并能取到首页', async (t) => {
  const distDir = await distFixture(t)
  const ctx = new Context()
  const service = new DashboardService(ctx, resolved({ port: 0, distDir }))
  t.after(async () => {
    await service.stop()
    try {
      await ctx.root.fiber.dispose()
    } catch {
      // cordis 4 的 dispose 返回值是 void，测试清理忽略异常。
    }
  })

  await service.start()
  const port = service.address?.port
  assert.equal(typeof port, 'number')
  assert.equal(service.address?.host, '127.0.0.1')
  assert.equal(await probe(port as number), 200)
})

test('生命周期：stop 之后端口不再监听（禁用不复用旧监听）', async (t) => {
  const distDir = await distFixture(t)
  const ctx = new Context()
  const service = new DashboardService(ctx, resolved({ port: 0, distDir }))
  t.after(async () => {
    try {
      await ctx.root.fiber.dispose()
    } catch {
      // 同上。
    }
  })

  await service.start()
  const port = service.address?.port as number
  assert.equal(await probe(port), 200)

  await service.stop()
  assert.equal(service.address, undefined)
  assert.equal(await probe(port), undefined, '端口应该连不上了')

  // stop 幂等。
  await service.stop()
})

test('生命周期：enabled=false 时不起监听', async (t) => {
  const distDir = await distFixture(t)
  const ctx = new Context()
  const service = new DashboardService(ctx, resolved({ port: 0, distDir, enabled: false }))
  t.after(async () => {
    try {
      await ctx.root.fiber.dispose()
    } catch {
      // 同上。
    }
  })

  await service.start()
  assert.equal(service.address, undefined)
  assert.equal(service.origin, undefined)
})

test('生命周期：端口被占用时明确失败，不静默换端口', async (t) => {
  const distDir = await distFixture(t)
  const ctxA = new Context()
  const ctxB = new Context()
  const first = new DashboardService(ctxA, resolved({ port: 0, distDir }))
  const second = new DashboardService(ctxB, resolved({ port: 0, distDir }))
  t.after(async () => {
    await first.stop()
    await second.stop()
    for (const ctx of [ctxA, ctxB]) {
      try {
        await ctx.root.fiber.dispose()
      } catch {
        // 同上。
      }
    }
  })

  await first.start()
  const taken = first.address?.port as number
  const conflicting = new DashboardService(new Context(), resolved({ port: taken, distDir }))
  await assert.rejects(() => conflicting.start(), /EADDRINUSE|address already in use/i)
  assert.equal(conflicting.address, undefined)
})

test('真实产物：已构建时 dist/index.html 能直接发出来（未构建则跳过）', async (t) => {
  if (!existsSync(join(defaultDistDir(), 'index.html'))) {
    t.skip('尚未构建 packages/dashboard/dist，跳过')
    return
  }
  const ctx = new Context()
  const service = new DashboardService(ctx, resolved({ port: 0 }))
  t.after(async () => {
    await service.stop()
    try {
      await ctx.root.fiber.dispose()
    } catch {
      // 同上。
    }
  })
  await service.start()
  assert.equal(await probe(service.address?.port as number), 200)
})
