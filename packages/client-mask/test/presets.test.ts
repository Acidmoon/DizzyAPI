/**
 * 内置预置的护栏。
 *
 * 钉的是**形状**，不是具体 UA 串：上游要求的指纹头会变（新版本客户端加头改头），
 * 把某个版本号钉进断言等于让「现实一变测试就红」。这里只钉四件不会变的事：
 * 1. 每条预置的头名 / 头值 / UA 都过校验（否则装进档案库就是坏数据）；
 * 2. 预置之间 id 唯一、顺序稳定；
 * 3. `opencode` 那档必须用 `{{session}}`（owner 撞到的 400 要的是会话亲和，不是随机值）；
 * 4. `presetProfiles()` 每次返回深拷贝（管理页改了不该污染下一次读）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  PRESET_IDS,
  isPresetId,
  presetProfile,
  presetProfiles,
  validateHeaderName,
  validateHeaderValue,
  validateProfileId,
  validateUserAgent,
} from '../src/index.ts'

describe('内置预置', () => {
  const profiles = presetProfiles()

  it('id 唯一且与 PRESET_IDS 一一对应', () => {
    assert.deepEqual(profiles.map((profile) => profile.id), [...PRESET_IDS])
    assert.equal(new Set(profiles.map((profile) => profile.id)).size, PRESET_IDS.length)
    for (const id of PRESET_IDS) {
      assert.equal(isPresetId(id), true)
      assert.equal(validateProfileId(id), null, `${id} 不是合法 id`)
    }
    assert.equal(isPresetId('not-a-preset'), false)
  })

  it('每条预置的头与 UA 都过校验（含受保护头检查）', () => {
    for (const profile of profiles) {
      assert.equal(profile.builtin, true, `${profile.id} 必须标成内置`)
      assert.ok(profile.label.trim() !== '', `${profile.id} 没有展示名`)
      if (profile.userAgent !== null) {
        assert.equal(validateUserAgent(profile.userAgent), null, `${profile.id} 的 UA 不合法`)
      }
      const seen = new Set<string>()
      for (const header of profile.headers) {
        assert.equal(validateHeaderName(header.name), null, `${profile.id} 的头名不合法：${header.name}`)
        assert.equal(validateHeaderValue(header.value), null, `${profile.id} 的头值不合法：${header.value}`)
        const lower = header.name.toLowerCase()
        assert.equal(seen.has(lower), false, `${profile.id} 里 ${header.name} 重复`)
        seen.add(lower)
      }
      assert.ok(profile.headers.length <= 24)
    }
  })

  it('opencode 档用稳定会话（{{session}}），不是随机值', () => {
    const opencode = profiles.find((profile) => profile.id === 'opencode')
    assert.ok(opencode !== undefined)
    const session = opencode.headers.find((header) => header.name === 'x-opencode-session')
    assert.ok(session !== undefined, 'opencode 必须带 x-opencode-session（owner 撞到的 400 就是缺它）')
    assert.equal(session.value, '{{session}}', '要用会话亲和，不能用 {{uuid}}（每次不同就失去意义）')
  })

  it('none 档什么都不加（与「没挂档案」等价）', () => {
    const none = profiles.find((profile) => profile.id === 'none')
    assert.ok(none !== undefined)
    assert.equal(none.userAgent, null)
    assert.deepEqual(none.headers, [])
    assert.equal(none.enabled, true)
  })

  it('presetProfile 取单个；未知 id 返回 undefined', () => {
    assert.equal(presetProfile('codex')?.id, 'codex')
    assert.equal(presetProfile('nope'), undefined)
  })

  it('每次返回深拷贝：改返回值不影响下一次读', () => {
    const first = presetProfiles()
    const opencode = first.find((profile) => profile.id === 'opencode')
    assert.ok(opencode !== undefined)
    ;(opencode.headers as { name: string; value: string }[])[0].name = 'tampered'

    const second = presetProfiles()
    const again = second.find((profile) => profile.id === 'opencode')
    assert.ok(again !== undefined)
    assert.equal(again.headers[0]?.name, 'x-opencode-session', '预置被调用方改坏了')
  })
})
