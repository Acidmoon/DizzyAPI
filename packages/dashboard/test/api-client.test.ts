/**
 * 传输层的护栏。
 *
 * 这一层出问题会**全局出事**，而且症状都很有欺骗性，所以每条都单独钉住：
 * - 漏 `X-Requested-With: dizzyapi` → 403 `API_REQUEST_HEADER_REQUIRED`，看起来像「没登录」；
 * - 漏 `credentials: 'include'` → 永远拿不到会话，看起来像「登录不生效」；
 * - 跟重定向 → 拿到登录页 HTML 当 JSON 解析，看起来像「接口返回格式错」；
 * - 不设超时 → 一个卡住的请求把界面永远挂在「加载中」（owner 抱怨的那类「点了没反应」）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ApiClient,
  ApiError,
  DEFAULT_TIMEOUT_MS,
  buildQuery,
} from '../app/src/lib/api/client.ts'
import { fakeFetch, requestHeaderOf } from './helpers/fake-fetch.ts'

test('每个请求都带 X-Requested-With: dizzyapi（GET 也带）', async () => {
  const fake = fakeFetch({ json: { ok: true } })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await client.request('/api/health')
  assert.equal(requestHeaderOf(fake.first()), 'dizzyapi')
})

test('会话只走 HttpOnly cookie：credentials 必须是 include，redirect 必须是 manual', async () => {
  const fake = fakeFetch({ json: {} })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await client.request('/api/session')
  assert.equal(fake.first().credentials, 'include')
  assert.equal(fake.first().redirect, 'manual')
})

test('只有带 body 时才发 Content-Type: application/json', async () => {
  const fake = fakeFetch({ json: {} }, { json: {} })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await client.request('/api/keys')
  assert.equal(fake.calls[0]?.headers['content-type'], undefined)
  await client.request('/api/keys', { method: 'POST', body: { name: 'x' } })
  assert.equal(fake.last().headers['content-type'], 'application/json')
  assert.equal(fake.last().body, '{"name":"x"}')
})

test('GET 是默认方法；body 不进查询串', async () => {
  const fake = fakeFetch({ json: {} })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await client.request('/api/pricing')
  assert.equal(fake.first().method, 'GET')
  assert.equal(fake.first().url, '/api/pricing')
})

test('查询串：空值丢弃、逐项 encodeURIComponent', () => {
  assert.equal(buildQuery(undefined), '')
  assert.equal(buildQuery({}), '')
  assert.equal(buildQuery({ a: undefined, b: null, c: '', d: 1 }), '?d=1')
  assert.equal(buildQuery({ q: 'a b&c' }), '?q=a%20b%26c')
  assert.equal(buildQuery({ range: '7d', limit: 20 }), '?range=7d&limit=20')
})

test('基地址拼在路径前；路径不带前导斜杠也接受', () => {
  const client = new ApiClient({ baseUrl: 'http://127.0.0.1:7791' })
  assert.equal(client.url('/api/health'), 'http://127.0.0.1:7791/api/health')
  assert.equal(client.url('api/health'), 'http://127.0.0.1:7791/api/health')
  assert.equal(client.url('/api/health', { limit: 1 }), 'http://127.0.0.1:7791/api/health?limit=1')
})

test('204 与空响应体都回 undefined，不炸 JSON 解析', async () => {
  const fake = fakeFetch({ status: 204 }, { status: 200, text: '' })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  assert.equal(await client.request('/api/anything'), undefined)
  assert.equal(await client.request('/api/anything'), undefined)
})

test('错误信封解析成结构化 ApiError（code / message / requestId / status）', async () => {
  const fake = fakeFetch({
    status: 403,
    json: { error: { code: 'API_REQUEST_HEADER_REQUIRED', message: '必须带请求头', requestId: 'req-1' } },
  })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await assert.rejects(
    () => client.request('/api/keys'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'API_REQUEST_HEADER_REQUIRED')
      assert.equal(error.message, '必须带请求头')
      assert.equal(error.requestId, 'req-1')
      assert.equal(error.status, 403)
      assert.equal(error.isForbidden, true)
      return true
    },
  )
})

test('响应头里有 X-Request-Id 时，错误没有 requestId 就回落到它', async () => {
  const fake = fakeFetch({
    status: 500,
    headers: { 'X-Request-Id': 'req-from-header' },
    json: { error: { code: 'API_INTERNAL', message: '内部错误' } },
  })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await assert.rejects(
    () => client.request('/api/keys'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.requestId, 'req-from-header')
      return true
    },
  )
})

test('不是错误信封时按状态码兜底（反代返回 HTML 错误页也认）', async () => {
  const fake = fakeFetch({ status: 502, text: '<html>bad gateway</html>' })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await assert.rejects(
    () => client.request('/api/keys'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'HTTP_502')
      assert.equal(error.status, 502)
      return true
    },
  )
})

test('200 但不是 JSON（反代把页面当接口回）→ API_RESPONSE_INVALID', async () => {
  const fake = fakeFetch({ status: 200, text: '<!doctype html><title>登录</title>' })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await assert.rejects(
    () => client.request('/api/session'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'API_RESPONSE_INVALID')
      return true
    },
  )
})

test('401 触发 onUnauthorized 回调（客户端层不自己跳路由）', async () => {
  const fake = fakeFetch({ status: 401, json: { error: { code: 'AUTH_SESSION_INVALID', message: '请重新登录' } } })
  const seen: ApiError[] = []
  const client = new ApiClient({
    fetchImpl: fake.fetch,
    onUnauthorized: (error) => {
      seen.push(error)
    },
  })
  await assert.rejects(() => client.request('/api/session'))
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.isUnauthorized, true)
})

test('403 不触发 onUnauthorized（会话有效但没权限，跳登录页是错的）', async () => {
  const fake = fakeFetch({ status: 403, json: { error: { code: 'AUTH_FORBIDDEN', message: '没权限' } } })
  let called = 0
  const client = new ApiClient({
    fetchImpl: fake.fetch,
    onUnauthorized: () => {
      called += 1
    },
  })
  await assert.rejects(() => client.request('/api/users'))
  assert.equal(called, 0)
})

test('超时 → API_TIMEOUT（默认 15 秒，可覆盖）', async () => {
  const fake = fakeFetch({ abort: true })
  const client = new ApiClient({ fetchImpl: fake.fetch, timeoutMs: 5 })
  await assert.rejects(
    () => client.request('/api/keys'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'API_TIMEOUT')
      assert.equal(error.status, 0)
      return true
    },
  )
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000)
})

test('网络层异常 → API_NETWORK_ERROR', async () => {
  const client = new ApiClient({
    fetchImpl: (() => Promise.reject(new Error('socket hang up'))) as typeof fetch,
  })
  await assert.rejects(
    () => client.request('/api/keys'),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'API_NETWORK_ERROR')
      return true
    },
  )
})

test('requestVoid 只关心状态码，不读响应体', async () => {
  const fake = fakeFetch({ status: 204 })
  const client = new ApiClient({ fetchImpl: fake.fetch })
  await client.requestVoid('/api/keys/x', { method: 'DELETE' })
  assert.equal(fake.last().method, 'DELETE')
})
