import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CredentialsError } from '../src/errors.ts'
import { createCredentialsStore } from '../src/store.ts'

async function tempFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'dizzyapi-credentials-')), 'credentials.json')
}

test('JSON 存储：写入后能读回来，秘密值不丢字符', async () => {
  const path = await tempFile()
  const store = createCredentialsStore(path)

  assert.deepEqual(await store.read(), { entries: {} })

  await store.write({ entries: { 'dizzyapi/smtp-163': { value: 'a+b/c=d', createdAt: 't1', updatedAt: 't2' } } })
  const snapshot = await store.read()
  assert.equal(snapshot.entries['dizzyapi/smtp-163']?.value, 'a+b/c=d')
})

test('JSON 存储：文件不存在时按空表启动', async () => {
  const store = createCredentialsStore(await tempFile())
  assert.deepEqual(await store.read(), { entries: {} })
})

test('JSON 存储：文件损坏时报错，不重建成空表', async () => {
  const path = await tempFile()
  await writeFile(path, '{ 这不是 JSON', 'utf8')

  const store = createCredentialsStore(path)
  await assert.rejects(
    store.read(),
    (error: unknown) => {
      assert.ok(error instanceof CredentialsError)
      assert.equal(error.code, 'CREDENTIALS_STORE_CORRUPT')
      return true
    },
  )
})

test('严格解码：版本不认识 / 形状不对 / 引用名非法都拒绝', async () => {
  const cases: readonly unknown[] = [
    { version: 2, entries: {} },
    { version: 1, entries: [] },
    { version: 1, entries: { 'DizzyAPI/SMTP': { value: 'x', createdAt: 'a', updatedAt: 'b' } } },
    { version: 1, entries: { 'dizzyapi/smtp': { value: '', createdAt: 'a', updatedAt: 'b' } } },
    { version: 1, entries: { 'dizzyapi/smtp': { value: 'x' } } },
  ]

  for (const body of cases) {
    const path = await tempFile()
    await writeFile(path, JSON.stringify(body), 'utf8')
    await assert.rejects(
      createCredentialsStore(path).read(),
      (error: unknown) => {
        assert.ok(error instanceof CredentialsError)
        assert.equal(error.code, 'CREDENTIALS_STORE_CORRUPT')
        return true
      },
      `${JSON.stringify(body)} 应当被拒绝`,
    )
  }
})

test('落盘的是明文 JSON，供人排障时看结构（值当然也在里面）', async () => {
  const path = await tempFile()
  const store = createCredentialsStore(path)
  await store.write({ entries: { 'dizzyapi/x': { value: 'secret', createdAt: 'a', updatedAt: 'b' } } })

  const text = await readFile(path, 'utf8')
  assert.match(text, /"version": 1/)
  assert.match(text, /"dizzyapi\/x"/)
})
