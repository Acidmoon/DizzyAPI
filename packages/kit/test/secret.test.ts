/**
 * 共用底座里的秘密工具：生成 / 哈希 / 掩码 / 常量时间比较。
 *
 * 这些函数给 API key 与兑换码这类「一次性明文 + 只落哈希」的实体复用；
 * 断言只覆盖形状与行为，不涉及任何具体插件的存储。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { constantTimeHexEqual, generateSecret, hashSecret, maskSecret } from '../src/index.ts'

test('secret：生成 32 字节 base64url，每次不同', () => {
  const value = generateSecret()
  assert.equal(value.length, 43)
  assert.match(value, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(value, generateSecret())
  assert.throws(() => generateSecret(8))
  assert.throws(() => generateSecret(1.5))
})

test('secret：sha256 hex 稳定，常量时间比较对长度与内容都严格', () => {
  const digest = hashSecret('ABCD')
  assert.match(digest, /^[0-9a-f]{64}$/)
  assert.equal(digest, hashSecret('ABCD'))
  assert.notEqual(digest, hashSecret('ABCE'))
  assert.ok(constantTimeHexEqual(digest, hashSecret('ABCD')))
  assert.ok(!constantTimeHexEqual(digest, hashSecret('ABCE')))
  assert.ok(!constantTimeHexEqual(digest, 'not-a-hash'))
  assert.ok(!constantTimeHexEqual('', ''))
})

test('secret：掩码只保留末 visible 位', () => {
  assert.equal(maskSecret('ABCDEFGH'), '****EFGH')
  assert.equal(maskSecret('AB'), '****AB')
  assert.equal(maskSecret(''), '****')
  assert.equal(maskSecret('ABCDEFGH', 2), '****GH')
  assert.equal(maskSecret('ABCDEFGH', 0), '****')
})
