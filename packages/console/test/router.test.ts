import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createRouter,
  joinBase,
  matchRoutes,
  normalizeBase,
  normalizePath,
  parseQuery,
  stripBase,
} from '../assets/lib/router.js'

test('base 归一化与剥离', () => {
  assert.equal(normalizeBase('/'), '')
  assert.equal(normalizeBase('/app/'), '/app')
  assert.equal(normalizeBase(''), '')
  assert.throws(() => normalizeBase('app'), /base 必须以 \/ 开头/)

  assert.equal(stripBase('/app/console', '/app'), '/console')
  assert.equal(stripBase('/app', '/app'), '/')
  assert.equal(stripBase('/appx/console', '/app'), null)
  assert.equal(stripBase('/console/', ''), '/console')
})

test('路径归一化与 href', () => {
  assert.equal(normalizePath(''), '/')
  assert.equal(normalizePath('/admin/'), '/admin')
  assert.equal(normalizePath('admin'), '/admin')
  assert.equal(joinBase('/app', '/console'), '/app/console')
  assert.equal(joinBase('', '/console'), '/console')
})

test('查询串解析：重复键取最后一个', () => {
  assert.deepEqual(parseQuery('?a=1&b=x%20y&a=2'), { a: '2', b: 'x y' })
  assert.deepEqual(parseQuery(''), {})
})

test('路径匹配：静态段优先、支持参数与通配', () => {
  const routes = [
    { path: '/admin/accounts/:id', data: 'detail' },
    { path: '/admin/accounts', data: 'list' },
    { path: '/admin/*', data: 'fallback' },
    { path: '/console', data: 'console' },
  ]
  assert.equal(matchRoutes(routes, '/admin/accounts')?.route.data, 'list')
  assert.deepEqual(matchRoutes(routes, '/admin/accounts/acc_1')?.params, { id: 'acc_1' })
  assert.deepEqual(matchRoutes(routes, '/admin/accounts/a%20b')?.params, { id: 'a b' })
  assert.equal(matchRoutes(routes, '/admin/settings')?.route.data, 'fallback')
  assert.equal(matchRoutes(routes, '/console/')?.route.data, 'console')
  assert.equal(matchRoutes(routes, '/nope'), null)
})

test('createRouter：base、resolve 与 href', () => {
  const router = createRouter({
    base: '/app/',
    routes: [{ path: '/console', data: 'console' }, { path: '/admin/accounts', data: 'accounts' }],
  })
  assert.equal(router.base, '/app')
  assert.equal(router.match('/app/admin/accounts')?.route.data, 'accounts')
  assert.equal(router.match('/admin/accounts'), null, '不在 base 下不应命中')

  const resolved = router.resolve('/app/admin/accounts', '?provider=claude&limit=2')
  assert.equal(resolved?.route.data, 'accounts')
  assert.deepEqual(resolved?.query, { provider: 'claude', limit: '2' })
  assert.equal(router.href('/admin/accounts', { provider: 'claude' }), '/app/admin/accounts?provider=claude')
  assert.equal(router.href('/console'), '/app/console')
})

test('navigate 使用注入的 window.history', () => {
  const calls: unknown[][] = []
  const fakeWindow = {
    history: {
      pushState: (...args: unknown[]) => calls.push(['push', ...args]),
      replaceState: (...args: unknown[]) => calls.push(['replace', ...args]),
    },
    location: { origin: 'http://127.0.0.1:7790', pathname: '/app/console', search: '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { addEventListener: () => undefined, removeEventListener: () => undefined },
  }
  const router = createRouter({
    base: '/app',
    routes: [],
    windowRef: fakeWindow as unknown as Parameters<typeof createRouter>[0]['windowRef'],
  })
  router.navigate('/admin/accounts')
  router.navigate('/console', { replace: true, state: { from: 'test' } })
  assert.deepEqual(calls, [
    ['push', null, '', '/app/admin/accounts'],
    ['replace', { from: 'test' }, '', '/app/console'],
  ])
})
