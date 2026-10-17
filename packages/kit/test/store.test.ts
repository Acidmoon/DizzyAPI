import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { jsonFileStore, type JsonCodec } from '../src/index.ts'

interface Demo {
  readonly value: string
}

const codec: JsonCodec<Demo> = {
  encode: (value) => value,
  decode: (raw) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('损坏')
    const value = (raw as { value?: unknown }).value
    if (typeof value !== 'string') throw new Error('损坏')
    return { value }
  },
}

async function tempPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'kit-store-')), 'demo.json')
}

test('文件不存在视为空，写完能读回来', async () => {
  const path = await tempPath()
  const store = jsonFileStore(path, codec, () => ({ value: '空' }))

  assert.deepEqual(await store.read(), { value: '空' })
  await store.write({ value: '写过了' })
  assert.deepEqual(await store.read(), { value: '写过了' })
})

test('写入是原子的：不留临时文件', async () => {
  const path = await tempPath()
  const store = jsonFileStore(path, codec, () => ({ value: '空' }))
  await store.write({ value: 'x' })

  const text = await readFile(path, 'utf8')
  assert.match(text, /"value": "x"/)
  await assert.rejects(async () => stat(`${path}.tmp`), /ENOENT/)
})

test('mode 会落到底层文件上（Windows 忽略权限位，跳过）', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 不支持 POSIX 权限位')
    return
  }
  const path = await tempPath()
  const store = jsonFileStore(path, codec, () => ({ value: '空' }), { mode: 0o600 })
  await store.write({ value: '秘密' })

  const info = await stat(path)
  assert.equal(info.mode & 0o777, 0o600)
})
