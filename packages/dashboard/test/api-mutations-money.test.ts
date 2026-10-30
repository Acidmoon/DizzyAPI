/**
 * 写操作语义与金额格式化的护栏。
 *
 * 这两块是「owner 说点了没反应 / 数字看着不对」的直接来源，所以各钉一遍：
 * - **写操作**：同一 key 串行（连点两下不会发两条互相覆盖的请求）、失败按策略回滚 / 重拉、
 *   失败不吞错、客户端层不弹 UI（弹提示是应用层的事）。
 * - **金额**：全程字符串 / BigInt，**一步浮点都不许走**，否则微元级的大数会丢精度。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ApiError } from '../app/src/lib/api/client.ts'
import {
  formatCentsYuan,
  formatCount,
  formatMicrosYuan,
  formatMicrosYuanFixed,
  yuanToMicros,
} from '../app/src/lib/api/money.ts'
import { authErrorMessage, enqueue, errorMessage, mutate } from '../app/src/lib/api/mutations.ts'

// ───────────────────────────── 串行化 ─────────────────────────────

test('同一个 key 的写操作串行执行（后一个等前一个）', async () => {
  const order: string[] = []
  const slow = async (): Promise<void> => {
    order.push('a-start')
    await new Promise((resolve) => setTimeout(resolve, 15))
    order.push('a-end')
  }
  const fast = async (): Promise<void> => {
    order.push('b-start')
    order.push('b-end')
  }
  await Promise.all([enqueue('user:7', slow), enqueue('user:7', fast)])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})

test('不同 key 不互相阻塞', async () => {
  const order: string[] = []
  const slow = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 15))
    order.push('slow')
  }
  const fast = async (): Promise<void> => {
    order.push('fast')
  }
  await Promise.all([enqueue('a', slow), enqueue('b', fast)])
  assert.deepEqual(order, ['fast', 'slow'])
})

test('前一个失败不毒化队列：后面同一 key 照样能跑', async () => {
  const failures = Promise.resolve(
    enqueue('k', () => Promise.reject(new Error('boom'))).catch(() => undefined),
  )
  await failures
  assert.equal(await enqueue('k', () => Promise.resolve(42)), 42)
})

// ───────────────────────────── 策略 ─────────────────────────────

test('rollback：失败先回滚再抛错，原始错误不丢', async () => {
  const events: string[] = []
  await assert.rejects(
    () =>
      mutate({
        key: 'k',
        strategy: 'rollback',
        before: () => {
          events.push('before')
        },
        run: () => Promise.reject(new ApiError({ code: 'X', message: '写失败', status: 500 })),
        rollback: () => {
          events.push('rollback')
        },
        onError: (error) => {
          events.push(`onError:${error.code}`)
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'X')
      return true
    },
  )
  assert.deepEqual(events, ['before', 'rollback', 'onError:X'])
})

test('refetch：失败后重新拉一次（服务端算出来的数据用这个）', async () => {
  const events: string[] = []
  await assert.rejects(() =>
    mutate({
      key: 'k',
      strategy: 'refetch',
      run: () => Promise.reject(new Error('boom')),
      refetch: () => {
        events.push('refetch')
        return Promise.resolve()
      },
    }),
  )
  assert.deepEqual(events, ['refetch'])
})

test('manual：不自动回滚也不重拉，只把错误交给回调', async () => {
  const events: string[] = []
  await assert.rejects(() =>
    mutate({
      key: 'k',
      strategy: 'manual',
      run: () => Promise.reject(new Error('boom')),
      rollback: () => {
        events.push('rollback')
      },
      refetch: () => {
        events.push('refetch')
        return Promise.resolve()
      },
      onError: () => {
        events.push('onError')
      },
    }),
  )
  assert.deepEqual(events, ['onError'])
})

test('非 ApiError 的异常也归一成 ApiError（code = API_UNKNOWN_ERROR）', async () => {
  await assert.rejects(
    () =>
      mutate({
        key: 'k',
        strategy: 'manual',
        run: () => Promise.reject(new Error('原生错误')),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'API_UNKNOWN_ERROR')
      assert.equal(error.message, '原生错误')
      return true
    },
  )
})

test('成功时返回结果并调用 onSuccess', async () => {
  let seen = 0
  const result = await mutate({
    key: 'k',
    strategy: 'manual',
    run: () => Promise.resolve('ok'),
    onSuccess: () => {
      seen += 1
    },
  })
  assert.equal(result, 'ok')
  assert.equal(seen, 1)
})

test('提示文案：优先用服务端的人话，401 / 403 / 503 各有专门文案', () => {
  assert.equal(errorMessage(new ApiError({ code: 'E', message: '服务端说的', status: 400 })), '服务端说的')
  assert.equal(errorMessage('随便什么'), '操作失败，请稍后再试')
  assert.equal(authErrorMessage(new ApiError({ code: 'E', message: 'x', status: 401 })), '登录已失效，请重新登录')
  assert.equal(authErrorMessage(new ApiError({ code: 'E', message: 'x', status: 403 })), '当前账号没有这个操作权限')
  assert.equal(authErrorMessage(new ApiError({ code: 'E', message: 'x', status: 503 })), '相关服务暂时不可用，请稍后再试')
})

// ───────────────────────────── 金额 ─────────────────────────────

test('微元 → 元：字符串除法，不经浮点', () => {
  assert.equal(formatMicrosYuan('1137940000'), '1137.94')
  assert.equal(formatMicrosYuan('1000000'), '1')
  assert.equal(formatMicrosYuan('0'), '0')
  assert.equal(formatMicrosYuan('5'), '0.000005')
  assert.equal(formatMicrosYuan('-161'), '-0.000161')
})

test('微元 → 固定两位展示（小数截断，不四舍五入）', () => {
  assert.equal(formatMicrosYuanFixed('1137940000'), '¥1,137.94')
  assert.equal(formatMicrosYuanFixed('1000000'), '¥1.00')
  // 不足一分钱的显示成 0.00：`formatMicrosYuanFixed` 是给人看的固定两位，
  // 要看完整精度用 `formatMicrosYuan`（下面那条）。
  assert.equal(formatMicrosYuanFixed('-161'), '-¥0.00')
  assert.equal(formatMicrosYuan('-161'), '-0.000161')
})

test('超过 2^53 的微元也不丢精度（这条是浮点实现必挂的地方）', () => {
  // 9007199254740993 = 2^53 + 1，Number 表示不了它。
  assert.equal(formatMicrosYuan('9007199254740993'), '9007199254.740993')
  assert.equal(formatMicrosYuanFixed('9007199254740993'), '¥9,007,199,254.74')
})

test('分 → 元（分本来就是整数，可以直接格式化）', () => {
  assert.equal(formatCentsYuan(113794), '¥1,137.94')
  assert.equal(formatCentsYuan(-5), '-¥0.05')
  assert.equal(formatCentsYuan(0), '¥0.00')
})

test('元 → 微元：字符串拆分，最多 6 位小数', () => {
  assert.equal(yuanToMicros('1137.94'), '1137940000')
  assert.equal(yuanToMicros('1'), '1000000')
  assert.equal(yuanToMicros('0.000001'), '1')
  assert.equal(yuanToMicros(' 12.5 '), '12500000')
  assert.throws(() => yuanToMicros('1.1234567'), /金额格式不对/)
  assert.throws(() => yuanToMicros('abc'), /金额格式不对/)
})

test('数字列千分位；非整数先截断', () => {
  assert.equal(formatCount(1234567), '1,234,567')
  assert.equal(formatCount(0), '0')
})
