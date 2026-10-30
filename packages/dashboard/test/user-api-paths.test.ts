/**
 * `/api/*` 路径与查询串的逐字护栏。
 *
 * 这些字符串是**契约**：`api` 插件的路由分发按前缀与段数判定（`routeApi`），
 * 多一个空参数、少一个 `format=csv`、或者把 `range` 写成 `7`，都会变成 400 / 404。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as pathsModule from '../app/src/app/(main)/user/_lib/paths.ts'
import { unwrap } from './helpers/module-interop.ts'

const { LOGIN_PATH, keysPath, queryString, usageDetailPath, usageExportPath, usagePath } =
  unwrap<typeof pathsModule>(pathsModule)

describe('queryString', () => {
  it('丢掉 undefined / null / 空串（不让后端把 "" 当筛选）', () => {
    assert.equal(queryString({ a: undefined, b: null, c: '', d: 'x' }), '?d=x')
  })

  it('全空 → 空串（路径后面不挂裸问号）', () => {
    assert.equal(queryString({ a: undefined }), '')
  })

  it('数字按十进制写', () => {
    assert.equal(queryString({ cursor: 42, limit: 20 }), '?cursor=42&limit=20')
  })
})

describe('usagePath', () => {
  it('只有 range', () => {
    assert.equal(usagePath({ range: '7d' }), '/api/usage?range=7d')
  })

  it('带筛选与分页：参数顺序稳定，逐字可断言', () => {
    assert.equal(
      usagePath({ range: '30d', apiKeyId: 'key-1', model: 'deepseek-chat', cursor: 100, limit: 20 }),
      '/api/usage?range=30d&apiKeyId=key-1&model=deepseek-chat&cursor=100&limit=20',
    )
  })

  it('模型名带斜杠 / 空格会被编码（不能拼出多一段路径）', () => {
    const path = usagePath({ range: '7d', model: 'org/model name' })
    assert.ok(path.includes('model=org%2Fmodel+name'), path)
  })
})

describe('usageDetailPath', () => {
  it('reqId 里的 + 与 / 必须编码，否则会被路由当成两段', () => {
    assert.equal(usageDetailPath('a+b/c'), '/api/usage/a%2Bb%2Fc')
    assert.equal(usageDetailPath('req-1'), '/api/usage/req-1')
  })
})

describe('usageExportPath', () => {
  it('固定带 format=csv，且**不带**分页参数（导出是全量）', () => {
    assert.equal(usageExportPath({ range: '7d' }), '/api/usage/export?format=csv&range=7d')
    const path = usageExportPath({ range: '90d', apiKeyId: 'k', model: 'm' })
    assert.equal(path, '/api/usage/export?format=csv&range=90d&apiKeyId=k&model=m')
    assert.ok(!path.includes('cursor'))
    assert.ok(!path.includes('limit'))
  })
})

describe('keysPath', () => {
  it('列表 / 单条 / 轮换', () => {
    assert.equal(keysPath(), '/api/keys')
    assert.equal(keysPath('k1'), '/api/keys/k1')
    assert.equal(keysPath('k1', 'rotate'), '/api/keys/k1/rotate')
  })

  it('id 编码', () => {
    assert.equal(keysPath('a/b'), '/api/keys/a%2Fb')
  })
})

describe('路径纪律', () => {
  it('用户侧任何路径都不许落到 /api/admin 下', () => {
    const all = [
      usagePath({ range: '7d' }),
      usageDetailPath('x'),
      usageExportPath({ range: '7d' }),
      keysPath(),
      keysPath('k', 'rotate'),
      '/api/session',
      '/api/pricing',
    ]
    for (const path of all) assert.ok(!path.startsWith('/api/admin'), path)
  })

  it('未登录落点是静态导出的登录页（带尾斜杠，与 trailingSlash 一致）', () => {
    assert.equal(LOGIN_PATH, '/auth/v2/login/')
  })
})
