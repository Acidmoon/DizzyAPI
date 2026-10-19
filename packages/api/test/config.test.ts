import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isIssueList } from '@dizzyapi/plugin-kit'
import { API_DEFAULTS, API_CONFIG_SCHEMA, validateApiConfig } from '../src/config.ts'

test('配置默认值：端口 7791、body 1 MiB、cookie 名与只读开关', () => {
  const value = validateApiConfig(undefined)
  assert.ok(!isIssueList(value))
  if (isIssueList(value)) return
  assert.equal(value.port, API_DEFAULTS.port)
  assert.equal(value.port, 7791)
  assert.equal(value.bodyLimitBytes, 1024 * 1024)
  assert.equal(value.sessionCookieName, 'dizzyapi_session')
  assert.equal(value.trustProxy, false)
  assert.equal(value.enabled, true)
})

test('配置校验：端口 0 接受，-1 / 越界 / 未知键 / 坏 cookie 名拒绝', () => {
  const zero = validateApiConfig({ port: 0 })
  assert.ok(!isIssueList(zero))
  if (!isIssueList(zero)) assert.equal(zero.port, 0)

  assert.ok(isIssueList(validateApiConfig({ port: -1 })))
  assert.ok(isIssueList(validateApiConfig({ port: 65_536 })))
  assert.ok(isIssueList(validateApiConfig({ port: 1.5 })))
  assert.ok(isIssueList(validateApiConfig({ port: '7791' })))
  assert.ok(isIssueList(validateApiConfig({ unknown: true })))
  assert.ok(isIssueList(validateApiConfig({ sessionCookieName: 'bad name' })))
  assert.ok(isIssueList(validateApiConfig({ sessionCookieName: 'x'.repeat(65) })))
})

test('配置校验：body 上限范围 64 KiB..4 MiB', () => {
  assert.ok(isIssueList(validateApiConfig({ bodyLimitBytes: 64 * 1024 - 1 })))
  assert.ok(!isIssueList(validateApiConfig({ bodyLimitBytes: 64 * 1024 })))
  assert.ok(!isIssueList(validateApiConfig({ bodyLimitBytes: 4 * 1024 * 1024 })))
  assert.ok(isIssueList(validateApiConfig({ bodyLimitBytes: 4 * 1024 * 1024 + 1 })))
})

test('配置字段全部只读（避免运行期换端口 / cookie 名）', () => {
  const fields = API_CONFIG_SCHEMA.fields ?? []
  assert.ok(fields.length >= 5)
  assert.ok(fields.every((field) => field.writable !== true))
})
