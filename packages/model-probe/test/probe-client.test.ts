/**
 * 探测结果分类的护栏。
 *
 * 这组用例护的是**假红**那条硬要求：`probe-error`（探测自己出问题）绝不能
 * 被算成 `failed`（模型真挂了）。写错一行的代价是「全站模型一起变红，
 * 但模型一个都没挂」，会把人引去查一个不存在的故障。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractErrorCode, runProbe } from '../src/probe-client.ts'

const NOW = 1_700_000_000_000

function deps(overrides: Partial<Parameters<typeof runProbe>[2]> = {}): Parameters<typeof runProbe>[2] {
  return {
    fetch: (async () => new Response('{}', { status: 200 })) as typeof fetch,
    now: () => NOW,
    gatewayBaseUrl: 'http://127.0.0.1:8080',
    timeoutMs: 15_000,
    degradedThresholdMs: 6_000,
    ...overrides,
  }
}

/** 让 fetch 回一个固定响应。 */
function respond(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch
}

/** 让 fetch 抛一个指定 name 的错误。 */
function fail(name: string): typeof fetch {
  return (async () => {
    const error = new Error('boom')
    error.name = name
    throw error
  }) as unknown as typeof fetch
}

test('2xx 且够快 → ok；2xx 但超过阈值 → degraded', async () => {
  const fast = await runProbe({ model: 'm' }, 'tok', deps({ fetch: respond(200, '{"ok":true}') }))
  assert.equal(fast.status, 'ok')
  assert.equal(fast.errorCode, null)
  assert.equal(fast.httpStatus, 200)

  // 时钟每次被问都往后走 7 秒：模拟「请求成功但是很慢」。
  let calls = 0
  const slow = await runProbe(
    { model: 'm' },
    'tok',
    deps({
      fetch: respond(200, '{}'),
      now: () => (calls++ === 0 ? NOW : NOW + 7_000),
    }),
  )
  assert.equal(slow.status, 'degraded')
  assert.equal(slow.errorCode, null)
})

test('402 INSUFFICIENT_BALANCE → probe-error（不是 failed）', async () => {
  const sample = await runProbe(
    { model: 'm' },
    'tok',
    deps({
      fetch: respond(402, JSON.stringify({ error: { message: '余额不足', code: 'INSUFFICIENT_BALANCE' } })),
    }),
  )
  assert.equal(sample.status, 'probe-error')
  assert.equal(sample.errorCode, 'INSUFFICIENT_BALANCE')
  assert.equal(sample.httpStatus, 402)
})

test('401 / 402 即使解析不出 code 也归 probe-error', async () => {
  for (const status of [401, 402]) {
    const sample = await runProbe({ model: 'm' }, 'tok', deps({ fetch: respond(status, 'not json') }))
    assert.equal(sample.status, 'probe-error', `${status} 应归 probe-error`)
    assert.equal(sample.errorCode, `http_${status}`)
  }
})

test('403 MODEL_NOT_PRICED / PRICING_SNAPSHOT_UNAVAILABLE → probe-error', async () => {
  for (const code of ['MODEL_NOT_PRICED', 'PRICING_SNAPSHOT_UNAVAILABLE', 'QUOTA_SNAPSHOT_UNAVAILABLE']) {
    const sample = await runProbe(
      { model: 'm' },
      'tok',
      deps({ fetch: respond(403, JSON.stringify({ error: { code } })) }),
    )
    assert.equal(sample.status, 'probe-error', `${code} 应归 probe-error`)
    assert.equal(sample.errorCode, code)
  }
})

test('503 MODEL_NOT_SERVED / 500 → failed（模型真不可用）', async () => {
  const notServed = await runProbe(
    { model: 'm' },
    'tok',
    deps({ fetch: respond(503, JSON.stringify({ error: { code: 'MODEL_NOT_SERVED' } })) }),
  )
  assert.equal(notServed.status, 'failed')
  assert.equal(notServed.errorCode, 'MODEL_NOT_SERVED')

  const internal = await runProbe({ model: 'm' }, 'tok', deps({ fetch: respond(500, '{}') }))
  assert.equal(internal.status, 'failed')
  assert.equal(internal.errorCode, 'http_500')
})

test('429 → failed（限流是模型侧的容量问题，不是探测自身）', async () => {
  const sample = await runProbe({ model: 'm' }, 'tok', deps({ fetch: respond(429, '{}') }))
  assert.equal(sample.status, 'failed')
})

test('连不上网关 / 超时 → probe-error，且不抛', async () => {
  const refused = await runProbe({ model: 'm' }, 'tok', deps({ fetch: fail('TypeError') }))
  assert.equal(refused.status, 'probe-error')
  assert.equal(refused.errorCode, 'gateway_unreachable')
  assert.equal(refused.httpStatus, null)

  const timeout = await runProbe({ model: 'm' }, 'tok', deps({ fetch: fail('TimeoutError') }))
  assert.equal(timeout.status, 'probe-error')
  assert.equal(timeout.errorCode, 'probe_timeout')
})

test('Anthropic 形状（error.code）与 Gemini 形状（error.reason）都认', () => {
  assert.equal(
    extractErrorCode(JSON.stringify({ type: 'error', error: { type: 'api_error', code: 'MODEL_NOT_SERVED' } })),
    'MODEL_NOT_SERVED',
  )
  assert.equal(
    extractErrorCode(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', reason: 'MODEL_NOT_SERVED' } })),
    'MODEL_NOT_SERVED',
  )
})

test('extractErrorCode 只认短码：长正文、非 JSON、空串一律 null', () => {
  assert.equal(extractErrorCode(''), null)
  assert.equal(extractErrorCode('not json'), null)
  assert.equal(extractErrorCode(JSON.stringify({ error: { message: '上游返回了很长的中文说明' } })), null)
  // 带空格 / 标点的长文本不是稳定码，别把它当 code 落库。
  assert.equal(extractErrorCode(JSON.stringify({ error: { code: 'a code with spaces' } })), null)
  assert.equal(extractErrorCode(JSON.stringify({ error: { code: 'X'.repeat(65) } })), null)
})

test('2xx 但响应体里有顶层 error → failed（上游代理会这么回）', async () => {
  const sample = await runProbe(
    { model: 'm' },
    'tok',
    deps({ fetch: respond(200, JSON.stringify({ error: { code: 'UPSTREAM_ERROR' } })) }),
  )
  assert.equal(sample.status, 'failed')
  assert.equal(sample.errorCode, 'UPSTREAM_ERROR')
})

test('探测请求体是模型名 + 最小 max_tokens，且只带 Bearer 头', async () => {
  let seenUrl = ''
  let seenBody = ''
  let seenAuth: string | undefined
  const capture = (async (url: string, init: RequestInit) => {
    seenUrl = String(url)
    seenBody = String(init.body)
    seenAuth = (init.headers as Record<string, string>).authorization
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch

  await runProbe({ model: 'deepseek-flash' }, 'sk-dz-secret', deps({ fetch: capture }))
  assert.equal(seenUrl, 'http://127.0.0.1:8080/v1/chat/completions')
  assert.equal(seenAuth, 'Bearer sk-dz-secret')
  const body = JSON.parse(seenBody) as { model: string; max_tokens: number; stream: boolean }
  assert.equal(body.model, 'deepseek-flash')
  assert.equal(body.max_tokens, 1)
  assert.equal(body.stream, false)
})
