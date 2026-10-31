/**
 * 「建探测 key」那把**单飞锁**的护栏。
 *
 * 为什么要单独测它：这把锁防的是 2026-10-31 生产事故的第二半 —— `ensureKey()` 的两个
 * 调用点（`[Service.init]` 与每轮探测的自愈补建）可能并发，而 `ensureProbeKey` 是
 * 「先 list 再 create」，并发下两边都会看到「没有」，于是建出**两把**同名
 * `__probe__dizzy`，`credentials` 只留得下最后一把明文，另一把成了永远用不上的垃圾。
 *
 * 服务层只能观察到「只建了一把」这个结果，看不到锁本身的语义（`runPass` 自己有单飞，
 * 两条路径很难真撞上），所以锁的语义在这里逐条钉：共享、释放、失败也释放。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createSingleFlight } from '../src/single-flight.ts'

/** 一个可以手动放行的 Promise，用来把并发窗口撑开。 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {}
  const promise = new Promise<void>((resolve) => {
    release = () => {
      resolve()
    }
  })
  return { promise, release }
}

describe('createSingleFlight', () => {
  it('并发调用共享同一个任务，只跑一次', async () => {
    const flight = createSingleFlight()
    const gate = deferred()
    let calls = 0
    const task = async (): Promise<string> => {
      calls += 1
      await gate.promise
      return 'done'
    }

    const first = flight.run(task)
    const second = flight.run(task)
    const third = flight.run(task)
    assert.equal(flight.running, true)
    gate.release()

    assert.deepEqual(await Promise.all([first, second, third]), ['done', 'done', 'done'])
    assert.equal(calls, 1, '三个并发调用者只能跑一次任务')
    assert.equal(flight.running, false, '跑完要释放')
  })

  it('成功之后能再跑（自愈的前提：一次成功不把能力锁死）', async () => {
    const flight = createSingleFlight()
    let calls = 0
    const task = async (): Promise<number> => {
      calls += 1
      return calls
    }

    assert.equal(await flight.run(task), 1)
    assert.equal(await flight.run(task), 2)
    assert.equal(calls, 2)
  })

  it('失败之后也释放：下一轮还能重试', async () => {
    const flight = createSingleFlight()
    const gate = deferred()
    let attempts = 0
    const failing = async (): Promise<string> => {
      attempts += 1
      await gate.promise
      throw new Error('apiKey 服务不可用')
    }

    const first = flight.run(failing)
    gate.release()
    await assert.rejects(() => first, /apiKey 服务不可用/)
    assert.equal(flight.running, false, '失败必须释放，否则补建能力被永久锁死')

    // 第二次成功：证明锁没有把失败「粘」在身上。
    assert.equal(await flight.run(async () => 'recovered'), 'recovered')
    assert.equal(attempts, 1)
  })

  it('任务同步抛错时不把锁挂在半途（后续调用照常）', async () => {
    const flight = createSingleFlight()
    assert.throws(() => flight.run((): Promise<void> => {
      throw new Error('boom')
    }), /boom/)
    assert.equal(flight.running, false)
    assert.equal(await flight.run(async () => 'ok'), 'ok')
  })
})
