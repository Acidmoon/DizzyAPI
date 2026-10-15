import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomCode, hashPassword, verifyPassword, consumeDummyVerify, constantTimeEqualHex } from '../src/crypto.ts'

test('scrypt：正确密码通过，错误密码与篡改过的哈希都不通过', async () => {
  const hash = await hashPassword('correct horse battery')
  assert.match(hash, /^scrypt\$16384\$8\$1\$/)
  assert.equal(await verifyPassword(hash, 'correct horse battery'), true)
  assert.equal(await verifyPassword(hash, 'correct horse batterz'), false)
  assert.equal(await verifyPassword(hash, ''), false)

  const parts = hash.split('$')
  const tampered = [...parts.slice(0, 5), Buffer.from('nope').toString('base64')].join('$')
  assert.equal(await verifyPassword(tampered, 'correct horse battery'), false)

  assert.equal(await verifyPassword('not-a-hash', 'correct horse battery'), false)
  assert.equal(await verifyPassword('scrypt$x$8$1$aa$bb', 'correct horse battery'), false)
})

test('每次哈希的盐不同：同一密码得到不同哈希', async () => {
  const first = await hashPassword('same password twice')
  const second = await hashPassword('same password twice')
  assert.notEqual(first, second)
  assert.equal(await verifyPassword(first, 'same password twice'), true)
  assert.equal(await verifyPassword(second, 'same password twice'), true)
})

test('dummy verify：邮箱不存在时也走一次等价运算，不抛错', async () => {
  await consumeDummyVerify('whatever')
  await consumeDummyVerify('whatever')
})

test('randomCode：位数固定且全是数字', () => {
  for (const digits of [4, 6, 8]) {
    const code = randomCode(digits)
    assert.equal(code.length, digits)
    assert.match(code, /^\d+$/)
  }
})

test('constantTimeEqualHex：相同为真，长度或内容不同为假', () => {
  assert.equal(constantTimeEqualHex('aabb', 'aabb'), true)
  assert.equal(constantTimeEqualHex('aabb', 'aabc'), false)
  assert.equal(constantTimeEqualHex('aabb', 'aa'), false)
})
