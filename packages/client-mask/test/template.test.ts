/**
 * 占位符与头值校验的护栏。
 *
 * 这里是**安全面**，所以要逐条钉死：
 * 1. 头值里一个换行就是 HTTP 头注入（`\r\n` 能凭空造出一个头）；
 * 2. 受保护头（鉴权 / 内容协商 / Host / UA）不许被档案覆盖；
 * 3. 值里只允许三个占位符 —— 放开任意 `{{...}}` 等于给「从上下文取令牌」开了个口子；
 * 4. 值看着像秘密就拒（防手滑把 `sk-…` 粘进档案，那会进 JSON、进桥帧、进管理页）。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ALLOWED_PLACEHOLDERS,
  PROTECTED_HEADERS,
  placeholdersIn,
  validateHeaderName,
  validateHeaderValue,
  validateProfileId,
  validateUserAgent,
} from '../src/index.ts'

describe('头名', () => {
  it('合法 token 通过（含常见自定义头）', () => {
    for (const name of ['x-opencode-session', 'originator', 'session_id', 'X-App', 'anthropic-version']) {
      assert.equal(validateHeaderName(name), null, `${name} 应该合法`)
    }
  })

  it('受保护头一律拒绝（大小写不敏感）', () => {
    for (const name of ['Authorization', 'authorization', 'X-API-Key', 'X-Goog-Api-Key', 'Host', 'Accept', 'Content-Type', 'User-Agent', 'Cookie']) {
      const error = validateHeaderName(name)
      assert.ok(error !== null, `${name} 必须被拒`)
      assert.match(error, /受保护名单/)
    }
    // 名单必须与 Go 侧 `contracts.ProtectedRequestHeaders()` 同源（两处各一份，靠这条钉住）。
    for (const name of ['authorization', 'x-api-key', 'x-goog-api-key', 'host', 'accept', 'content-type', 'user-agent']) {
      assert.ok(PROTECTED_HEADERS.includes(name), `名单缺 ${name}`)
    }
  })

  it('非法字符 / 空 / 超长拒绝', () => {
    assert.ok(validateHeaderName('') !== null)
    assert.ok(validateHeaderName('   ') !== null)
    assert.ok(validateHeaderName('x bad') !== null)
    // **内嵌**换行必须拒绝（头注入）；两端的空白会被 trim 掉，粘贴友好且安全。
    assert.ok(validateHeaderName('x-a\r\nX-Evil: 1') !== null)
    assert.ok(validateHeaderName('x-a\tb') !== null, '制表符不是合法 token 字符')
    assert.equal(validateHeaderName('  x-a  '), null, '两端空白 trim 后合法')
    assert.ok(validateHeaderName(`x-${'a'.repeat(200)}`) !== null)
  })
})

describe('头值', () => {
  it('普通常量与三个占位符都通过', () => {
    assert.equal(validateHeaderValue('cli'), null)
    assert.equal(validateHeaderValue('{}'), null)
    for (const placeholder of ALLOWED_PLACEHOLDERS) {
      assert.equal(validateHeaderValue(placeholder), null, `${placeholder} 应该合法`)
      assert.equal(validateHeaderValue(`prefix-${placeholder}-suffix`), null)
    }
  })

  it('CRLF / NUL 一律拒绝（头注入）', () => {
    for (const value of ['a\r\nX-Evil: 1', 'a\nb', 'a\rb', 'a\u0000b', 'a\u001fb']) {
      const error = validateHeaderValue(value)
      assert.ok(error !== null, `${JSON.stringify(value)} 必须被拒`)
      assert.match(error, /控制字符/)
    }
  })

  it('不认识的占位符拒绝（不给模板开口子）', () => {
    for (const value of ['{{token}}', '{{uuid}}{{secret}}', '{{ session }}', '{{session']) {
      assert.ok(validateHeaderValue(value) !== null, `${value} 必须被拒`)
    }
  })

  it('像秘密的值拒绝（防手滑）', () => {
    // 每一行命中 template.ts 里的一条 SECRET_LIKE 规则（sk- / Bearer / ghp_ / github_pat_ / AKIA / xoxb- / AIza）。
    // 值在运行期拼出来，文件里不留任何像密钥的字面量（免得有人把它当成真东西）。
    const samples = [
      `sk-${'a'.repeat(16)}`,
      `Bearer ${'b'.repeat(16)}`,
      `ghp_${'c'.repeat(20)}`,
      `github_pat_${'D'.repeat(20)}`,
      `AKIA${'E'.repeat(16)}`,
      `xoxb-${'1'.repeat(12)}`,
      `AIza${'F'.repeat(30)}`,
    ]
    for (const value of samples) {
      const error = validateHeaderValue(value)
      assert.ok(error !== null, `${value} 必须被拒`)
      assert.match(error, /秘密值/)
    }
  })

  it('超长拒绝', () => {
    assert.ok(validateHeaderValue('a'.repeat(600)) !== null)
  })
})

describe('UA 与档案 id', () => {
  it('UA 用同一套规则（控件字符 / 秘密）', () => {
    assert.equal(validateUserAgent('opencode/0.4.2 (cli; linux x64)'), null)
    assert.ok(validateUserAgent('a\r\nb') !== null)
    assert.ok(validateUserAgent(`Bearer ${'b'.repeat(16)}`) !== null)
  })

  it('档案 id 只允许小写字母数字连字符下划线', () => {
    assert.equal(validateProfileId('opencode'), null)
    assert.equal(validateProfileId('my-profile_2'), null)
    assert.ok(validateProfileId('') !== null)
    assert.ok(validateProfileId('OpenCode') !== null)
    assert.ok(validateProfileId('-leading') !== null)
    assert.ok(validateProfileId('a b') !== null)
    assert.ok(validateProfileId('a'.repeat(80)) !== null)
  })

  it('placeholdersIn 只报认识的三个', () => {
    assert.deepEqual(placeholdersIn('{{session}}-{{uuid}}'), ['{{uuid}}', '{{session}}'])
    assert.deepEqual(placeholdersIn('plain'), [])
  })
})
