import assert from 'node:assert/strict'
import test from 'node:test'
import { statusOfCode, toApiError } from '../src/errors.ts'

test('下游错误码 → HTTP 状态：管理/凭据/设置/账号的常见分支', () => {
  assert.equal(statusOfCode('USER_LAST_ADMIN'), 409)
  assert.equal(statusOfCode('USER_NAME_TAKEN'), 409)
  assert.equal(statusOfCode('USER_NOT_FOUND'), 404)
  assert.equal(statusOfCode('USER_ACTOR_FORBIDDEN'), 403)
  assert.equal(statusOfCode('API_KEY_LIMIT_REACHED'), 409)
  assert.equal(statusOfCode('API_KEY_NAME_TAKEN'), 409)
  assert.equal(statusOfCode('API_KEY_NOT_FOUND'), 404)
  assert.equal(statusOfCode('AUTH_CODE_INVALID'), 400)
  assert.equal(statusOfCode('AUTH_SESSION_EXPIRED'), 401)
  assert.equal(statusOfCode('AUTH_USER_BANNED'), 403)
  assert.equal(statusOfCode('SETTINGS_NS_UNKNOWN'), 404)
  assert.equal(statusOfCode('SETTINGS_FIELD_NOT_WRITABLE'), 403)
  assert.equal(statusOfCode('ACCOUNT_ADMIN_IMPORT_CONFLICT'), 409)
  assert.equal(statusOfCode('ACCOUNT_ADMIN_IMPORT_TOO_LARGE'), 413)
  assert.equal(statusOfCode('IDENTITY_NOT_READY'), 503)
  assert.equal(statusOfCode('IDENTITY_ACCOUNT_NOT_FOUND'), 404)
  assert.equal(statusOfCode('FRONTEND_ASSET_VERSION_EXISTS'), 409)
  assert.equal(statusOfCode('SOMETHING_UNEXPECTED'), 500)
})

test('toApiError：保留下游 code，不把未知错误伪装成 400', () => {
  const mapped = toApiError(Object.assign(new Error('不能封禁最后一个可用管理员'), { code: 'USER_LAST_ADMIN' }))
  assert.equal(mapped.code, 'USER_LAST_ADMIN')
  assert.equal(mapped.status, 409)
  assert.match(mapped.message, /最后一个可用管理员/)

  const unknown = toApiError(new Error('boom'))
  assert.equal(unknown.code, 'API_INTERNAL')
  assert.equal(unknown.status, 500)
  assert.equal(unknown.message, '内部错误')
})
