/**
 * 测试基建自身的用例：屏蔽端口判定与「命中就重来」的收敛。
 *
 * 这条用例不碰网络：`listenFetchable` 的 `mount` 是假的，只验证判定与重试语义。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFetchBlockedPort, listenFetchable, type StartedListener } from './helpers/fetch-port.ts'

test('屏蔽端口判定：与 fetch 规范一致', () => {
  // 常见会撞上的：6665–6669、6697、10080，以及 0 与低位端口。
  for (const port of [0, 1, 53, 6665, 6666, 6669, 6697, 10080]) {
    assert.equal(isFetchBlockedPort(port), true, `${port} 应当被判为屏蔽端口`)
  }
  // 本项目的真实端口与高位随机端口必须放行。
  for (const port of [7791, 7792, 18080, 49152, 51234, 65535]) {
    assert.equal(isFetchBlockedPort(port), false, `${port} 不该被判为屏蔽端口`)
  }
})

test('命中屏蔽端口就关掉重来，返回可 fetch 的那一次', async () => {
  const closed: number[] = []
  let call = 0
  const started = await listenFetchable(async () => {
    call += 1
    // 前两次故意给屏蔽端口，第三次给正常端口。
    const port = call === 1 ? 6666 : call === 2 ? 10080 : 51234
    const listener: StartedListener<{ call: number }> = {
      app: { call },
      port,
      close: async () => {
        closed.push(port)
      },
    }
    return listener
  })

  assert.equal(started.port, 51234)
  assert.equal(started.base, 'http://127.0.0.1:51234')
  assert.equal(started.app.call, 3)
  // 被放弃的两次必须关掉，否则会泄漏监听。
  assert.deepEqual(closed, [6666, 10080])
})

test('连续命中到上限时明确失败，不无限重试', async () => {
  let closed = 0
  await assert.rejects(
    () =>
      listenFetchable(
        async () => ({
          app: undefined,
          port: 6697,
          close: async () => {
            closed += 1
          },
        }),
        3,
      ),
    /bad port/,
  )
  assert.equal(closed, 3)
})
