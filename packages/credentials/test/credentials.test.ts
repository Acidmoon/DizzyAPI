import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, ValidationError } from 'cordis'
import { CredentialsError, isCredentialsError } from '../src/errors.ts'
import { CredentialsService } from '../src/service.ts'
import { isRef, normalizeRef } from '../src/ref.ts'

async function boot(config: { dataPath?: string } = {}): Promise<CredentialsService> {
  const ctx = new Context()
  await ctx.plugin(CredentialsService, config)
  return ctx.get('credentials') as CredentialsService
}

test('写入后能取到值，describe 只说「配没配」', async () => {
  const credentials = await boot()
  assert.deepEqual(credentials.describe('dizzyapi/smtp-163'), { configured: false })

  await credentials.set('dizzyapi/smtp-163', 'authorization-code')
  assert.equal(credentials.resolve('dizzyapi/smtp-163'), 'authorization-code')

  const description = credentials.describe('dizzyapi/smtp-163')
  assert.equal(description.configured, true)
  assert.ok(typeof description.createdAt === 'string')
})

test('秘密读不回来：describe / list 的结构里就没有值', async () => {
  const credentials = await boot()
  await credentials.set('dizzyapi/smtp-163', 'TOP-SECRET-CODE')

  const description = credentials.describe('dizzyapi/smtp-163')
  assert.deepEqual(Object.keys(description).sort(), ['configured', 'createdAt', 'updatedAt'])
  assert.ok(!JSON.stringify(description).includes('TOP-SECRET-CODE'))
  assert.deepEqual(credentials.list(), ['dizzyapi/smtp-163'])
  assert.ok(!JSON.stringify(credentials.list()).includes('TOP-SECRET-CODE'))
})

test('覆盖写入保留 createdAt，只推进 updatedAt', async () => {
  const credentials = await boot()
  await credentials.set('dizzyapi/smtp', 'v1')
  const first = credentials.describe('dizzyapi/smtp')

  await credentials.set('dizzyapi/smtp', 'v2')
  const second = credentials.describe('dizzyapi/smtp')

  assert.equal(second.createdAt, first.createdAt)
  assert.equal(credentials.resolve('dizzyapi/smtp'), 'v2')
})

test('unset 之后取不到，且重复 unset 也算成功', async () => {
  const credentials = await boot()
  await credentials.set('dizzyapi/smtp', 'v1')

  await credentials.unset('dizzyapi/smtp')
  assert.equal(credentials.resolve('dizzyapi/smtp'), undefined)
  assert.equal(credentials.describe('dizzyapi/smtp').configured, false)

  await credentials.unset('dizzyapi/smtp')
  assert.deepEqual(credentials.list(), [])
})

test('引用名不合法：写路径拒绝', async () => {
  const credentials = await boot()
  for (const ref of ['', '  ', 'DizzyAPI/SMTP', 'a b', '../etc/passwd', 'a//b', '/lead', 'trail/']) {
    await assert.rejects(
      credentials.set(ref, 'v'),
      (error: unknown) => {
        assert.ok(isCredentialsError(error))
        assert.equal(error.code, 'CREDENTIALS_REF_INVALID')
        return true
      },
      `${ref} 应当被拒绝`,
    )
  }
})

test('引用名的形状：合法的认，非法的拒', () => {
  for (const ref of ['a', 'dizzyapi/smtp-163', 'a.b_c-d/e2']) assert.equal(isRef(ref), true, ref)
  for (const ref of ['A', 'a b', '-a', 'a/', '']) assert.equal(isRef(ref), false, ref)
  assert.equal(normalizeRef('dizzyapi/smtp-163'), 'dizzyapi/smtp-163')
})

test('值不合法：空、NUL、超长都拒绝', async () => {
  const credentials = await boot()
  for (const value of ['', 'a\u0000b', 'x'.repeat(4097)]) {
    await assert.rejects(
      credentials.set('dizzyapi/smtp', value),
      (error: unknown) => {
        assert.ok(isCredentialsError(error))
        assert.equal(error.code, 'CREDENTIALS_VALUE_INVALID')
        return true
      },
    )
  }
})

test('读路径对垃圾引用名不抛，只回「没有」', async () => {
  const credentials = await boot()
  assert.equal(credentials.resolve('NOT A REF'), undefined)
  assert.deepEqual(credentials.describe('NOT A REF'), { configured: false })
})

test('落盘后重启仍在（真的换了进程里的实例）', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dizzyapi-credentials-')), 'credentials.json')
  const first = await boot({ dataPath: path })
  await first.set('dizzyapi/smtp-163', 'persisted')

  const second = await boot({ dataPath: path })
  assert.equal(second.resolve('dizzyapi/smtp-163'), 'persisted')
})

test('文件损坏时插件装载即失败，不会带着空表跑起来', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'dizzyapi-credentials-')), 'credentials.json')
  await writeFile(path, 'not json at all', 'utf8')

  const ctx = new Context()
  await assert.rejects(
    async () => {
      await ctx.plugin(CredentialsService, { dataPath: path })
    },
    (error: unknown) => {
      assert.ok(isCredentialsError(error))
      assert.equal(error.code, 'CREDENTIALS_STORE_CORRUPT')
      return true
    },
  )
})

test('配置 schema：未知字段拒绝，dataPath 默认为空（内存）', async () => {
  const ctx = new Context()
  await assert.rejects(async () => {
    await ctx.plugin(CredentialsService, { nope: true } as never)
  }, ValidationError)

  const credentials = await boot()
  assert.equal(credentials.config.dataPath, undefined)
})

test('改动会发出 credentials/reference-updated 事件', async () => {
  const ctx = new Context()
  const seen: string[] = []
  ctx.on('credentials/reference-updated', (ref: string) => seen.push(ref))
  await ctx.plugin(CredentialsService, {})
  const credentials = ctx.get('credentials') as CredentialsService

  await credentials.set('dizzyapi/smtp', 'v')
  await credentials.unset('dizzyapi/smtp')
  await credentials.unset('dizzyapi/smtp') // 没删到东西，不该再发一次

  assert.deepEqual(seen, ['dizzyapi/smtp', 'dizzyapi/smtp'])
})

test('错误对象是 CredentialsError，带稳定 code', async () => {
  const credentials = await boot()
  await assert.rejects(credentials.set('BAD', 'v'), (error: unknown) => {
    assert.ok(error instanceof CredentialsError)
    assert.equal(error.name, 'CredentialsError')
    return true
  })
})
